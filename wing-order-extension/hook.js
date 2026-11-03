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

  // 송장 '등록하기' 뒤 2분 동안은 윙 서버가 돌려주는 글자(JSON)를 확장에 넘긴다 — 등록 결과(성공·실패 건수)를 읽으려고
  const RESP_ARM = '__wingOrderRespArm';
  const respArmed = () => {
    try {
      return Date.now() - Number(sessionStorage.getItem(RESP_ARM) || 0) < 2 * 60 * 1000;
    } catch (err) {
      return false;
    }
  };
  const tellResp = (url, status, text) => post({ type: 'RESP', url: String(url || '').slice(0, 200), status, body: String(text || '').slice(0, 1500) });

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    if (respArmed()) {
      try {
        const url = String((args[0] && args[0].url) || args[0] || '');
        if (/json|text\/plain/i.test(res.headers.get('content-type') || '')) res.clone().text().then((t) => tellResp(url, res.status, t)).catch(() => {});
      } catch (err) {}
    }
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
    if (respArmed()) {
      this.addEventListener('load', () => {
        try {
          if (!/json|text\/plain/i.test(this.getResponseHeader('content-type') || '')) return;
          const t = this.responseType === '' || this.responseType === 'text' ? this.responseText : this.responseType === 'json' ? JSON.stringify(this.response) : '';
          tellResp(this.__wingU, this.status, t);
        } catch (err) {}
      });
    }
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
  // 발주확인 엑셀처럼 확장이 내용만 보면 되는 파일은 실제로 내려받지 않는다 — 한 화면에서 두 번째 다운로드가 나면
  // 크롬이 "여러 파일 다운로드" 허용을 물어 1차 받기가 멈추기 때문 (내용·주소는 위에서 이미 넘김)
  const SILENT = '__wingOrderSilent';
  const silent = () => {
    try {
      return armed() && Date.now() - Number(sessionStorage.getItem(SILENT) || 0) < 2 * 60 * 1000;
    } catch (err) {
      return false;
    }
  };
  const isFileLink = (a) => a.hasAttribute('download') || /^blob:/i.test(a.getAttribute('href') || '');
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...a) {
    tellUrl(this.getAttribute('href'), 'a.click');
    if (silent() && isFileLink(this)) {
      post({ type: 'LOG', text: '내려받기 막음(a.click) — 내용만 봄' });
      return;
    }
    return origClick.apply(this, a);
  };
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    tellUrl(a.getAttribute('href'), 'a');
    if (silent() && isFileLink(a)) {
      e.preventDefault();
      post({ type: 'LOG', text: '내려받기 막음(a) — 내용만 봄' });
    }
  }, true);
  const origWinOpen = window.open;
  window.open = function (url, ...rest) {
    tellUrl(url, 'window.open');
    if (silent() && url) {
      post({ type: 'LOG', text: '내려받기 막음(window.open) — 주소만 봄' });
      return null;
    }
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
