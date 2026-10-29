// 윙 화면과 같은 세계(MAIN world)에서 도는 작은 스크립트.
// 확장이 "엑셀 다운"을 누르기 직전에 sessionStorage에 표시를 남기면, 그 뒤 2분 동안
// 화면이 받는 엑셀 내용(fetch/XHR/Blob)이나 파일 주소를 가로채 확장(wing.js)에 넘긴다.
// 표시가 없을 때는 아무것도 하지 않는다.
(() => {
  if (window.__wingOrderHookInjected) return;
  window.__wingOrderHookInjected = true;

  const SRC = 'wing-order-hook';
  const ARM = '__wingOrderArm';
  const armed = () => {
    try {
      return Date.now() - Number(sessionStorage.getItem(ARM) || 0) < 2 * 60 * 1000;
    } catch (err) {
      return false;
    }
  };
  const post = (msg) => {
    try {
      window.postMessage({ source: SRC, ...msg }, '*');
    } catch (err) {}
  };

  // xlsx는 zip이라 'PK'로 시작한다 — 엑셀이 아닌 응답은 걸러낸다
  const send = (buf, via) => {
    try {
      const bytes = new Uint8Array(buf);
      if (bytes.length < 100 || bytes.length > 20 * 1024 * 1024) return;
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return;
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      post({ type: 'FILE', via, base64: btoa(bin), size: bytes.length });
    } catch (err) {
      post({ type: 'LOG', text: `파일 넘기기 실패(${via}): ${err && err.message}` });
    }
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    if (armed()) {
      try {
        const url = String((args[0] && args[0].url) || args[0] || '');
        const type = res.headers.get('content-type') || '';
        post({ type: 'LOG', text: `fetch ${res.status} ${type} ${url.slice(0, 160)}` });
        if (!/json|html|javascript|css|text\/plain/i.test(type)) res.clone().arrayBuffer().then((b) => send(b, 'fetch')).catch(() => {});
      } catch (err) {}
    }
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    this.__wingU = u;
    return origOpen.call(this, m, u, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (armed()) {
      this.addEventListener('load', () => {
        try {
          const type = this.getResponseHeader('content-type') || '';
          post({ type: 'LOG', text: `xhr ${this.status} ${type} ${String(this.__wingU || '').slice(0, 160)}` });
          const body = this.response;
          if (body instanceof ArrayBuffer) send(body, 'xhr');
          else if (body instanceof Blob) body.arrayBuffer().then((b) => send(b, 'xhr')).catch(() => {});
        } catch (err) {}
      });
    }
    return origSend.apply(this, args);
  };

  // 화면이 Blob으로 파일을 만들어 내려받는 경우
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    if (armed() && obj instanceof Blob) {
      post({ type: 'LOG', text: `blob ${obj.type} ${obj.size}바이트` });
      obj.arrayBuffer().then((b) => send(b, 'blob')).catch(() => {});
    }
    return origCreate.call(URL, obj);
  };

  // 파일 주소로 내려받는 경우(a 클릭·새 창) — 주소만 넘기고 확장이 직접 받아 본다
  const tellUrl = (url, via) => {
    if (!armed() || !url || /^blob:|^javascript:/i.test(url)) return;
    try {
      post({ type: 'URL', via, url: new URL(url, location.href).href });
    } catch (err) {}
  };
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...a) {
    tellUrl(this.getAttribute('href'), 'a.click');
    return origClick.apply(this, a);
  };
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (a) tellUrl(a.getAttribute('href'), 'a');
  }, true);
  const origWinOpen = window.open;
  window.open = function (url, ...rest) {
    tellUrl(url, 'window.open');
    return origWinOpen.call(window, url, ...rest);
  };

  // 확장이 발주확인 처리를 누르는 동안(2분) 윙이 띄우는 확인창은 확인으로 넘기고, 알림창 내용은 로그에 남긴다
  // (창이 떠 있으면 진행이 멈춘다). 표시가 없을 때는 원래대로 동작한다.
  const DIALOG_ARM = '__wingOrderDialogArm';
  const dialogArmed = () => {
    try {
      return Date.now() - Number(sessionStorage.getItem(DIALOG_ARM) || 0) < 2 * 60 * 1000;
    } catch (err) {
      return false;
    }
  };
  const origConfirm = window.confirm;
  const origAlert = window.alert;
  window.confirm = function (msg) {
    if (!dialogArmed()) return origConfirm.call(window, msg);
    post({ type: 'LOG', text: `확인창 → 확인: ${String(msg || '')}` });
    return true;
  };
  window.alert = function (msg) {
    if (!dialogArmed()) return origAlert.call(window, msg);
    post({ type: 'ALERT', text: String(msg || '') });
  };
})();
