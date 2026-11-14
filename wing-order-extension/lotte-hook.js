// 롯데 ALPS 화면과 같은 세계(MAIN world)에서 도는 작은 스크립트.
// 운송장 출력 중에 뜨는 "설치가 필요 합니다…" 같은 브라우저 알림창(confirm/alert)을 자동으로 확인 처리합니다.
// 자동 진행 중일 때만 동작하도록, lotte.js가 <html data-rocket-auto-confirm="1">을 켰을 때만 가로챕니다.
(() => {
  if (window.__rocketLotteHookInjected) return;
  window.__rocketLotteHookInjected = true;

  const on = () => document.documentElement.getAttribute('data-rocket-auto-confirm') === '1';
  const origConfirm = window.confirm;
  const origAlert = window.alert;

  window.confirm = function (...args) {
    if (on()) {
      window.postMessage({ source: 'rocket-lotte-hook', type: 'AUTO_CONFIRM', text: String(args[0] || '') }, '*');
      return true;
    }
    return origConfirm.apply(this, args);
  };
  // 통합관리 운송장출력의 목록은 캔버스로 그려지는 표(RealGrid 계열)라 DOM에서 줄·체크칸을 찾을 수 없다.
  // 그래서 (1) 화면이 서버에서 받아오는 목록 데이터를 가로채 운송장번호·수하인명을 읽고,
  //        (2) 표를 그리는 그리드 객체를 찾아 그 기능으로 줄을 체크한다.
  const SRC = 'rocket-lotte-hook';
  const seen = [];
  const keep = (url, text) => {
    if (!text || text.length > 3 * 1024 * 1024) return;
    const head = text.trimStart()[0];
    if (head !== '{' && head !== '[') return;
    seen.push({ url: String(url), text, at: Date.now() });
    if (seen.length > 20) seen.shift();
    window.postMessage({ source: SRC, type: 'JSON', url: String(url), text }, '*');
  };

  // 보낸 요청 기록. 사람이 한 번 직접 "출력"을 눌러 보면, 그때 사이트가 서버로 보낸 요청을 여기 남겨 둔다.
  // 그 요청 모양을 알면 다음부터는 표를 체크하지 않고 같은 요청만 다시 보내면 된다.
  const reqs = [];
  const keepReq = (method, url, body) => {
    let text = '';
    try {
      if (typeof body === 'string') text = body;
      else if (body instanceof URLSearchParams) text = body.toString();
      else if (body && typeof body === 'object' && !(body instanceof FormData)) text = JSON.stringify(body);
      else if (body instanceof FormData) text = Array.from(body.keys()).join(',');
    } catch (err) {}
    reqs.push({ method: String(method || 'GET').toUpperCase(), url: String(url), body: text.slice(0, 6000), at: Date.now() });
    if (reqs.length > 60) reqs.shift();
  };

  // 출력 버튼을 눌렀을 때 페이지 안에서 무슨 일이 일어나는지 기록한다.
  // (클릭이 닿았는지 / 폼이 전송됐는지 / 새 창을 열려 했는지 / 서버로 요청이 나갔는지)
  let lastClick = null;
  let lastSubmit = null;
  const desc = (el) => {
    if (!el || !el.tagName) return '?';
    return `${el.tagName}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
  };
  document.addEventListener(
    'click',
    (e) => {
      lastClick = { target: desc(e.target), trusted: !!e.isTrusted, at: Date.now() };
    },
    true
  );
  document.addEventListener(
    'submit',
    (e) => {
      lastSubmit = { target: (e.target && e.target.getAttribute('target')) || '', action: (e.target && e.target.action) || '', at: Date.now() };
    },
    true
  );
  const origSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function (...a) {
    lastSubmit = { target: this.getAttribute('target') || '', action: this.action || '', at: Date.now(), viaJs: true };
    return origSubmit.apply(this, a);
  };

  // 미리보기 창은 window.open으로 뜬다. 확장이 만든 클릭은 "사람이 누른 클릭"이 아니라서
  // 크롬이 팝업을 막을 수 있는데, 그러면 open이 null을 돌려준다. 그 사실을 패널에 알린다.
  const origWinOpen = window.open;
  window.open = function (...args) {
    let w = null;
    try {
      w = origWinOpen.apply(this, args);
    } finally {
      try {
        window.postMessage({ source: SRC, type: 'OPEN', url: String(args[0] || ''), blocked: !w }, '*');
      } catch (err) {}
    }
    return w;
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    try {
      const u = (args[0] && args[0].url) || args[0];
      keepReq((args[1] && args[1].method) || (args[0] && args[0].method) || 'GET', u, args[1] && args[1].body);
    } catch (err) {}
    const res = await origFetch.apply(this, args);
    try {
      if (/json/i.test(res.headers.get('content-type') || '')) {
        const url = (args[0] && args[0].url) || args[0];
        res.clone().text().then((t) => keep(url, t)).catch(() => {});
      }
    } catch (err) {}
    return res;
  };
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    this.__u = u;
    this.__m = m;
    return origOpen.call(this, m, u, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      keepReq(this.__m, this.__u, args[0]);
    } catch (err) {}
    this.addEventListener('load', () => {
      try {
        if (/json/i.test(this.getResponseHeader('content-type') || '')) {
          keep(this.__u, this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText);
        }
      } catch (err) {}
    });
    return origSend.apply(this, args);
  };

  // 페이지 안에서 표를 그리는 프로그램(그리드 객체) 찾기.
  // 목록이 캔버스로 그려져 화면에는 체크칸이 없으므로, 그 객체에게 "이 줄 체크해"라고 직접 시켜야 한다.
  // 그리드 라이브러리마다 이름이 달라서 window 아래를 2단계까지 뒤지고, eXBuilder6(cpr)·RealGrid도 따로 본다.
  const COUNT_FNS = ['getItemCount', 'getRowCount', 'getDataRowCount', 'getRowCnt', 'getCount'];
  const CHECK_FNS = ['setCheckedRows', 'checkRow', 'checkRows', 'checkAll', 'setAllCheck', 'setCheckBar', 'setRowChecked', 'setChecked', 'checkItem', 'setCheckedItems'];
  const fnsOf = (o) => {
    const out = [];
    for (const proto of [o, Object.getPrototypeOf(o) || {}]) {
      let names = [];
      try {
        names = Object.getOwnPropertyNames(proto);
      } catch (err) {}
      for (const n of names) {
        let v;
        try {
          v = o[n];
        } catch (err) {
          continue;
        }
        if (typeof v === 'function') out.push(n);
      }
    }
    return Array.from(new Set(out));
  };
  const looksLikeGrid = (o) => {
    const fns = fnsOf(o);
    const hasCount = COUNT_FNS.some((f) => fns.includes(f));
    const hasCheck = CHECK_FNS.some((f) => fns.includes(f));
    return hasCount && hasCheck ? fns : null;
  };

  const findGrid = () => {
    const found = [];
    const seenObj = new Set();
    const visit = (obj, path, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 2 || seenObj.has(obj) || found.length > 40) return;
      seenObj.add(obj);
      const fns = looksLikeGrid(obj);
      if (fns) found.push({ path, grid: obj, fns });
      if (depth === 2) return;
      let keys = [];
      try {
        keys = Object.keys(obj);
      } catch (err) {
        return;
      }
      for (const k of keys.slice(0, 400)) {
        if (/^(window|self|top|parent|frames|document|location)$/.test(k)) continue;
        let v;
        try {
          v = obj[k];
        } catch (err) {
          continue;
        }
        if (v && typeof v === 'object') visit(v, `${path}.${k}`, depth + 1);
      }
    };
    visit(window, 'window', 0);

    // eXBuilder6(cpr): 화면 안의 컨트롤들을 훑어 그리드를 찾는다.
    try {
      const app = window.cpr && window.cpr.core && window.cpr.core.App && window.cpr.core.App.getCurrentApp && window.cpr.core.App.getCurrentApp();
      const container = app && app.getContainer && app.getContainer();
      const controls = (container && (container.getControls ? container.getControls(true) : container.getAllControls && container.getAllControls())) || [];
      for (const c of controls) {
        const fns = looksLikeGrid(c);
        if (fns) found.push({ path: `cpr:${(c.id || c.getId && c.getId()) || '?'}`, grid: c, fns });
      }
    } catch (err) {}
    return found;
  };

  const checkLastRows = (grid, fns, need) => {
    const count = (() => {
      for (const f of COUNT_FNS) if (typeof grid[f] === 'function') return grid[f]();
      return 0;
    })();
    if (!count || count < need) return `줄 수 ${count}`;
    const rows = [];
    for (let i = count - need; i < count; i++) rows.push(i);
    if (typeof grid.setCheckedRows === 'function') grid.setCheckedRows(rows, true);
    else if (typeof grid.setCheckedItems === 'function') grid.setCheckedItems(rows, true);
    else if (typeof grid.checkRows === 'function') grid.checkRows(rows, true);
    else if (typeof grid.checkRow === 'function') rows.forEach((r) => grid.checkRow(r, true));
    else if (typeof grid.setRowChecked === 'function') rows.forEach((r) => grid.setRowChecked(r, true));
    else if (typeof grid.checkItem === 'function') rows.forEach((r) => grid.checkItem(r, true));
    else return `체크 기능 없음(${fns.slice(0, 8).join(',')})`;
    return '';
  };

  window.addEventListener('message', (event) => {
    const d = event.data;
    if (!d || d.source !== 'rocket-lotte-panel') return;

    // 지금까지 이 화면이 서버로 보낸 요청 목록(출력 요청의 모양을 알아내려고 본다).
    // 출력 직후 진단: 클릭이 닿았나 / 폼 전송 / 새 창 / 마지막 요청.
    if (d.type === 'PRINT_DIAG') {
      const last = reqs.slice(-3).map((r) => `${r.method} ${String(r.url).split('?')[0].slice(-40)}`);
      window.postMessage({ source: SRC, type: 'PRINT_DIAG_RESULT', lastClick, lastSubmit, reqs: last }, '*');
      return;
    }

    if (d.type === 'REQ_DUMP') {
      window.postMessage({ source: SRC, type: 'REQ_DUMP_RESULT', reqs: reqs.slice(-40) }, '*');
      return;
    }

    // 맨 아래 need개 줄을 체크해 달라는 요청.
    if (d.type === 'CHECK_LAST') {
      const found = findGrid();
      const res = { source: SRC, type: 'CHECK_LAST_RESULT', ok: false, detail: '', candidates: found.map((f) => ({ path: f.path, fns: f.fns.slice(0, 25) })) };
      for (const { path, grid, fns } of found) {
        try {
          const err = checkLastRows(grid, fns, d.need);
          if (!err) {
            res.ok = true;
            res.detail = `${path}에서 마지막 ${d.need}줄 체크`;
            break;
          }
          res.detail = `${path}: ${err}`;
        } catch (err) {
          res.detail = `${path}: ${String((err && err.message) || err)}`;
        }
      }
      if (!res.ok && !found.length) res.detail = '표 객체를 못 찾음';
      window.postMessage(res, '*');
      return;
    }

    // 확인용: 후보 목록만 돌려준다(어떤 객체가 표를 그리는지 파악).
    if (d.type === 'GRID_DIAG') {
      const found = findGrid();
      window.postMessage({
        source: SRC,
        type: 'GRID_DIAG_RESULT',
        url: location.href.split('?')[0],
        candidates: found.map((f) => ({ path: f.path, fns: f.fns.slice(0, 30) })),
      }, '*');
      return;
    }

    if (d.type === 'GET_JSON') {
      seen.forEach((x) => window.postMessage({ source: SRC, type: 'JSON', url: x.url, text: x.text }, '*'));
    }
  });

  window.alert = function (...args) {
    if (on()) {
      window.postMessage({ source: 'rocket-lotte-hook', type: 'AUTO_ALERT', text: String(args[0] || '') }, '*');
      return undefined;
    }
    return origAlert.apply(this, args);
  };
})();
