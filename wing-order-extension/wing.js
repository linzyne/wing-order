// 윙 화면 왼쪽 아래 작은 패널: "상품준비중 받아 보내기"를 누르면
// 주문배송관리 → 상품준비중 → 엑셀 다운 → 사유 입력 → 다운로드 를 차례로 누르고,
// 받은 엑셀을 윙발주(Firestore wingInbox)로 보낸다. 윙 주문 상태는 바꾸지 않는다.
(() => {
  if (window.__wingOrderPanel) return;
  window.__wingOrderPanel = true;

  const MANAGE_URL = 'https://wing.coupang.com/tenants/sfl-portal/delivery/management';
  const AUTO_RUN = '__wingOrderAutoRun';
  const ARM = '__wingOrderArm';
  const HOOK_SRC = 'wing-order-hook';

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
  box.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;width:180px;background:#18181b;color:#e4e4e7;border:1px solid #3f3f46;border-radius:10px;padding:8px;font:12px/1.4 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:6px';
  box.innerHTML = `
    <div style="font-weight:800;color:#f87171">윙 → 윙발주</div>
    <input data-k="biz" placeholder="사업자명 (예: 한나푸드)" style="width:100%;box-sizing:border-box;background:#27272a;color:#fff;border:1px solid #3f3f46;border-radius:6px;padding:4px 6px;font-size:12px">
    <button data-k="run" style="background:#dc2626;color:#fff;border:0;border-radius:6px;padding:6px;font-weight:800;cursor:pointer">상품준비중 받아 보내기</button>
    <button data-k="log" style="background:#27272a;color:#a1a1aa;border:0;border-radius:6px;padding:4px;font-size:11px;cursor:pointer">로그 받기</button>
    <div data-k="msg" style="font-size:11px;color:#a1a1aa;white-space:pre-wrap"></div>`;
  document.documentElement.appendChild(box);
  const $ = (k) => box.querySelector(`[data-k="${k}"]`);
  const show = (text, color) => {
    $('msg').textContent = text;
    $('msg').style.color = color || '#a1a1aa';
  };

  chrome.storage.local.get('businessName', ({ businessName }) => {
    $('biz').value = businessName || '';
  });
  $('biz').addEventListener('change', () => chrome.storage.local.set({ businessName: $('biz').value.trim() }));
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
    else if (d.type === 'URL') {
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

  // ── 실행 ──
  let running = false;
  const run = async () => {
    if (running) return;
    const biz = $('biz').value.trim();
    if (!biz) {
      show('사업자명을 먼저 적어 주세요', '#f87171');
      $('biz').focus();
      return;
    }
    chrome.storage.local.set({ businessName: biz });
    if (!location.href.startsWith(MANAGE_URL)) {
      sessionStorage.setItem(AUTO_RUN, String(Date.now()));
      location.href = MANAGE_URL;
      return;
    }
    running = true;
    $('run').disabled = true;
    captured = null;
    capturedUrl = null;
    log.length = 0;
    L(`시작 · 사업자 ${biz} · ${location.href}`);
    try {
      show('상품준비중 여는 중…');
      const tab = await waitFor(() => findExact('상품준비중'), 15000);
      if (!tab) throw new Error('"상품준비중" 버튼을 못 찾았어요');
      L(`상품준비중 클릭: <${tab.tagName.toLowerCase()}> ${tab.className}`);
      tab.click();
      await sleep(2500);

      // 화면에 보이는 상품준비중 건수 (예: "상품준비중 12") — 파일과 대조용
      let wingCount = null;
      for (const el of document.querySelectorAll('button,a,div,li,span,label')) {
        if (!visible(el) || box.contains(el)) continue;
        const m = /^상품준비중\s*([\d,]+)\s*(건)?$/.exec(ownText(el));
        if (m) {
          wingCount = Number(m[1].replace(/,/g, ''));
          break;
        }
      }
      L(`윙 상품준비중 건수: ${wingCount ?? '못 읽음'}`);
      if (wingCount === 0) throw new Error('상품준비중 주문이 0건이에요');

      show('엑셀 다운 누르는 중…');
      const excelBtn = await waitFor(
        () => [...document.querySelectorAll('button,a')].find((el) => visible(el) && !box.contains(el) && /엑셀\s*다운/.test(ownText(el))),
        10000
      );
      if (!excelBtn) throw new Error('"엑셀 다운" 버튼을 못 찾았어요');
      L(`엑셀 다운 클릭: "${ownText(excelBtn)}"`);
      sessionStorage.setItem(ARM, String(Date.now()));
      chrome.runtime.sendMessage({ type: 'ARM' });
      excelBtn.click();

      // 개인정보 다운로드 사유 팝업
      const reason = await waitFor(
        () => [...document.querySelectorAll('textarea')].find((t) => visible(t) && /사유|기재/.test(t.placeholder || '')),
        8000
      );
      if (reason) {
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
      } else {
        L('사유 팝업 없음 — 바로 내려받는 것으로 보고 기다림');
      }

      show('엑셀 받는 중…');
      const got = await waitFor(() => captured || (capturedUrl && 'url'), 60000, 300);
      let base64 = captured;
      if (!base64) {
        // 화면이 주소로 내려받았거나 hook이 못 잡았으면 확장이 직접 받아 본다
        const url = capturedUrl || (await chrome.runtime.sendMessage({ type: 'LAST_DOWNLOAD_URL' }));
        L(`hook 파일 없음 · 주소로 받기 시도: ${url || '주소도 없음'}`);
        if (!got && !url) throw new Error('엑셀 파일을 1분 안에 못 받았어요');
        const r = await chrome.runtime.sendMessage({ type: 'FETCH_FILE', url });
        if (!r || r.error) throw new Error(`주소로 받기 실패: ${r && r.error}`);
        base64 = r.base64;
      }

      show('윙발주로 보내는 중…');
      const name = fileName(biz);
      const res = await chrome.runtime.sendMessage({ type: 'SEND_INBOX', fileName: name, fileBase64: base64, wingCount, businessName: biz });
      if (!res || res.error) throw new Error(`윙발주로 보내기 실패: ${res && res.error}\n(다운로드 폴더의 엑셀을 직접 올려 주세요)`);
      L(`보냄 · ${name}`);
      show(`보냄 ✓\n${name}\n윙 상품준비중 ${wingCount ?? '?'}건`, '#4ade80');
    } catch (err) {
      L(`실패: ${err.message}`);
      show(err.message, '#f87171');
      saveLog();
    } finally {
      sessionStorage.removeItem(ARM);
      running = false;
      $('run').disabled = false;
    }
  };
  $('run').addEventListener('click', run);

  // 다른 윙 화면에서 눌러 주문배송관리로 넘어온 경우 이어서 실행
  if (Date.now() - Number(sessionStorage.getItem(AUTO_RUN) || 0) < 60000) {
    sessionStorage.removeItem(AUTO_RUN);
    setTimeout(run, 1500);
  }
})();
