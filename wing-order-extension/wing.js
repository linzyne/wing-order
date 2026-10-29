// 윙 화면 왼쪽 아래 작은 패널.
// 1차 보내기: 결제완료 → 발주확인 처리(상품준비중으로 모음) → 상품준비중 → 엑셀 다운 → 사유 입력 → 다운로드
// 2차~ 보내기: 결제완료 → 발주확인 처리 → 사유 입력 → 다운로드 (새 주문만)
// 받은 엑셀은 윙발주(Firestore wingInbox)로 보낸다. 둘 다 발주확인 처리를 하므로 윙 주문 상태가 바뀐다.
(() => {
  if (window.__wingOrderPanel) return;
  window.__wingOrderPanel = true;

  const MANAGE_URL = 'https://wing.coupang.com/tenants/sfl-portal/delivery/management';
  const AUTO_RUN = '__wingOrderAutoRun';
  const ARM = '__wingOrderArm';
  const DIALOG_ARM = '__wingOrderDialogArm';
  const HOOK_SRC = 'wing-order-hook';
  // 윙발주에서 온 받기 요청으로 확장이 연 탭이면 { mode } — 진행 상황과 결과를 확장에 알린다
  let job = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, '0');

  // ── 진단 로그 (실패하면 다운로드 폴더에 윙주문서로그_*.json 으로 저장) ──
  const log = [];
  const L = (text) => {
    const d = new Date();
    log.push(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${text}`);
  };
  const saveLog = () => chrome.runtime.sendMessage({ type: 'SAVE_LOG', log: log.slice(), page: location.href });

  // ── 패널 ──
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483647;width:104px;background:#fff;color:#3f3f46;border:1px solid #e4e4e7;border-radius:10px;padding:6px;font:11px/1.35 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.08);display:flex;flex-direction:column;gap:4px';
  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:4px">
      <span style="font-size:10px;font-weight:800;color:#e11d48;letter-spacing:-.2px">윙발주</span>
      <span data-k="log" title="진단 로그 받기" style="font-size:9px;color:#a1a1aa;cursor:pointer">로그</span>
    </div>
    <span data-k="bizLabel" title="눌러서 사업자명 바꾸기" style="display:none;font-size:10px;font-weight:700;color:#52525b;background:#f4f4f5;border-radius:5px;padding:2px 5px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
    <input data-k="biz" placeholder="사업자명" style="width:100%;box-sizing:border-box;background:#fafafa;color:#18181b;border:1px solid #e4e4e7;border-radius:5px;padding:3px 5px;font-size:10px;outline:none">
    <button data-k="first" title="결제완료를 발주확인으로 상품준비중에 모은 뒤, 상품준비중 전체를 보냄" style="background:#e11d48;color:#fff;border:0;border-radius:6px;padding:5px 0;font-size:10px;font-weight:800;cursor:pointer">1차 (상품준비중)</button>
    <button data-k="next" title="결제완료의 새 주문만 발주확인하면서 보냄" style="background:#fff;color:#e11d48;border:1px solid #fda4af;border-radius:6px;padding:4px 0;font-size:10px;font-weight:800;cursor:pointer">2차 (결제확인)</button>
    <div data-k="msg" style="display:none;font-size:9px;color:#71717a;white-space:pre-wrap;word-break:break-all"></div>`;
  document.documentElement.appendChild(box);
  const $ = (k) => box.querySelector(`[data-k="${k}"]`);
  const show = (text, color) => {
    if (job && text) chrome.runtime.sendMessage({ type: 'JOB_STEP', message: text.split('\n')[0] }).catch(() => {});
    $('msg').style.display = text ? 'block' : 'none';
    $('msg').textContent = text;
    $('msg').style.color = color || '#71717a';
  };

  // 사업자명은 프로필마다 한 번만 적으면 저장되고, 그다음부터는 이름표로만 보인다(누르면 다시 고치기)
  const showBiz = (name) => {
    $('biz').value = name || '';
    $('biz').style.display = name ? 'none' : 'block';
    $('bizLabel').style.display = name ? 'block' : 'none';
    $('bizLabel').textContent = name || '';
  };
  chrome.storage.local.get('businessName', ({ businessName }) => showBiz(businessName));
  const saveBiz = () => {
    const name = $('biz').value.trim();
    if (!name) return;
    chrome.storage.local.set({ businessName: name });
    showBiz(name);
  };
  $('biz').addEventListener('change', saveBiz);
  $('biz').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBiz(); });
  $('bizLabel').addEventListener('click', () => {
    $('bizLabel').style.display = 'none';
    $('biz').style.display = 'block';
    $('biz').focus();
  });
  $('log').addEventListener('click', saveLog);

  // ── 화면 찾기 도우미 ──
  const visible = (el) => !!(el && el.getClientRects().length);
  const ownText = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
  // 글자가 정확히 같은 요소 중 가장 안쪽 것
  const findExact = (text) => {
    const all = [...document.querySelectorAll('label,span,button,a,div,li,p,strong')]
      .filter((el) => visible(el) && !box.contains(el) && ownText(el) === text);
    return all.find((el) => ![...el.children].some((c) => ownText(c) === text)) || null;
  };
  const waitFor = async (fn, ms, step = 300) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  };
  // React 입력칸에 값 넣기
  const setValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // ── hook.js 에서 오는 파일 ──
  let captured = null;
  let capturedUrl = null;
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== HOOK_SRC) return;
    const d = e.data;
    if (d.type === 'LOG') L(`[hook] ${d.text}`);
    else if (d.type === 'ALERT') {
      // 윙 알림창(예: 처리할 주문이 없다) — 진행은 계속하되 내용을 보여 준다
      L(`[윙 알림] ${d.text}`);
      show(`윙 알림: ${d.text}`, '#d97706');
    } else if (d.type === 'URL') {
      L(`[hook] 파일 주소(${d.via}) ${String(d.url).slice(0, 200)}`);
      capturedUrl = capturedUrl || d.url;
    } else if (d.type === 'FILE' && !captured) {
      L(`[hook] 엑셀 받음(${d.via}) ${d.size}바이트`);
      captured = d.base64;
    }
  });

  const fileName = (biz) => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} [원본 ${d.getHours() || '00'}시] ${biz}.xlsx`;
  };

  // ── 단계 ──
  // 탭(결제완료/상품준비중)을 누르고 그 건수를 읽는다 (예: "결제완료 12") — 못 읽으면 null
  const readCount = (label) => {
    const re = new RegExp(`^${label}\\s*([\\d,]+)\\s*(건)?$`);
    for (const el of document.querySelectorAll('button,a,div,li,span,label')) {
      if (!visible(el) || box.contains(el)) continue;
      const m = re.exec(ownText(el));
      if (m) return Number(m[1].replace(/,/g, ''));
    }
    return null;
  };
  const openTab = async (label) => {
    show(`${label} 여는 중…`);
    const tab = await waitFor(() => findExact(label), 15000);
    if (!tab) throw new Error(`"${label}" 버튼을 못 찾았어요`);
    L(`${label} 클릭: <${tab.tagName.toLowerCase()}> ${tab.className}`);
    tab.click();
    await sleep(2500);
    const n = readCount(label);
    L(`윙 ${label} 건수: ${n ?? '못 읽음'}`);
    return n;
  };
  const findButton = (re) =>
    waitFor(() => [...document.querySelectorAll('button,a')].find((el) => visible(el) && !box.contains(el) && re.test(ownText(el))), 10000);

  // 개인정보 다운로드 사유 팝업 → "다운로드"
  const passReasonPopup = async () => {
    const reason = await waitFor(
      () => [...document.querySelectorAll('textarea')].find((t) => visible(t) && /사유|기재/.test(t.placeholder || '')),
      8000
    );
    if (!reason) {
      L('사유 팝업 없음 — 바로 내려받는 것으로 보고 기다림');
      return;
    }
    L('사유 칸 발견 → 입력');
    setValue(reason, '발주서 작성');
    await sleep(400);
    let popup = reason.parentElement;
    let dlBtn = null;
    while (popup && popup !== document.body) {
      dlBtn = [...popup.querySelectorAll('button,a,[id="submitConfirm"]')].find((b) => visible(b) && ownText(b) === '다운로드');
      if (dlBtn) break;
      popup = popup.parentElement;
    }
    if (!dlBtn) throw new Error('사유 팝업의 "다운로드" 버튼을 못 찾았어요');
    L('팝업 다운로드 클릭');
    dlBtn.click();
  };

  // 버튼을 누르고 내려오는 엑셀을 받는다 (capture=false면 확인창만 넘기고 파일은 안 받음)
  const clickAndPass = async (btn, capture) => {
    captured = null;
    capturedUrl = null;
    sessionStorage.setItem(DIALOG_ARM, String(Date.now()));
    if (capture) {
      sessionStorage.setItem(ARM, String(Date.now()));
      chrome.runtime.sendMessage({ type: 'ARM', fileName: currentName });
    }
    btn.click();
    await passReasonPopup();
  };

  const waitCaptured = async () => {
    show('엑셀 받는 중…');
    const got = await waitFor(() => captured || (capturedUrl && 'url'), 60000, 300);
    if (captured) return captured;
    // 화면이 주소로 내려받았거나 hook이 못 잡았으면 확장이 직접 받아 본다
    const url = capturedUrl || (await chrome.runtime.sendMessage({ type: 'LAST_DOWNLOAD_URL' }));
    L(`hook 파일 없음 · 주소로 받기 시도: ${url || '주소도 없음'}`);
    if (!got && !url) throw new Error('엑셀 파일을 1분 안에 못 받았어요');
    const r = await chrome.runtime.sendMessage({ type: 'FETCH_FILE', url });
    if (!r || r.error) throw new Error(`주소로 받기 실패: ${r && r.error}`);
    return r.base64;
  };

  // 결제완료 → 발주확인 처리 (윙 주문 상태가 상품준비중으로 바뀜)
  const confirmPaid = async (capture) => {
    const btn = await findButton(/^발주확인\s*처리/);
    if (!btn) throw new Error('"발주확인 처리" 버튼을 못 찾았어요');
    L(`발주확인 처리 클릭: "${ownText(btn)}"`);
    show('발주확인 처리 중…');
    await clickAndPass(btn, capture);
  };

  // 1차: 결제완료가 있으면 발주확인으로 상품준비중에 모은 뒤, 상품준비중 전체를 받는다
  const runFirst = async () => {
    const paid = await openTab('결제완료');
    if (paid !== 0) {
      await confirmPaid(false);
      // 결제완료가 0이 될 때까지 기다린다 (건수를 못 읽는 화면이면 8초만 기다림)
      show('상품준비중으로 넘어가길 기다리는 중…');
      if (paid == null) await sleep(8000);
      else {
        const end = Date.now() + 40000;
        let left = paid;
        while (Date.now() < end) {
          await sleep(3000);
          left = await openTab('결제완료');
          if (left === 0) break;
        }
        if (left !== 0) throw new Error(`결제완료가 아직 ${left}건 남아 있어요 — 윙 화면 확인`);
      }
    }
    const count = await openTab('상품준비중');
    if (count === 0) throw new Error('상품준비중 주문이 0건이에요');
    const excelBtn = await findButton(/엑셀\s*다운/);
    if (!excelBtn) throw new Error('"엑셀 다운" 버튼을 못 찾았어요');
    L(`엑셀 다운 클릭: "${ownText(excelBtn)}"`);
    show('엑셀 다운 누르는 중…');
    await clickAndPass(excelBtn, true);
    return { base64: await waitCaptured(), wingCount: count, label: '상품준비중' };
  };

  // 2차~: 결제완료의 새 주문만 발주확인 처리하면서 내려오는 엑셀을 받는다
  const runNext = async () => {
    const paid = await openTab('결제완료');
    if (paid === 0) throw new Error('결제완료에 새 주문이 없어요');
    await confirmPaid(true);
    return { base64: await waitCaptured(), wingCount: paid, label: '결제완료' };
  };

  // ── 실행 ──
  let running = false;
  // 이번에 보낼 파일 이름 — 다운로드 폴더에 저장되는 백업 파일도 이 이름으로 바꾼다
  let currentName = '';
  const run = async (mode, biz = $('biz').value.trim()) => {
    if (running) return;
    if (!biz) {
      showBiz('');
      show('사업자명을 먼저 적어 주세요', '#dc2626');
      $('biz').focus();
      return;
    }
    chrome.storage.local.set({ businessName: biz });
    showBiz(biz);
    if (!location.href.startsWith(MANAGE_URL)) {
      sessionStorage.setItem(AUTO_RUN, JSON.stringify({ at: Date.now(), mode }));
      location.href = MANAGE_URL;
      return;
    }
    running = true;
    $('first').disabled = true;
    $('next').disabled = true;
    log.length = 0;
    currentName = fileName(biz);
    L(`시작 · ${mode === 'first' ? '1차' : '2차~'} · 사업자 ${biz} · ${location.href}`);
    try {
      const { base64, wingCount, label } = mode === 'first' ? await runFirst() : await runNext();
      show('윙발주로 보내는 중…');
      const name = currentName;
      const res = await chrome.runtime.sendMessage({ type: 'SEND_INBOX', fileName: name, fileBase64: base64, wingCount, businessName: biz });
      if (!res || res.error) throw new Error(`윙발주로 보내기 실패: ${res && res.error}\n(다운로드 폴더의 엑셀을 직접 올려 주세요)`);
      L(`보냄 · ${name}`);
      show(`보냄 ✓\n${name}\n윙 ${label} ${wingCount ?? '?'}건`, '#16a34a');
      if (job) chrome.runtime.sendMessage({ type: 'JOB_DONE', ok: true, message: `보냄 · 윙 ${label} ${wingCount ?? '?'}건` });
    } catch (err) {
      L(`실패: ${err.message}`);
      show(err.message, '#dc2626');
      saveLog();
      if (job) chrome.runtime.sendMessage({ type: 'JOB_DONE', ok: false, message: err.message });
    } finally {
      sessionStorage.removeItem(ARM);
      sessionStorage.removeItem(DIALOG_ARM);
      running = false;
      $('first').disabled = false;
      $('next').disabled = false;
    }
  };
  $('first').addEventListener('click', () => run('first'));
  $('next').addEventListener('click', () => run('next'));

  // 확장 코드가 바뀌었으면 확장이 스스로 다시 불러오고, 이 탭도 새로고침해 새 코드로 띄운다
  // 그다음, 윙발주 요청으로 열린 탭이면 바로 실행한다
  chrome.runtime.sendMessage({ type: 'CHECK_UPDATE' }).then(async (r) => {
    if (r && r.reloading) {
      show('확장 업데이트 중…', '#2563eb');
      setTimeout(() => location.reload(), 1500);
      return;
    }
    job = await chrome.runtime.sendMessage({ type: 'GET_JOB' });
    if (!job) return;
    const { businessName } = await chrome.storage.local.get('businessName');
    if (!location.href.startsWith(MANAGE_URL)) {
      chrome.runtime.sendMessage({ type: 'JOB_DONE', ok: false, message: '주문배송관리 화면이 안 열렸어요 (윙 로그인 확인)' });
      return;
    }
    setTimeout(() => run(job.mode, businessName || ''), 1500);
  }).catch(() => {});

  // 다른 윙 화면에서 눌러 주문배송관리로 넘어온 경우 이어서 실행
  try {
    const auto = JSON.parse(sessionStorage.getItem(AUTO_RUN) || 'null');
    sessionStorage.removeItem(AUTO_RUN);
    if (auto && Date.now() - auto.at < 60000) setTimeout(() => run(auto.mode), 1500);
  } catch (err) {}
})();
