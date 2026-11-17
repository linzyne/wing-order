// 어드민 화면 자체(MAIN world)에서 도는 작은 가로채기 — 송장 가져오기용.
// 어드민의 '엑셀다운로드'는 fetch 로 파일 이름을 받은 뒤 excel.download.php 로 내려받는다.
// admin.js 가 'WING_CAPTURE' 를 보내면 잠깐 동안 그 주소의 파일을 대신 읽어 admin.js 로 넘기고,
// 다운로드 폴더에 파일이 쌓이지 않게 그 주소로 가는 링크 클릭은 막는다.
(() => {
  if (window.__wingAdminMain) return;
  window.__wingAdminMain = true;

  let captureUntil = 0;
  let blockPath = '';
  const capturing = () => Date.now() < captureUntil;
  const post = (data) => window.postMessage({ source: 'wing-admin-main', ...data }, location.origin);

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'wing-admin' || e.data.type !== 'WING_CAPTURE') return;
    captureUntil = Date.now() + 20000;
    blockPath = '';
  });

  const toBase64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    if (!capturing()) return res;
    try {
      const data = await res.clone().json();
      // 응답 { state: 'ok', msg: 'orderlist_20261117_153607', rtnpah: '' } — 파일 이름이 msg 에 온다
      const name = data && data.state === 'ok' && 'rtnpah' in data ? String(data.rtnpah || data.msg || '') : '';
      if (/^[\w.-]+$/.test(name)) {
        captureUntil = 0;
        blockPath = `excel.download.php?downloadExcel=${encodeURIComponent(name)}`;
        const file = await origFetch(`/partner/order/excel/${blockPath}`, { credentials: 'include' });
        if (!file.ok) throw new Error(`파일 받기 ${file.status}`);
        const buf = await file.arrayBuffer();
        post({ type: 'WING_XLSX', fileName: /\.xlsx?$/i.test(name) ? name : `${name}.xlsx`, fileBase64: toBase64(buf) });
      }
    } catch (e) {
      if (blockPath) post({ type: 'WING_XLSX_FAIL', message: String(e?.message || e) });
    }
    return res;
  };

  // 내려받기 막기: 방금 가로챈 파일 주소로 가는 링크 클릭만
  const isBlocked = (a) => blockPath && a.href && a.href.includes(blockPath);
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (isBlocked(this)) { blockPath = ''; return; }
    return origClick.call(this);
  };
})();
