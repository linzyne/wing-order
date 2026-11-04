// 윙 화면 왼쪽 아래 작은 패널.
// 1차 보내기: 결제완료 → 발주확인 처리(상품준비중으로 모음) → 상품준비중 → 엑셀 다운 → 사유 입력 → 다운로드
// 2차~ 보내기: 결제완료 → 발주확인 처리 → 사유 입력 → 다운로드 (새 주문만)
// 받은 엑셀은 윙발주(Firestore wingInbox)로 보낸다. 둘 다 발주확인 처리를 하므로 윙 주문 상태가 바뀐다.
// 송장 올리기: 윙발주 요청으로 연 탭이면 상품준비중 → 엑셀 대량배송에 송장 파일을 넣고 등록한다.
(() => {
  if (window.__wingOrderPanel) return;
  window.__wingOrderPanel = true;

  const MANAGE_URL = 'https://wing.coupang.com/tenants/sfl-portal/delivery/management';
  const AUTO_RUN = '__wingOrderAutoRun';
  const ARM = '__wingOrderArm';
  const DIALOG_ARM = '__wingOrderDialogArm';
  const SILENT = '__wingOrderSilent';
  const RESP_ARM = '__wingOrderRespArm';
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
    if (job && text && !color) chrome.runtime.sendMessage({ type: 'JOB_STEP', message: text.split('\n')[0] }).catch(() => {});
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
  const alerts = [];
  const responses = [];
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== HOOK_SRC) return;
    const d = e.data;
    if (d.type === 'LOG') L(`[hook] ${d.text}`);
    else if (d.type === 'ALERT') {
      // 윙 알림창(예: 처리할 주문이 없다) — 진행은 계속하되 내용을 보여 준다
      L(`[윙 알림] ${d.text}`);
      alerts.push(d.text);
      show(`윙 알림: ${d.text}`, '#d97706');
    } else if (d.type === 'URL') {
      L(`[hook] 파일 주소(${d.via}) ${String(d.url).slice(0, 200)}`);
      capturedUrl = capturedUrl || d.url;
    } else if (d.type === 'RESP') {
      L(`[윙 응답] ${d.status} ${d.url} ${d.body.replace(/\s+/g, ' ').slice(0, 400)}`);
      responses.push(d);
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
  // 탭(결제완료/상품준비중) 카드에 보이는 건수를 읽는다 — 못 읽으면 null
  // 카드는 "상품준비중 ⓘ" 글자와 "8" 숫자가 따로 있어서, 이름 글자에서 위로 올라가며
  // 이름 + 숫자 하나만 들어 있는 짧은 상자를 찾는다 (배송상태 칩·목록 제목 같은 건 숫자가 없어 지나감)
  const readCount = (label) => {
    const labels = [...document.querySelectorAll('span,div,p,strong,label,button,a,li,dt,h3,h4')]
      .filter((el) => visible(el) && !box.contains(el) && ownText(el) === label);
    for (const el of labels) {
      let cur = el.parentElement;
      for (let i = 0; i < 4 && cur && cur !== document.body; i++, cur = cur.parentElement) {
        const text = ownText(cur);
        if (text.length > 30) break;
        const m = /^([\d,]+)\s*(건)?$/.exec(text.replace(label, '').replace(/[?ⓘ]/g, '').trim());
        if (m) return Number(m[1].replace(/,/g, ''));
      }
    }
    // 카드 글자 줄이 "결제완료" 다음 줄에 숫자로 보이는 경우, 또는 안내 띠의 "(결제완료 0, 상품준비중 8 …)"
    const page = document.body.innerText || '';
    const m1 = new RegExp(`(?:^|\\n)\\s*${label}[\\s?ⓘ]*\\n\\s*([\\d,]+)\\s*(?:\\n|$)`).exec(page);
    if (m1) return Number(m1[1].replace(/,/g, ''));
    const m2 = new RegExp(`${label}\\s*([\\d,]+)\\s*[,)]`).exec(page);
    if (m2) return Number(m2[1].replace(/,/g, ''));
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
      return false;
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
    return true;
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
    return passReasonPopup();
  };

  const waitCaptured = async (ms = 60000) => {
    show('엑셀 받는 중…');
    const got = await waitFor(() => captured || (capturedUrl && 'url'), ms, 300);
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
  // 윙이 처리를 끝내면 발주확인 엑셀이 내려온다 — 그걸로 끝난 걸 안다.
  // (결제완료 카드 숫자는 처리 뒤에도 몇 분씩, 새로고침해도 그대로라 믿을 수 없음)
  const confirmPaid = async () => {
    const btn = await findButton(/^발주확인\s*처리/);
    if (!btn) throw new Error('"발주확인 처리" 버튼을 못 찾았어요');
    L(`발주확인 처리 클릭: "${ownText(btn)}"`);
    show('발주확인 처리 중…');
    // hook만 켠다 — 확장 ARM(파일 이름 바꾸기)은 안 보냄, 이 파일은 윙발주로 안 보냄
    // 실제 내려받기는 막는다 — 뒤에 상품준비중 엑셀까지 두 번 내려받으면 크롬이 "여러 파일 다운로드"를 물음
    sessionStorage.setItem(ARM, String(Date.now()));
    sessionStorage.setItem(SILENT, String(Date.now()));
    try {
      const popup = await clickAndPass(btn, false);
      const got = await waitFor(() => captured || capturedUrl, popup ? 60000 : 15000);
      L(got ? '발주확인 엑셀 내려옴 → 처리 끝' : '발주확인 엑셀 못 봄');
      return !!got;
    } finally {
      sessionStorage.removeItem(SILENT);
    }
  };

  // 1차: 결제완료가 있으면 발주확인으로 상품준비중에 모은 뒤, 상품준비중 전체를 받는다
  const runFirst = async () => {
    const paid = await openTab('결제완료');
    // 발주확인 뒤 상품준비중 카드 숫자는 몇 분씩 옛날 그대로라, 발주확인 전에 읽어 둔 숫자 + 넘긴 결제완료로 센다
    const readyBefore = readCount('상품준비중');
    let moved = false;
    if (paid !== 0) {
      // 엑셀이 안 내려오면 이미 다 넘어간 것(카드 숫자만 옛날 것) — 그대로 상품준비중을 받는다
      moved = await confirmPaid();
      show('상품준비중으로 넘어가길 기다리는 중…');
      await sleep(4000);
    }
    const cardCount = await openTab('상품준비중');
    const expected = moved && paid != null && readyBefore != null ? readyBefore + paid : null;
    const count = expected != null && cardCount != null ? Math.max(cardCount, expected) : cardCount ?? expected;
    L(`상품준비중 건수: 카드 ${cardCount ?? '?'} · 발주확인 전 ${readyBefore ?? '?'} + 결제완료 ${moved ? paid : 0} → ${count ?? '?'}`);
    reportCount(count);
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
    if (paid === 0) {
      reportCount(await openTab('상품준비중'));
      return { none: true };
    }
    const btn = await findButton(/^발주확인\s*처리/);
    if (!btn) throw new Error('"발주확인 처리" 버튼을 못 찾았어요');
    L(`발주확인 처리 클릭: "${ownText(btn)}"`);
    show('발주확인 처리 중…');
    const popup = await clickAndPass(btn, true);
    if (!popup && paid == null) {
      // 건수를 못 읽었는데 사유 팝업도 안 뜨면 처리할 주문이 없는 것 — 15초만 기다려 보고 끝낸다
      if (!(await waitFor(() => captured || capturedUrl, 15000))) {
        L('팝업·파일 없음 → 결제완료 새 주문 없음으로 끝냄');
        reportCount(await openTab('상품준비중'));
        return { none: true };
      }
    }
    const base64 = await waitCaptured();
    // 발주확인으로 상품준비중에 넘어간 뒤의 전체 건수
    await sleep(1500);
    reportCount(await openTab('상품준비중'));
    return { base64, wingCount: paid, label: '결제완료' };
  };

  // 윙 상품준비중 건수를 윙발주에 알린다 (발주서 화면의 '윙 N')
  const reportCount = (n) => {
    if (n == null) return;
    chrome.storage.local.get('businessName', ({ businessName }) => {
      if (businessName) chrome.runtime.sendMessage({ type: 'READY_COUNT', businessName, count: n }).catch(() => {});
    });
  };

  // ── 송장 올리기 (윙발주 요청) ──
  // 상품준비중 → 엑셀 대량배송 → 파일 넣기 → 등록하기. 끝나면 화면·알림에 뜬 결과 글자를 그대로 알린다.
  // 등록 결과 창을 닫고 상품준비중을 다시 눌러 건수를 읽는다
  const readReadyAfterUpload = async () => {
    const close = [...document.querySelectorAll('button,a')].find((b) => visible(b) && !box.contains(b) && /^(닫기|확인)$/.test(ownText(b)));
    if (close) { L(`결과 창 닫기: "${ownText(close)}"`); close.click(); await sleep(800); }
    const n = await openTab('상품준비중').catch(() => null);
    L(`등록 뒤 상품준비중: ${n ?? '못 읽음'}`);
    return n;
  };
  // 진단: 요소 주변 모습을 로그에 남긴다 (윙 화면이 바뀌면 이걸 보고 고침)
  const describe = (el) => {
    if (!el) return '-';
    const cls = typeof el.className === 'string' ? el.className.slice(0, 60) : '';
    return `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? ' .' + cls : ''}> "${ownText(el).slice(0, 80)}"`;
  };
  const logScreen = (title) => {
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    L(`${title} · 파일 칸 ${inputs.length}개`);
    inputs.forEach((el, i) => {
      let p = el.parentElement;
      for (let k = 0; k < 4 && p && ownText(p).length < 10; k++) p = p.parentElement;
      L(`  파일칸${i}: accept=${el.accept || '-'} 보임=${visible(el)} 주변=${describe(p)}`);
    });
    const frames = [...document.querySelectorAll('iframe')].filter(visible);
    if (frames.length) L(`  iframe ${frames.length}개: ${frames.map((f) => (f.src || '').slice(0, 100)).join(' | ')}`);
    const btns = [...document.querySelectorAll('button,a,[role="button"]')]
      .filter((b) => visible(b) && !box.contains(b) && ownText(b) && ownText(b).length < 20)
      .map((b) => ownText(b));
    L(`  버튼: ${[...new Set(btns)].slice(0, 60).join(' | ')}`);
    const dialogs = [...document.querySelectorAll('[role="dialog"],.modal,[class*="modal"],[class*="Modal"],[class*="popup"],[class*="Popup"],[class*="layer"],[class*="Layer"]')]
      .filter((el) => visible(el) && !box.contains(el));
    dialogs.slice(0, 5).forEach((d, i) => L(`  창${i}: ${describe(d)} · ${(d.innerText || '').replace(/\s+/g, ' ').slice(0, 300)}`));
  };
  // 파일 칸과 "등록하기"가 함께 들어 있는 가장 작은 상자 = 엑셀 대량배송 창
  const findUploadForm = () => {
    const regs = [...document.querySelectorAll('button,a,[role="button"]')]
      .filter((b) => visible(b) && !box.contains(b) && /^등록하기$/.test(ownText(b)));
    for (const reg of regs) {
      for (let p = reg.parentElement; p && p !== document.body; p = p.parentElement) {
        const input = p.querySelector('input[type="file"]');
        if (input) return { reg, input, form: p };
      }
    }
    return null;
  };
  const runInvoice = async ({ fileName: name, fileBase64 }) => {
    if (!fileBase64) throw new Error('송장 파일이 비어 있어요');
    const readyBefore = await openTab('상품준비중');
    const btn = await findButton(/엑셀\s*대량\s*배송/);
    if (!btn) throw new Error('"엑셀 대량배송" 버튼을 못 찾았어요');
    sessionStorage.setItem(DIALOG_ARM, String(Date.now()));
    L(`엑셀 대량배송 클릭: ${describe(btn)}`);
    show('엑셀 대량배송 여는 중…');
    btn.click();
    await sleep(1500);
    logScreen('엑셀 대량배송 누른 뒤');
    const found = await waitFor(findUploadForm, 10000);
    if (!found) {
      logScreen('등록 창 못 찾음');
      throw new Error('엑셀 대량배송 창(파일 칸 + 등록하기)을 못 찾았어요 — 로그 보내 주세요');
    }
    const { reg, input, form } = found;
    L(`등록 창: ${describe(form)} · 파일 칸 accept=${input.accept || '-'}`);
    show('송장 파일 넣는 중…');
    const bin = atob(fileBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    L(`파일 넣음: ${name} ${bytes.length}바이트`);
    // 창에 파일 이름이 보이면 화면이 파일을 받은 것
    const shortName = name.replace(/\.xlsx?$/i, '').slice(-12);
    const taken = await waitFor(() => [...form.querySelectorAll('input')].some((el) => (el.value || '').includes(shortName)) || (form.innerText || '').includes(shortName), 5000);
    L(`창에 파일 이름 보임: ${taken ? '예' : '아니오'} · 창 글자: ${(form.innerText || '').replace(/\s+/g, ' ').slice(0, 300)}`);
    // 엑셀 대량배송 창 — 클래스·role이 없는 div라 제목 글자로 찾는다. 등록 결과는 이 창 안에 뜬다
    let dialog = form;
    while (dialog.parentElement && dialog.parentElement !== document.body && !/^엑셀\s*대량\s*배송/.test((dialog.innerText || '').trim())) dialog = dialog.parentElement;
    const dialogLines = () => (dialog.innerText || '').split('\n').map((t) => t.trim()).filter(Boolean);
    const beforeLines = new Set(dialogLines());
    // 창의 안내문(※ 엑셀 파일을 업로드 하세요…)은 등록 뒤 다시 그려져도 결과가 아니라서 뺀다
    const isGuide = (t) => /^※|업로드\s*하세요|작성\s*가이드|필수\s*정보|파일\s*선택|다운로드\s*받은/.test(t);
    const newLines = () => dialogLines().filter((t) => !beforeLines.has(t) && !t.includes(shortName) && !isGuide(t));
    alerts.length = 0;
    responses.length = 0;
    sessionStorage.setItem(DIALOG_ARM, String(Date.now()));
    sessionStorage.setItem(RESP_ARM, String(Date.now()));
    L('등록하기 클릭');
    show('등록하는 중…');
    reg.click();
    // 결과: 알림창, 창 안에 새로 생긴 글자, 윙 서버 응답 중 하나라도 올 때까지 (최대 30초), 오면 조금 더 모은다
    const got = await waitFor(() => alerts.length || newLines().length || responses.length, 30000, 500);
    await sleep(2500);
    sessionStorage.removeItem(RESP_ARM);
    const lines = newLines();
    const resp = responses.map((r) => `${r.status} ${r.body}`).join(' / ');
    const shown = [alerts.join(' / '), lines.join(' · ')].filter(Boolean).join(' / ');
    L(`결과: 알림 ${alerts.length}개 · 창 새 글자 ${lines.length}줄 · 응답 ${responses.length}개 · ${shown || '(글자 없음)'}`);
    if (!got) logScreen('등록하기 뒤 결과 없음');
    const all = `${shown} ${resp}`;
    const num = (re) => { const m = re.exec(all); return m ? Number(m[m.length - 1]) : null; };
    const fail = num(/실패\s*:?\s*(\d+)|"(?:fail|error)\w*"\s*:\s*(\d+)/i);
    const ok = num(/성공\s*:?\s*(\d+)|"success\w*"\s*:\s*(\d+)/i);
    // 안내 글자에 걸리지 않게, 알림창은 실패·오류 말만, 그 밖엔 실패 건수가 1 이상일 때만 실패로 본다
    if (/실패|오류|올바르지|잘못|형식/.test(alerts.join(' ')) || (fail != null && fail > 0) || responses.some((r) => r.status >= 400)) {
      throw new Error(`윙: ${(shown || resp).slice(0, 200)}`);
    }
    // 윙 화면의 상품준비중 숫자는 몇 분씩 늦게 바뀌어서 성공·실패 판단에 쓰지 않는다
    const result = ok != null ? `윙 등록 성공 ${ok}건${fail != null ? ` · 실패 ${fail}건` : ''}`
      : shown ? `윙: ${shown.slice(0, 150)}`
      : responses.length ? '등록함 (윙 응답 받음)'
      : '등록하기 누름 — 결과 못 읽음, 윙 배송지시에서 확인';
    await sleep(2000);
    const left = await readReadyAfterUpload();
    if (left != null && readyBefore != null && left < readyBefore) {
      reportCount(left);
      return `${result} · 상품준비중 ${readyBefore} → ${left}건`;
    }
    return result;
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
      const { base64, wingCount, label, none } = mode === 'first' ? await runFirst() : await runNext();
      if (none) {
        L('결제완료 새 주문 없음 — 할 일 없음');
        show('결제확인 새 주문 없음 ✓', '#16a34a');
        if (job) chrome.runtime.sendMessage({ type: 'JOB_DONE', ok: true, message: '새 주문 없음' });
        return;
      }
      show('윙발주로 보내는 중…');
      const name = currentName;
      const res = await chrome.runtime.sendMessage({ type: 'SEND_INBOX', fileName: name, fileBase64: base64, wingCount, businessName: biz, source: label });
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
  const runInvoiceJob = async (j) => {
    if (running) return;
    running = true;
    log.length = 0;
    L(`시작 · 송장 올리기 · ${j.fileName} · ${location.href}`);
    try {
      const msg = await runInvoice(j);
      show(`송장 올림 ✓\n${msg}`, '#16a34a');
      chrome.runtime.sendMessage({ type: 'JOB_DONE', ok: true, message: `송장 올림 · ${msg}` });
    } catch (err) {
      L(`실패: ${err.message}`);
      show(err.message, '#dc2626');
      chrome.runtime.sendMessage({ type: 'JOB_DONE', ok: false, message: err.message });
    } finally {
      // 처음 몇 번은 윙 결과 화면을 보려고 성공해도 로그를 남긴다
      saveLog();
      sessionStorage.removeItem(DIALOG_ARM);
      running = false;
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
    if (job.mode === 'invoice') setTimeout(() => runInvoiceJob(job), 1500);
    else if (job.mode === 'count') setTimeout(async () => {
      // 윙발주에서 '윙 N'을 눌러 건수만 새로 읽기
      try {
        const n = await openTab('상품준비중');
        if (n == null) throw new Error('상품준비중 건수를 못 읽었어요');
        reportCount(n);
        chrome.runtime.sendMessage({ type: 'JOB_DONE', ok: true, message: `상품준비중 ${n}건` });
      } catch (err) {
        chrome.runtime.sendMessage({ type: 'JOB_DONE', ok: false, message: err.message });
      }
    }, 1500);
    else setTimeout(() => run(job.mode, businessName || ''), 1500);
  }).catch(() => {});

  // 다른 윙 화면에서 눌러 주문배송관리로 넘어온 경우 이어서 실행
  try {
    const auto = JSON.parse(sessionStorage.getItem(AUTO_RUN) || 'null');
    sessionStorage.removeItem(AUTO_RUN);
    if (auto && Date.now() - auto.at < 60000) setTimeout(() => run(auto.mode), 1500);
  } catch (err) {}
})();
