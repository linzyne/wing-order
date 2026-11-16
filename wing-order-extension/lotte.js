// (로켓 앱 확장 rocket-hub-extension/lotte.js에서 가져옴 — 윙발주는 주문번호를 W261114-153012-1 모양으로 붙인다)
// 롯데택배 ALPS(partner.alps.llogis.com)에서 윙발주가 만든 롯데택배 엑셀을 대신 올립니다.
//   1) 거래처관리 › 일괄주문접수 → 사용자파일 "B-type[지정송하인]" → 타이틀있음 체크 → 파일 올리기(택배 예약)
//   2) 집배달 › 통합관리 운송장출력 → 조회 → 맨 아래 예약분만 체크 → 출력 → 미리보기 창에서 관리번호를 하나씩 눌러 운송장
//      번호를 발급받고 창 닫기 → 목록에서 운송장번호·수하인명을 읽어 앱으로 보냄
// 로그인: 확장 설정(아이콘 클릭)에 아이디·비밀번호를 저장해 두면 로그인 화면에서 대신 로그인합니다.
// 저장 안 했거나 두 번 실패하면 사람이 로그인할 때까지 기다렸다가 이어서 합니다.
// 파일을 올리면 주문이 접수되고, background.js가 몇 초 뒤 팝업 창을 닫습니다.
//
// 일괄주문접수 화면은 다른 주소(*.llogis.com)의 내부 창(iframe)에 뜨므로 llogis.com 전체의 모든 프레임에서 돌고,
// 진행 단계는 chrome.storage의
// lottePending.step으로 프레임끼리 나눕니다. 안내 창은 맨 위 화면에만 띄웁니다.
//
// 화면 구조(클래스명)는 언제든 바뀔 수 있으므로 눈에 보이는 글자로 메뉴와 버튼을 찾습니다.
(() => {
  if (window.__rocketLotteInjected) return;
  window.__rocketLotteInjected = true;

  const KEY = 'lottePending';
  const MAX_AGE_MS = 10 * 60 * 1000;
  const IS_TOP = window === window.top;
  // 운송장 미리보기는 사이트가 새로 연 창(PIDPIC…)이다. 일괄주문접수 화면도 같은 pid.alps.llogis.com에 뜨므로
  // 주소만 보고 판단하면 안 되고, "새로 열린 창인지"로 가린다.
  const IS_PREVIEW = IS_TOP && (!!window.opener || /PIDPIC/i.test(location.href));
  // 확장 새 코드 확인은 윙 화면에서만 하고 있어서, 롯데 창만 쓰는 프로필은 예전 코드로 돌았다(11/16 한나푸드).
  // 롯데 창이 뜰 때도 확인하고, 바뀌었으면 확장이 다시 불러온 뒤 이 화면을 새로고침한다(진행 상태는 저장돼 있어 이어서 한다).
  if (IS_TOP && !IS_PREVIEW) {
    chrome.runtime.sendMessage({ type: 'CHECK_UPDATE' }).then((r) => {
      if (r && r.reloading) setTimeout(() => location.reload(), 1500);
    }, () => {});
  }
  // 이 창(프레임)만의 번호. 파일을 올린 창과 그 뒤 새로 뜬 창을 구분하는 데 씁니다.
  const FRAME_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const TEXT = {
    menu: /^거래처\s*관리$/,
    page: /^일괄\s*주문\s*접수$/,
    userFile: /^사용자\s*파일$/,
    // 사용자파일 드롭다운의 선택지: 선택안함 / A-type[일반] / B-type[지정송하인] / C-type[품명다수]
    senderOption: /B-?type\s*\[\s*지정\s*송하인\s*\]/i,
    comboValue: /^(선택안함|[A-Z]-?type\s*\[.*\])$/i,
    // 엑셀 첫 줄이 제목 줄이라 "타이틀여부 › 타이틀있음"을 체크해야 합니다.
    title: /^타이틀\s*있음$/,
    openBtn: /파일\s*열기/,
    // 업로드 결과 안내창("성공건수 : (3)건 … 완료 하였습니다.")의 확인 버튼.
    uploadDone: /성공건수|완료\s*하였습니다/,
    ok: /^확인$/,
    // 2) 운송장 만들기
    deliveryMenu: /^집배달$/,
    waybillPage: /^통합관리\s*운송장출력$/,
    search: /^조회$/,
    print: /^출력$/,
    condLabel: /^검색조건$/,
    ordNoOption: /^주문번호$/,
    // 미리보기 창: 왼쪽 "운송장종류"를 표준라벨E로 고르고 오른쪽 위 "출력"을 누른다.
    kindLabel: /^운송장\s*종류$/,
    labelE: /^표준라벨\s*E$/,
    waybillCol: /^운송장번호$/,
    receiverCol: /^수하인명$/,
    mgmtCol: /^관리번호$/,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const get = () =>
    new Promise((resolve) => {
      try {
        chrome.storage.local.get(KEY, (r) => resolve((r && r[KEY]) || null));
      } catch (err) {
        resolve(null);
      }
    });
  const patch = async (updates) => {
    const cur = await get();
    if (!cur) return;
    // 멈춘 시각. 멈춘 뒤 새로 조회된 목록만 믿으려고 남긴다.
    if (updates.step === 'manual' && cur.step !== 'manual' && !updates.manualAt) updates = { ...updates, manualAt: Date.now() };
    await new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [KEY]: { ...cur, ...updates } }, () => resolve());
      } catch (err) {
        resolve();
      }
    });
  };
  // 한 번 올리기 시작했으면(uploading) 다시는 올리지 않습니다. 파일을 올리면 그 창이 새로 뜨는데,
  // 새로 뜬 창이 "아직 안 올렸다"고 보고 또 올리는 일을 막기 위해서입니다.
  // 파일을 한 번 올린 뒤에는 다시 올리지 않게 막는 단계들(올리기 이후 단계 포함).
  const UPLOADED_STEPS = ['uploading', 'uploaded', 'waybillMenu', 'waybillPage', 'preview', 'waybillDone', 'verify', 'manual', 'waybills', 'error'];
  const DONE_STEPS = ['waybills', 'error'];
  const CRED_KEY = 'lotteCredentials';
  const getCreds = () =>
    new Promise((resolve) => {
      try {
        chrome.storage.local.get(CRED_KEY, (r) => resolve((r && r[CRED_KEY]) || null));
      } catch (err) {
        resolve(null);
      }
    });

  // 화면 라이브러리가 값을 알아채도록 입력칸의 원래 setter로 넣고 input/change를 보냅니다.
  const setValue = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // 로그인 화면: 비밀번호 칸 바로 앞의 글자 입력칸을 아이디 칸으로 보고 채운 뒤 로그인 버튼을 누릅니다.
  // 틀린 비밀번호로 계속 시도해 계정이 잠기지 않도록 한 요청당 최대 2번, 15초 간격으로만 시도합니다.
  const tryLogin = async (p, pw, save = patch) => {
    const creds = await getCreds();
    if (!creds) {
      await save({ status: '로그인해 주세요. (확장 아이콘 › 설정에 아이디·비밀번호를 저장하면 자동으로 로그인해요)' });
      return;
    }
    const tries = p.loginTries || 0;
    if (tries >= 2) {
      await save({ status: '자동 로그인이 두 번 실패했어요. 직접 로그인해 주세요(확장 설정의 비밀번호도 확인해 주세요).' });
      return;
    }
    if (Date.now() - (p.loginAt || 0) < 15000) return;
    const inputs = Array.from(document.querySelectorAll('input')).filter(
      (el) => visible(el) && /^(text|email|tel|number|)$/.test(el.type || '')
    );
    const idInput = inputs.filter((el) => el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING).pop() || inputs[0];
    if (!idInput) return;
    await save({ loginTries: tries + 1, loginAt: Date.now(), status: '자동 로그인 중…' });
    setValue(idInput, creds.id);
    setValue(pw, creds.pw);
    await sleep(300);
    const btn =
      Array.from(document.querySelectorAll('button, a, input[type="submit"], input[type="button"]')).find(
        (el) => visible(el) && /^(로그인|login)$/i.test(clean(el.textContent || el.value))
      ) || (pw.form && pw.form.querySelector('[type="submit"]'));
    if (btn) realClick(btn);
    else {
      pw.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      if (pw.form) pw.form.requestSubmit ? pw.form.requestSubmit() : pw.form.submit();
    }
  };

  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };

  // 글자가 딱 맞는 가장 안쪽 요소들.
  const findAll = (re) =>
    Array.from(document.querySelectorAll('body *')).filter((el) => {
      if (panel && panel.contains(el)) return false;
      if (rpPanel && rpPanel.contains(el)) return false;
      const own = clean(el.textContent);
      if (!re.test(own)) return false;
      return !Array.from(el.children).some((c) => re.test(clean(c.textContent))) && visible(el);
    });
  const find = (re) => findAll(re)[0] || null;

  // 일부 화면 라이브러리는 click만으로는 반응하지 않아 마우스 이벤트를 차례로 보냅니다.
  const realClick = (el) => {
    const target = el.closest('a,button,label,li,[role="button"],[onclick]') || el;
    const opts = { bubbles: true, cancelable: true, view: window };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
      const Ev = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ev(type, opts));
    });
  };

  // "사용자파일" 드롭다운에서 B-type[지정송하인] 고르기.
  //  1) 진짜 <select>면 값을 바로 바꾸고,
  //  2) 화면 라이브러리의 가짜 드롭다운이면 "사용자파일" 글자 바로 오른쪽(같은 줄)의 칸을 눌러 연 뒤 선택지를 누릅니다.
  //     (왼쪽 "쇼핑몰파일" 칸도 "선택안함"이라, 글자가 아니라 위치로 구분합니다.)
  // 드롭다운 칸에 보이는 값. 글자로 그리는 곳도 있고 읽기 전용 입력칸(value)으로 그리는 곳도 있습니다.
  const shown = (el) => clean(el.tagName === 'INPUT' ? el.value : el.textContent);
  const comboText = (label) => {
    const lr = label.getBoundingClientRect();
    const midY = lr.top + lr.height / 2;
    const cands = Array.from(document.querySelectorAll('body *')).filter((el) => {
      if (el.children.length > 2 || !visible(el) || !TEXT.comboValue.test(shown(el))) return false;
      const r = el.getBoundingClientRect();
      return r.left >= lr.right - 5 && Math.abs(r.top + r.height / 2 - midY) < 20;
    });
    cands.sort((x, y) => x.getBoundingClientRect().left - y.getBoundingClientRect().left);
    return cands[0] || null;
  };

  const pickSenderType = async () => {
    for (const sel of document.querySelectorAll('select')) {
      const opt = Array.from(sel.options).find((o) => TEXT.senderOption.test(clean(o.textContent)));
      if (opt) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    const label = find(TEXT.userFile);
    if (!label) return false;
    const combo = comboText(label);
    if (combo && TEXT.senderOption.test(shown(combo))) return true; // 이미 골라져 있음
    if (combo) realClick(combo);
    // 선택지 목록은 화면이 그려진 뒤에 나타난다. 최대 3초까지 기다리며 찾는다.
    let item = null;
    for (let i = 0; i < 12 && !item; i++) {
      await sleep(250);
      item = findAll(TEXT.senderOption).filter((el) => el !== combo).pop() || null;
    }
    if (!item) return false;
    realClick(item);
    await sleep(400);
    const after = comboText(label);
    return !after || TEXT.senderOption.test(shown(after));
  };

  // "타이틀있음" 체크. 이름표에 연결된 체크박스를 찾아 꺼져 있을 때만 누릅니다.
  const checkTitle = async () => {
    const label = find(TEXT.title);
    if (!label) return false;
    const box =
      (label.control && label.control.type === 'checkbox' ? label.control : null) ||
      (label.closest('label') && label.closest('label').querySelector('input[type="checkbox"]')) ||
      (label.parentElement && label.parentElement.querySelector('input[type="checkbox"]')) ||
      null;
    if (box && box.checked) return true;
    realClick(box && visible(box) ? box : label);
    await sleep(300);
    return !box || box.checked;
  };

  const attachFile = async (input, file) => {
    const blob = await (await fetch(file.dataUrl)).blob();
    const f = new File([blob], file.name, { type: blob.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const dt = new DataTransfer();
    dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // ---- 안내 창(맨 위 화면만) ----
  // 확장이 연 창(그리고 거기서 뜬 미리보기 창)에서만 움직인다. 사장님이 따로 열어둔 ALPS 창은 건드리지 않는다.
  let myWindowId = null;
  // 미리보기 창이면 그 창을 연 창. 송장 다시 출력 창에서 뜬 미리보기인지 가린다.
  let myOpenerWindowId = null;
  let windowInfoReady = false;
  try {
    chrome.runtime.sendMessage({ type: 'MY_WINDOW' }, (res) => {
      windowInfoReady = true;
      if (chrome.runtime.lastError) return;
      myWindowId = (res && res.windowId) || null;
      myOpenerWindowId = (res && res.openerWindowId) || null;
    });
  } catch (err) {}

  let panel = null;
  let rpPanel = null;
  const render = (p) => {
    if (!IS_TOP) return;
    if (!p || p.hidden) {
      if (panel) panel.remove();
      panel = null;
      return;
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:280px;background:#fff;border:1px solid #d0d7e2;' +
        'border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.15);font:13px/1.5 -apple-system,sans-serif;color:#1f2937;padding:12px;';
      panel.addEventListener('click', (e) => {
        const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'close') {
          try {
            chrome.storage.local.remove(KEY);
          } catch (err) {}
        } else if (act === 'dump') dumpStructure();
        // 운송장 조회가 멈췄을 때: 예약은 다시 올리지 않고 운송장출력 화면의 조회부터 다시 한다.
        // 박스 번호를 다 받아 둔 상태면 출력은 다시 하지 않고 대조만 다시 한다.
        else if (act === 'retry') {
          get().then((cur) => {
            if (!cur) return;
            const all = needOf(cur) && ordList(cur).every((no) => (cur.collected || []).some((c) => c.ordNo === no));
            if (all) patch({ step: 'verify', verifyIdx: 1, verifyBatchDone: false, verifiedOk: [], verifySearchedAt: 0, verifyStartedAt: Date.now(), status: '롯데 목록과 다시 대조하는 중…' });
            else patch({ step: 'waybillPage', status: '롯데 다시 조회하는 중…', searchedAt2: 0, verifySearchedAt: 0, printedAt: null, previewPrintedAt: null });
          });
        }
        // 끝난 건: 기록은 남겨 두고 상자만 닫는다.
        else if (act === 'hide') patch({ hidden: true });
      });
      document.body.appendChild(panel);
    }
    const color = p.step === 'error' ? '#dc2626' : p.step === 'manual' ? '#b45309' : p.step === 'waybills' || p.step === 'uploading' ? '#059669' : '#1d4ed8';
    const btn = 'border:1px solid #d0d7e2;background:#f8fafc;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px;';
    panel.innerHTML = `
      <div style="font-weight:700;margin-bottom:4px">${p.resumed ? '🚚 롯데 송장번호 받기' : '🚚 롯데택배 예약 올리기'}</div>
      <div style="color:#64748b;font-size:12px;margin-bottom:6px">${p.file ? p.file.name : (p.ordNos || []).join(', ')}</div>
      <div style="color:${color};font-size:13px;margin-bottom:8px">${p.status || '진행 중…'}</div>
      <div style="display:flex;gap:6px">
        ${(p.step === 'manual' || (p.step === 'error' && p.uploadedAt)) && p.batchId && p.boxCount ? `<button data-act="retry" style="${btn};border-color:#bfdbfe;background:#eff6ff;color:#1d4ed8" title="예약은 다시 올리지 않고 운송장 조회부터 다시 해요">다시 조회</button>` : ''}
        <button data-act="dump" style="${btn}" title="자동 진행이 안 될 때 화면 구조를 파일로 저장해 보내주세요">화면 구조 저장</button>
        ${p.step === 'waybills' ? `<button data-act="hide" style="${btn};border-color:#bbf7d0;background:#f0fdf4;color:#047857">닫기</button>` : `<button data-act="close" style="${btn};border-color:#fecaca;background:#fff1f2;color:#b91c1c">멈춤</button>`}
      </div>`;
  };

  // 확인용 구조 수집: 프레임마다 자기 화면의 요소 목록을 만든다(다른 주소의 내부 창은 top에서 직접 못 읽으므로
  // top이 물어보면 각 프레임이 답한다).
  const describeSelf = () => ({
    where: IS_TOP ? 'top' : 'frame',
    url: location.href.split('?')[0],
    gridDiag: lastDiag,
    requests: lastReqs,
    lastAlert,
    canvases: Array.from(document.querySelectorAll('canvas')).map((c) => {
      const r = c.getBoundingClientRect();
      return { w: c.width, h: c.height, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], cls: String(c.className || '').slice(0, 60) };
    }),
    elements: Array.from(document.querySelectorAll('a,button,input,select,label,li,span,div,th,td'))
      .filter((el) => el.children.length <= 2 && (clean(el.textContent).length <= 30 || /INPUT|SELECT/.test(el.tagName)))
      .slice(0, 1200)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          text: clean(el.textContent).slice(0, 30),
          type: el.type || '',
          id: el.id || '',
          name: el.name || '',
          cls: String(el.className || '').slice(0, 60),
          box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        };
      }),
  });

  const frameDumps = [];
  window.addEventListener('message', (event) => {
    const d = event.data;
    if (!d || d.source !== 'rocket-lotte-dump') return;
    if (d.type === 'REQUEST' && !IS_TOP) {
      try {
        window.parent.postMessage({ source: 'rocket-lotte-dump', type: 'REPLY', dump: describeSelf() }, '*');
      } catch (err) {}
    }
    if (d.type === 'REPLY' && IS_TOP) frameDumps.push(d.dump);
  });

  // 확인용: 이 화면(같은 사이트 프레임 포함)의 메뉴·버튼·입력칸 목록을 파일로 저장.
  const dumpStructure = async () => {
    // 내부 창들에게 각자 구조를 보내 달라고 하고 잠깐 기다린다.
    frameDumps.length = 0;
    askGridDiag();
    askReqDump();
    const ask = (w) => {
      try {
        w.postMessage({ source: 'rocket-lotte-dump', type: 'REQUEST' }, '*');
      } catch (err) {}
    };
    const walk = (w) => {
      for (let i = 0; i < w.frames.length; i++) {
        ask(w.frames[i]);
        try {
          walk(w.frames[i]);
        } catch (err) {}
      }
    };
    walk(window);
    await sleep(700);
    const docs = [{ where: 'top', doc: document }];
    for (let i = 0; i < window.frames.length; i++) {
      try {
        docs.push({ where: `frame${i}:${window.frames[i].location.href}`, doc: window.frames[i].document });
      } catch (err) {
        docs.push({ where: `frame${i}(접근 불가)`, doc: null });
      }
    }
    const out = docs.map(({ where, doc }) => ({
      where,
      elements: doc
        ? Array.from(doc.querySelectorAll('a,button,input,select,label,li,span,div'))
            .filter((el) => el.children.length <= 2 && (clean(el.textContent).length <= 30 || /INPUT|SELECT/.test(el.tagName)))
            .slice(0, 1500)
            .map((el) => ({
              tag: el.tagName,
              text: clean(el.textContent).slice(0, 30),
              type: el.type || '',
              id: el.id || '',
              name: el.name || '',
              cls: String(el.className || '').slice(0, 60),
            }))
        : [],
    }));
    // 접근이 막힌 내부 창도 주소는 알 수 있게 iframe의 src를 같이 담습니다.
    const iframes = Array.from(document.querySelectorAll('iframe')).map((f) => f.getAttribute('src') || '').map((u) => u.split('?')[0]);
    // 지금 확장이 어느 단계에서 무슨 말을 하고 있는지도 같이 담는다(파일만 보고도 어디서 막혔는지 알 수 있게).
    const state = await get();
    const blob = new Blob(
      [JSON.stringify({ url: location.href.split('?')[0], state, frames: window.frames.length, iframes, docs: out, frameDumps }, null, 2)],
      { type: 'application/json' }
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `롯데ALPS_화면구조_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // 파일을 올린 뒤 화면 안에 뜨는 "안내" 창(성공/실패 건수)을 확인 눌러 닫는다. 브라우저 알림창이 아니라
  // 화면에 그려진 창이라 lotte-hook.js로는 처리되지 않는다.
  const closeUploadResult = () => {
    const msg = findAll(TEXT.uploadDone)[0];
    if (!msg) return false;
    // 안내창 안의 확인 버튼(같은 창 안에서 찾는다).
    let box = msg;
    for (let i = 0; i < 6 && box && box.parentElement; i++) {
      box = box.parentElement;
      const ok = Array.from(box.querySelectorAll('button, a, input[type="button"], span, div')).find(
        (el) => visible(el) && TEXT.ok.test(clean(el.textContent || el.value)) && el.children.length === 0
      );
      if (ok) {
        realClick(ok);
        return true;
      }
    }
    return false;
  };

  // 사이트가 화면 안에 띄우는 안내창(브라우저 alert이 아닌 경우)에서 문구를 읽고 확인을 눌러 닫는다.
  // "출력할 예약관리번호 또는 부분운송장관리번호가 없습니다." 처럼 문장이 길어서, 앞뒤를 넉넉히 잡는다.
  const EMPTY_MSG = /(없습니다|없어요|선택[^.]{0,14}(하세요|해\s*주))/;
  const closeNotice = (re) => {
    const hits = Array.from(document.querySelectorAll('div, span, td, p, label')).filter(
      (el) => visible(el) && el.children.length === 0 && re.test(clean(el.textContent || ''))
    );
    for (const hit of hits) {
      const text = clean(hit.textContent || '');
      let box = hit;
      for (let i = 0; i < 6 && box && box.parentElement; i++) {
        box = box.parentElement;
        const ok = Array.from(box.querySelectorAll('button, a, input[type="button"], span, div')).find(
          (el) => visible(el) && TEXT.ok.test(clean(el.textContent || el.value)) && el.children.length === 0
        );
        // 확인 버튼이 같이 있는 것만 진짜 안내창으로 본다("조회된 데이터가 없습니다" 같은 화면 글자는 넘김).
        if (ok) {
          realClick(ok);
          return text;
        }
      }
    }
    return '';
  };

  // ---- 캔버스 표 다루기 ----
  // 이 목록은 캔버스(그림)로 그려져서 줄도 체크칸도 화면 요소로 존재하지 않는다. 그래서
  //   ① 캔버스 위 좌표에 진짜 마우스 클릭을 보내고
  //   ② 클릭 전후의 그림(픽셀)을 비교해서 정말 눌렸는지, 줄 높이가 얼마인지 스스로 알아낸다.
  // 짐작한 좌표를 쓰지 않고 화면 변화로 확인하므로 화면이 조금 달라도 찾아낸다.
  const gridCanvas = () => {
    let best = null;
    for (const c of document.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect();
      if (r.width > 300 && r.height > 80 && (!best || r.width * r.height > best.r.width * best.r.height)) best = { c, r };
    }
    return best;
  };

  const canvasClick = (el, x, y) => {
    const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    const seq = [
      ['pointerdown', { buttons: 1 }],
      ['mousedown', { buttons: 1 }],
      ['pointerup', { buttons: 0 }],
      ['mouseup', { buttons: 0 }],
      ['click', { buttons: 0 }],
    ];
    for (const [type, extra] of seq) {
      const Ev = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      const init = { ...base, ...extra };
      if (Ev === PointerEvent) Object.assign(init, { pointerId: 1, pointerType: 'mouse', isPrimary: true });
      el.dispatchEvent(new Ev(type, init));
    }
  };

  // 캔버스 그림을 그대로 떠 온다(그리는 방식과 상관없이 읽히도록 다른 캔버스에 옮겨 그린다).
  const canvasSnap = (el) => {
    try {
      const off = document.createElement('canvas');
      off.width = el.width;
      off.height = el.height;
      const ctx = off.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(el, 0, 0);
      return ctx.getImageData(0, 0, off.width, off.height);
    } catch (e) {
      return null;
    }
  };

  // 두 그림에서 달라진 부분의 위치·크기(캔버스 내부 픽셀 기준).
  const diffBox = (a, b) => {
    if (!a || !b || a.width !== b.width || a.height !== b.height) return null;
    const d1 = a.data;
    const d2 = b.data;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, count = 0;
    for (let y = 0; y < a.height; y += 2) {
      for (let x = 0; x < a.width; x += 2) {
        const i = (y * a.width + x) * 4;
        if (Math.abs(d1[i] - d2[i]) + Math.abs(d1[i + 1] - d2[i + 1]) + Math.abs(d1[i + 2] - d2[i + 2]) > 24) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return count ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, count } : null;
  };

  // 목록 맨 아래까지 내린다(마우스 휠).
  const scrollGridToBottom = async (el) => {
    const r = el.getBoundingClientRect();
    for (let i = 0; i < 25; i++) {
      el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 400, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
      await sleep(60);
    }
    await sleep(400);
  };

  // 맨 아래 줄을 왼쪽부터 눌러 보며 "눌리는 칸"과 줄 높이를 찾아낸다. 누른 건 곧바로 한 번 더 눌러 되돌린다.
  const probeGrid = async (canvas) => {
    const r = canvas.getBoundingClientRect();
    const scale = canvas.width / r.width || 1;
    let before = canvasSnap(canvas);
    if (!before) return { error: '표 그림을 읽지 못했어요' };
    const hits = [];
    for (let xOff = 16; xOff <= 220; xOff += 8) {
      const x = r.left + xOff;
      const y = r.bottom - 8;
      canvasClick(canvas, x, y);
      await sleep(140);
      const after = canvasSnap(canvas);
      const box = diffBox(before, after);
      if (box && box.count > 3) {
        const rowH = box.h / scale;
        const rowTop = r.top + box.y / scale;
        if (rowH > 12 && rowH < 70) hits.push({ xOff, rowH, rowTop });
        // 되돌리기(체크였다면 해제).
        canvasClick(canvas, x, y);
        await sleep(140);
        before = canvasSnap(canvas) || after;
      } else {
        before = after || before;
      }
      if (hits.length >= 4) break;
    }
    return { hits, scale };
  };

  // 찾은 칸으로 맨 아래 need줄을 체크한다. 누를 때마다 그림이 바뀌는지 확인한다.
  const checkLastRowsByPixels = async (canvas, hit, need) => {
    const r = canvas.getBoundingClientRect();
    let before = canvasSnap(canvas);
    let done = 0;
    for (let i = 0; i < need; i++) {
      const y = hit.rowTop + hit.rowH / 2 - i * hit.rowH;
      if (y < r.top + hit.rowH) break;
      canvasClick(canvas, r.left + hit.xOff, y);
      await sleep(180);
      const after = canvasSnap(canvas);
      if (diffBox(before, after)) done++;
      before = after || before;
    }
    return done;
  };

  // 입력칸에 값을 넣는다(사이트가 알아채도록 실제 입력처럼).
  const setVal = (el, v) => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // 이름표(예: 검색조건, 운송장종류) 오른쪽의 드롭다운 다루기.
  // 진짜 <select>일 수도, 화면 라이브러리의 가짜 드롭다운(입력칸)일 수도 있고,
  // 고른 값이 글자가 아니라 입력칸의 value로 들어 있어서 tagName을 보고 나눠 읽는다.
  const isTextBox = (el) => el.tagName === 'INPUT' && (el.type || 'text') === 'text';
  const comboNear = (labelRe, optRe) => {
    const label = find(labelRe);
    if (label) {
      const lr = label.getBoundingClientRect();
      const midY = lr.top + lr.height / 2;
      const near = Array.from(document.querySelectorAll('select, input'))
        .filter((el) => visible(el) && el.name !== 'edtSrchCondVal' && (el.tagName === 'SELECT' || isTextBox(el)))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.left >= lr.right - 6 && Math.abs(r.top + r.height / 2 - midY) < 20;
        })
        .sort((x, y) => x.getBoundingClientRect().left - y.getBoundingClientRect().left);
      if (near[0]) return near[0];
    }
    // 예비: 찾는 선택지를 가진 진짜 드롭다운.
    return (
      Array.from(document.querySelectorAll('select')).find(
        (s2) => visible(s2) && Array.from(s2.options).some((o) => optRe.test(clean(o.textContent)))
      ) || null
    );
  };

  const comboShown = (el) => {
    if (!el) return '';
    if (el.tagName === 'SELECT') return clean(el.options[el.selectedIndex] ? el.options[el.selectedIndex].textContent : el.value);
    return clean(el.value);
  };

  // 왜 실패했는지 화면에 남기려고 후보를 짧게 적어 둔다.
  let condWhy = '';

  // 드롭다운을 눌러 펼친 목록에서 고를 글자를 찾는다. 화면 다른 곳에도 같은 글자("주문번호", "운송장번호")가 있어서
  // (10/14: 화면 왼쪽의 "주문번호" 글자를 눌러 검색조건이 안 바뀌고 멈춘 일) 드롭다운 바로 위아래에 펼쳐진 것만 본다.
  const optionsNear = (el, optRe) => {
    const er = el.getBoundingClientRect();
    return findAll(optRe)
      .filter((x) => x !== el && visible(x) && x.children.length === 0 && !/^(LABEL|TH)$/.test(x.tagName))
      .filter((x) => {
        const r = x.getBoundingClientRect();
        const below = r.top >= er.bottom - 4 && r.top <= er.bottom + 320;
        const above = r.bottom <= er.top + 4 && r.bottom >= er.top - 320;
        return (below || above) && r.left < er.right + 30 && r.right > er.left - 30;
      })
      .sort((x, y) => Math.abs(x.getBoundingClientRect().top - er.bottom) - Math.abs(y.getBoundingClientRect().top - er.bottom));
  };

  const pickCombo = async (labelRe, optRe) => {
    let el = comboNear(labelRe, optRe);
    condWhy = el ? `지금 값 "${comboShown(el)}"` : '칸을 못 찾음';
    if (!el) return false;
    if (optRe.test(comboShown(el))) return true; // 이미 골라져 있음

    if (el.tagName === 'SELECT') {
      const opt = Array.from(el.options).find((o) => optRe.test(clean(o.textContent)));
      if (!opt) return false;
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(400);
      return optRe.test(comboShown(comboNear(labelRe, optRe)));
    }

    // 목록이 늦게 펼쳐질 수 있어 기다리는 시간을 늘려 가며 세 번까지 해 본다.
    for (let attempt = 0; attempt < 3; attempt++) {
      el = comboNear(labelRe, optRe) || el;
      // 입력칸 → (안 펼쳐지면) 옆의 화살표 단추 순서로 눌러 본다.
      const openers = [el, el.parentElement && el.parentElement.querySelector('button, .btn, [class*="arrow"], [class*="trigger"]')].filter(Boolean);
      let item = null;
      for (const op of openers) {
        realClick(op);
        for (let t = 0; t < 4 + attempt * 2 && !item; t++) {
          await sleep(250);
          item = optionsNear(el, optRe)[0] || null;
        }
        if (item) break;
      }
      if (item) {
        realClick(item);
        await sleep(500);
      }
      const now = comboNear(labelRe, optRe);
      if (now && optRe.test(comboShown(now))) return true;
      condWhy = now ? `지금 값 "${comboShown(now)}"${item ? '' : ', 목록이 안 펼쳐짐'}` : '칸이 사라짐';
      await sleep(300 + attempt * 300);
    }
    return false;
  };

  const pickOrderNoCond = () => pickCombo(TEXT.condLabel, TEXT.ordNoOption);

  // 목록에 1건만 있을 때, 그 줄의 체크칸을 눌러 본다(머리줄 바로 아래 첫 줄).
  // 목록에 우리 1건만 남겨 둔 상태이므로, 머리줄의 전체선택을 눌러도 우리 것만 체크된다.
  const clickAt = async (xOff, yOff) => {
    const g = gridCanvas();
    if (!g) return false;
    const r = g.c.getBoundingClientRect();
    canvasClick(g.c, r.left + xOff, r.top + yOff);
    await sleep(300);
    return true;
  };

  // 혹시 표가 진짜 화면 요소로 그려졌다면 체크박스를 바로 누른다.
  const clickDomCheckbox = async () => {
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(visible);
    const target = boxes.find((b) => {
      const r = b.getBoundingClientRect();
      return r.top > 300 && !b.checked; // 조회조건 영역(위쪽)의 체크박스는 건드리지 않는다
    });
    if (!target) return false;
    realClick(target);
    await sleep(300);
    return !!target.checked;
  };

  const clickFirstRow = async (xOff) => {
    const g = gridCanvas();
    if (!g) return false;
    const r = g.c.getBoundingClientRect();
    canvasClick(g.c, r.left + xOff, r.top + 42);
    await sleep(300);
    return true;
  };

  // ---- 2단계: 운송장 만들기 ----
  // 이 화면의 목록은 캔버스로 그려져 DOM에서 읽을 수 없다. 그래서 화면이 서버에서 받아오는 목록 데이터를
  // lotte-hook.js가 넘겨주면 거기서 운송장번호·수하인명을 읽는다.
  let gridRows = [];
  // 주문번호(S260930-02-1) → 목록에서 마지막으로 본 그 줄의 운송장번호. 앱이 올린 주문번호 모양만 모은다.
  // 로켓 앱은 S260930-02-1, 윙발주는 W261114-153012-1(날짜-시분초-순번).
  const ORD_RE = /^(S\d{6}-\d{2}|W\d{6}-\d{6})-\d+$/;
  const byOrder = new Map();
  // 몇 번째 박스의 주문번호·박스 수. 앱의 "이어서 하기"는 남은 박스의 주문번호(ordNos)만 넘긴다(S…-2만 남을 수도 있다).
  const ordAt = (p, i) => (Array.isArray(p.ordNos) && p.ordNos.length ? String(p.ordNos[i - 1] || '') : `${p.batchId || ''}-${String(i).padStart(3, '0')}`);
  const ordList = (p) => Array.from({ length: needOf(p) }, (_, i) => ordAt(p, i + 1));
  const needOf = (p) => (Array.isArray(p.ordNos) && p.ordNos.length ? p.ordNos.length : Number(p.boxCount) || 0);
  // 운송장번호는 12자리(2617-2863-6993). 관리번호(8083607009, 10자리)와 헷갈리지 않게 12자리만 인정한다.
  const WAYBILL_RE = /^\d{4}-?\d{4}-?\d{4}$/;
  const asWaybill = (v) => {
    const t = String(v == null ? '' : v).replace(/[^\d-]/g, '');
    return WAYBILL_RE.test(t) ? t : '';
  };
  // 줄에서 운송장번호 찾기: 이름에 inv가 든 칸 중 값이 운송장번호 모양인 것 → 없으면 아무 칸이나 모양이 맞는 것.
  const rowWaybill = (r) => {
    for (const [k, v] of Object.entries(r)) {
      if (!/inv/i.test(k) || /sub|mnip|prev|bfr|typ|knd|cnt/i.test(k)) continue;
      const w = asWaybill(v);
      if (w) return w;
    }
    for (const [k, v] of Object.entries(r)) {
      if (/tel|phone|hp|mobile/i.test(k)) continue; // 안심번호도 12자리
      const w = asWaybill(v);
      if (w) return w;
    }
    return '';
  };
  // 한 줄 안의 운송장 모양 번호를 칸 이름과 함께 모두 꺼낸다. 롯데 데이터에는 이 건의 번호 말고
  // "다음에 발급할 번호" 같은 칸도 같이 오는 것으로 보여서(앱에 늘 한 칸 뒤 번호가 들어왔다),
  // 이 건의 번호는 칸 이름이 정확히 운송장번호(invNo 등)인 것만 쓴다.
  const waybillCandidates = (raw) => {
    const out = [];
    for (const [k, v] of Object.entries(raw || {})) {
      // 안심번호(0502-1234-5678)도 12자리라 운송장번호 모양이다. 전화 칸은 빼야 발급 전 줄을 "번호 없음"으로 본다(11/16 한나푸드 -23).
      if (/tel|phone|hp|mobile/i.test(k)) continue;
      const w = asWaybill(v);
      if (w && !out.some((c) => c.w.replace(/-/g, '') === w.replace(/-/g, ''))) out.push({ k, w });
    }
    return out;
  };
  // 칸 이름이 정확히 "운송장번호"(invNo·INV_NO 등)인 칸의 번호만 쓴다. 번호 모양 칸이 하나뿐이어도 이름이 다르면 쓰지 않는다.
  const EXACT_KEY = /^(inv|invc|invoice)_?no$/i;
  const pickOwnWaybill = (raw) => {
    const cands = waybillCandidates(raw);
    if (!cands.length) return { w: '', why: '' };
    if (cands.length === 1) {
      return EXACT_KEY.test(cands[0].k) ? { w: cands[0].w, why: cands[0].k } : { w: '', why: `칸 이름 불확실(${cands[0].k}=${cands[0].w})` };
    }
    // 여러 개면 칸 이름이 정확히 "운송장번호"(invNo·INV_NO 등)인 것이 딱 하나일 때만 쓴다. 아니면 멈추고 알린다.
    const exact = cands.filter((c) => EXACT_KEY.test(c.k));
    const list = cands.map((c) => `${c.k}=${c.w}`).join(', ');
    if (exact.length === 1) return { w: exact[0].w, why: `${exact[0].k} (후보 ${list})` };
    return { w: '', why: `칸 이름 불확실(후보 ${list})` };
  };
  const pickRows = (json) => {
    const found = [];
    const walk = (node, depth) => {
      if (!node || depth > 6) return;
      if (Array.isArray(node)) {
        const rows = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
        if (rows.length) {
          const sample = rows[0];
          const hasInv = Object.keys(sample).some((k) => /inv/i.test(k));
          const recvKey = Object.keys(sample).find((k) => /acper|acpt|rcv|recv|수하인/i.test(k) && /nm|name|명/i.test(k));
          if (hasInv || recvKey) {
            rows.forEach((r) => {
              const waybill = rowWaybill(r);
              const receiver = String((recvKey && r[recvKey]) || '').trim();
              if (receiver || waybill) found.push({ waybill, receiver, raw: r });
            });
          }
        }
        node.forEach((x) => walk(x, depth + 1));
        return;
      }
      if (typeof node === 'object') Object.values(node).forEach((v) => walk(v, depth + 1));
    };
    walk(json, 0);
    return found;
  };

  window.addEventListener('message', (event) => {
    const d = event.data;
    if (event.source !== window || !d || d.source !== 'rocket-lotte-hook') return;
    if (d.type === 'JSON') {
      try {
        const rows = pickRows(JSON.parse(d.text));
        if (rows.length) gridRows = rows;
        // 목록 줄(주문번호 S260930-02-1 이 적힌 줄)은 따로 모아 둔다. 화면에는 "다음에 발급할 운송장번호"
        // 칸 같은 다른 데이터도 오는데, 그게 gridRows를 덮어써도 주문번호별 번호는 여기서 정확히 읽는다.
        const at = Date.now();
        // 같은 데이터에 같은 줄이 두 번 오기도 해서 주문번호마다 번호를 모아 본다. 서로 다른 번호가 둘 이상이면
        // (같은 주문번호로 예약이 두 번 들어감) 어느 것도 믿지 않는다.
        const inThis = new Map();
        for (const r of rows) {
          const ord = Object.values(r.raw || {}).map((v) => String(v == null ? '' : v).trim()).find((v) => ORD_RE.test(v));
          if (!ord) continue;
          const own = pickOwnWaybill(r.raw);
          const e = inThis.get(ord) || { nums: new Set(), own: null, why: '', receiver: r.receiver };
          if (own.w) {
            e.nums.add(own.w.replace(/-/g, ''));
            if (!e.own) e.own = own;
          } else if (!e.why) e.why = own.why;
          inThis.set(ord, e);
        }
        inThis.forEach((e, ord) => {
          const waybill = e.nums.size > 1
            ? { w: '', why: `같은 주문번호 줄이 ${e.nums.size}개(${Array.from(e.nums).join(', ')})` }
            : e.own || { w: '', why: e.why };
          byOrder.set(ord, { waybill, receiver: e.receiver, at });
        });
      } catch (err) {}
    }
    if (d.type === 'CHECK_LAST_RESULT') {
      checkResult = d;
      if (d.candidates) lastDiag = d.candidates;
    }
    if (d.type === 'GRID_DIAG_RESULT') lastDiag = d.candidates || [];
    if (d.type === 'REQ_DUMP_RESULT') lastReqs = d.reqs || [];
    if (d.type === 'AUTO_ALERT' || d.type === 'AUTO_CONFIRM') lastAlert = { text: String(d.text || ''), at: Date.now() };
    if (d.type === 'OPEN') lastOpen = { url: String(d.url || ''), blocked: !!d.blocked, at: Date.now() };
    if (d.type === 'PRINT_DIAG_RESULT') printDiag = d;
  });
  let checkResult = null;
  // 표 객체 후보 목록(확인용). 화면 구조 저장 파일에 같이 담아 어떤 객체가 표를 그리는지 파악한다.
  let lastDiag = null;
  // 이 화면이 서버로 보낸 요청들(출력 요청 모양 파악용).
  let lastReqs = null;
  // 사이트가 띄운 알림 문구(예: "출력할 내용이 없습니다"). 체크가 됐는지 판단하는 데 쓴다.
  let lastAlert = null;
  // 사이트가 새 창(미리보기)을 열려고 한 기록. blocked면 크롬 팝업차단에 막힌 것.
  let lastOpen = null;
  // 출력 버튼을 눌렀을 때 페이지에서 실제로 무슨 일이 있었는지(클릭 도달·폼 전송·요청).
  let printDiag = null;
  const askPrintDiag = () => window.postMessage({ source: 'rocket-lotte-panel', type: 'PRINT_DIAG' }, '*');
  const printDiagText = async () => {
    printDiag = null;
    askPrintDiag();
    await sleep(500);
    const d = printDiag;
    if (!d) return '진단 응답 없음';
    const click = d.lastClick ? `클릭 ${d.lastClick.target}` : '클릭 안 닿음';
    const form = d.lastSubmit ? `폼 ${d.lastSubmit.target || '_self'}` : '폼 없음';
    const open = lastOpen ? (lastOpen.blocked ? '창 막힘' : `창 ${lastOpen.url.slice(0, 30) || '(빈주소)'}`) : '창 없음';
    return `${click} · ${form} · ${open} · 요청 ${(d.reqs || []).join(' | ') || '없음'}`;
  };
  // 캔버스 클릭은 한 번에 여러 초가 걸려서, 주기 실행이 겹치지 않게 막는다.
  let canvasBusy = false;
  let wbWaitSince = 0;
  const askReqDump = () => window.postMessage({ source: 'rocket-lotte-panel', type: 'REQ_DUMP' }, '*');

  const askGridDiag = () => window.postMessage({ source: 'rocket-lotte-panel', type: 'GRID_DIAG' }, '*');
  const askCheckLast = (need) => {
    checkResult = null;
    window.postMessage({ source: 'rocket-lotte-panel', type: 'CHECK_LAST', need }, '*');
  };


  // 표에서 "칸 이름 → 몇 번째 칸"을 찾고, 줄마다 값을 읽습니다. 화면 표가 제목/내용이 따로 그려질 수 있어
  // 제목 줄을 찾은 뒤 같은 묶음에서 칸 수가 비슷한 줄을 내용으로 봅니다.
  // 표가 <table>이 아닐 때: "운송장번호"·"수하인명" 제목 글자의 가로 위치를 기준으로, 그 아래 글자들을 줄(세로 위치)
  // 별로 묶어 읽는다.
  const readGridByPosition = () => {
    const heads = {};
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length) continue;
      const t = clean(el.textContent);
      if (!TEXT.waybillCol.test(t) && !TEXT.receiverCol.test(t)) continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const key = TEXT.waybillCol.test(t) ? 'waybill' : 'receiver';
      if (!heads[key]) heads[key] = r;
    }
    if (!heads.waybill || !heads.receiver) return null;
    const headBottom = Math.max(heads.waybill.bottom, heads.receiver.bottom);
    const inCol = (r, h) => r.left < h.right + 12 && r.right > h.left - 12;
    const rows = new Map();
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length || (panel && panel.contains(el))) continue;
      const t = clean(el.textContent);
      if (!t || !visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top < headBottom) continue;
      const line = Math.round(r.top / 8);
      const row = rows.get(line) || { waybill: '', receiver: '' };
      if (inCol(r, heads.waybill) && /^[\d-]{6,}$/.test(t)) row.waybill = t;
      else if (inCol(r, heads.receiver) && t.length <= 20) row.receiver = t;
      rows.set(line, row);
    }
    const out = Array.from(rows.values()).filter((r) => r.receiver);
    return out.length ? out : null;
  };

  const readWaybillRows = () => {
    const header = Array.from(document.querySelectorAll('tr')).find((tr) => {
      const t = clean(tr.textContent);
      return TEXT.waybillCol.test('운송장번호') && /운송장번호/.test(t) && /수하인명/.test(t);
    });
    if (!header) return readGridByPosition();
    const names = Array.from(header.querySelectorAll('th,td')).map((c) => clean(c.textContent));
    const iWay = names.findIndex((n) => TEXT.waybillCol.test(n));
    const iRecv = names.findIndex((n) => TEXT.receiverCol.test(n));
    if (iWay < 0 || iRecv < 0) return readGridByPosition();
    let scope = header.closest('table');
    for (let i = 0; i < 4 && scope && scope.parentElement; i++) {
      scope = scope.parentElement;
      if (scope.querySelectorAll('tr').length > 2) break;
    }
    const rows = [];
    for (const tr of (scope || document).querySelectorAll('tr')) {
      if (tr === header || tr.querySelector('th')) continue;
      const cells = Array.from(tr.querySelectorAll('td')).map((td) => clean(td.textContent));
      if (cells.length < names.length - 2) continue;
      const waybill = (cells[iWay] || '').replace(/[^\d-]/g, '');
      const receiver = cells[iRecv] || '';
      if (!receiver) continue;
      rows.push({ waybill, receiver });
    }
    return rows.length ? rows : readGridByPosition();
  };

  // 운송장 목록 화면인지: 표를 못 읽어도 "집하일자"·"운송장번호" 같은 글자로 알아본다.
  const isWaybillScreen = () =>
    !!find(TEXT.waybillCol) || !!find(/^집하일자$/) || /PIDPIC002U/i.test(location.href);

  // 미리보기 창(pid.alps.llogis.com): 출력 버튼 → 알림창 자동 확인 → 왼쪽 관리번호를 하나씩 눌러 번호 발급.
  // 미리보기 창의 왼쪽 "운송장종류"는 캔버스로 그려진 목록이라 글자로 누를 수 없다.
  //   1 표준라벨D / 2 표준라벨E / 3 표준라벨4P …
  // 그래서 첫 줄을 누른 뒤 아래 화살표를 한 번 보내 2번(표준라벨E)에 맞춘다.
  // 캔버스 그림을 읽어 가로 줄금(줄과 줄 사이 선)의 y를 찾는다. 이걸로 "몇 번째 줄"을 계산한다.
  const rowLines = (el) => {
    const img = canvasSnap(el);
    if (!img) return null;
    const { data, width, height } = img;
    const scan = Math.min(width, 160); // 왼쪽(번호 칸) 쪽만 본다
    const lines = [];
    for (let y = 1; y < height; y++) {
      let dark = 0;
      for (let x = 2; x < scan; x += 2) {
        const i = (y * width + x) * 4;
        if (data[i] < 215 && data[i + 1] < 215 && data[i + 2] < 215) dark += 1;
      }
      if (dark > scan / 4) lines.push(y);
    }
    // 붙어 있는 y들은 한 줄금으로 묶는다.
    const merged = [];
    for (const y of lines) {
      if (!merged.length || y - merged[merged.length - 1] > 3) merged.push(y);
      else merged[merged.length - 1] = y;
    }
    return merged;
  };

  const pickLabelE = async () => {
    // 혹시 화면 요소로 되어 있으면 글자가 딱 맞는 줄을 바로 누른다.
    const exact = findAll(TEXT.labelE).find((el) => clean(el.textContent) === '표준라벨E');
    if (exact) {
      realClick(exact);
      await sleep(400);
      return '표준라벨E 클릭';
    }
    const list = Array.from(document.querySelectorAll('canvas'))
      .map((c) => ({ c, r: c.getBoundingClientRect() }))
      .filter((x) => x.r.width > 120 && x.r.height > 100)
      .sort((a, b) => a.r.left - b.r.left)[0];
    if (!list) return '목록 못 찾음';

    const dpr = list.c.width / Math.max(1, list.r.width); // 캔버스 내부 좌표 ÷ 화면 좌표
    const lines = rowLines(list.c) || [];
    // 줄금 사이 간격 중 가장 흔한 값 = 줄 높이.
    const gaps = [];
    for (let i = 1; i < lines.length; i++) gaps.push(lines[i] - lines[i - 1]);
    const rowH = gaps.filter((g) => g > 8 * dpr).sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || 0;
    // 머리줄(운송장종류) 아래 첫 줄금이 1번 줄의 위쪽 선.
    const firstTop = lines.find((y) => y > 10 * dpr);

    // 왼쪽 번호 칸(숫자 2)을 누른다.
    const x = list.r.left + 14;
    if (firstTop && rowH) {
      const y = list.r.top + (firstTop + rowH * 1.5) / dpr; // 2번째 줄 한가운데
      canvasClick(list.c, x, y);
      await sleep(400);
      return `2번 줄 클릭(줄높이 ${Math.round(rowH / dpr)})`;
    }
    // 줄금을 못 읽으면 흔한 크기로 어림잡는다.
    canvasClick(list.c, x, list.r.top + 62);
    await sleep(400);
    return '2번 줄 어림 클릭';
  };

  // 미리보기 창: 왼쪽 "운송장종류"를 표준라벨E로 고른 뒤 오른쪽 위 "출력"을 누른다.
  let previewSeenAt = 0;
  const runPreviewWindow = async (p) => {
    if (!p.previewPrintedAt) {
      // 미리보기 창이 다 그려지기 전에 누르면 클릭이 안 먹어 발급이 안 된다(10/20 S261020-01). 뜬 뒤 3초는 기다린다.
      if (!previewSeenAt) previewSeenAt = Date.now();
      if (document.readyState !== 'complete' || Date.now() - previewSeenAt < 3000) return;
      const how = await pickLabelE();
      // 운송장종류 목록을 아직 못 찾았으면 누르지 않고 다음 차례에 다시 본다.
      if (how === '목록 못 찾음' && Date.now() - previewSeenAt < 20000) return;
      const printBtn = findAll(TEXT.print).find((el) => el.closest('button, a, [role="button"], span')) || find(TEXT.print);
      if (!printBtn) return;
      await patch({
        previewPrintedAt: Date.now(),
        status: `미리보기 출력 중… (운송장종류: ${how})`,
      });
      realClick(printBtn);
      return;
    }
    // 출력 뒤 롯데가 발급을 마칠 시간을 넉넉히 준다(5초 만에 닫아서 발급이 안 된 일이 있었다).
    if (Date.now() - p.previewPrintedAt < 12000) return;
    await patch({ step: 'waybillDone', status: '운송장 출력 완료. 번호를 가져오는 중…' });
    await sleep(500);
    window.close();
  };

  // ---- 진행 ----
  let busy = false;
  let lastMenuClick = 0;
  // 이 창이 송장 다시 출력 것이면 기존 안내 창을 띄우지 않는다.
  let rpOwnsCache = false;

  // 출력을 누르면 "출력의심목록"(전에 출력됐을 수 있는 운송장) 창이 뜰 때가 있다. 그대로 두면 미리보기가 안 열린다.
  // "운송장 출력이 되지 않았…"(다시 출력)을 고르고 적용을 눌러 출력이 이어지게 한다. 처리했으면 true.
  const handleSuspect = async () => {
    if (!find(/^출력의심\s*목록$/) && !find(/^출력의심\s*운송장\s*목록$/)) return false;
    const label = findAll(/출력이\s*되지/).pop();
    if (label) {
      let radio = null;
      for (let box = label, i = 0; i < 4 && box && !radio; i++, box = box.parentElement) {
        radio = box.querySelector('input[type="radio"]');
      }
      realClick(radio && !radio.checked ? radio : label);
      await sleep(400);
    }
    const apply = findAll(/^적용$/).pop();
    if (!apply) return false;
    realClick(apply);
    await sleep(2500);
    return true;
  };

  const tick = async () => {
    if (busy) return;
    rpOwnsCache = await reprintOwnsThisWindow();
    if (rpOwnsCache) {
      if (IS_TOP && panel) render(null);
      return;
    }
    const p = await get();
    if (IS_TOP) render(p);
    // 올리기 시작한 뒤 일괄주문접수 화면이 새로 떴다 = 서버가 파일을 받았다 → 끝(창 닫기 신호).
    if (p && p.step === 'uploading' && !IS_PREVIEW) {
      // 결과 안내창이 떠 있으면 확인을 누르고 다음 단계로.
      if (closeUploadResult()) {
        await patch({ step: 'uploaded', uploadedAt: Date.now(), status: '택배 예약 완료. 운송장 만드는 중…' });
        return;
      }
      // 화면이 새로 떴거나(다른 프레임) 10초가 지나면 올리기가 끝난 것으로 본다.
      const moved = !IS_TOP && p.uploaderFrame !== FRAME_ID && find(TEXT.userFile);
      if (moved || Date.now() - (p.uploadingAt || 0) > 10000) {
        await patch({ step: 'uploaded', uploadedAt: Date.now(), status: '택배 예약 완료. 운송장 만드는 중…' });
        return;
      }
    }
    if (!p || DONE_STEPS.includes(p.step)) return;
    // 자동 진행 중에는 "설치가 필요합니다" 같은 알림창을 lotte-hook.js가 자동으로 확인 처리합니다.
    document.documentElement.setAttribute('data-rocket-auto-confirm', '1');
    // 운송장은 박스마다 하나씩 출력해 박스당 1분 가까이 걸린다. 박스가 많으면 10분으론 모자라 박스 수만큼 늘린다.
    if (Date.now() - (p.savedAt || 0) > MAX_AGE_MS + needOf(p) * 90 * 1000) {
      if (IS_TOP) await patch({ step: 'error', status: '시간이 너무 오래 걸려 멈췄어요. 앱에서 다시 눌러주세요.' });
      return;
    }
    if (!IS_PREVIEW && p.windowId && myWindowId && p.windowId !== myWindowId) return;

    busy = true;
    try {
      // 로그인 화면이면 사람이 로그인할 때까지 기다립니다.
      // 로그인 화면은 로그인 주소일 때만으로 봅니다. 로그인된 화면에도 숨은 비밀번호 칸(개인정보변경 창)이 있어서
      // 비밀번호 칸만 보고 판단하면 잘못 알아봅니다.
      const onLoginPage = /\/sec\/|login|auth/i.test(location.pathname) && !find(TEXT.menu);
      const pw = onLoginPage ? Array.from(document.querySelectorAll('input[type="password"]')).find(visible) : null;
      if (pw) {
        await tryLogin(p, pw);
        return;
      }

      // ---- 2단계: 운송장 만들기 ----
      // 미리보기 창에서는 출력·관리번호 클릭만 한다.
      if (IS_PREVIEW) {
        // 다른 창(예: 송장 다시 출력 창)이 연 미리보기는 건드리지 않는다.
        if (myOpenerWindowId && p.windowId && myOpenerWindowId !== p.windowId) return;
        if (['uploaded', 'waybillMenu', 'waybillPage', 'preview'].includes(p.step)) await runPreviewWindow(p);
        return;
      }

      // 운송장 목록 화면: 조회 → 맨 아래 예약분 체크 → 출력(미리보기 창이 뜸). 미리보기가 끝나면 번호를 읽는다.
      const isWaybillList = isWaybillScreen();
      if (isWaybillList && ['waybillPage', 'preview', 'waybillDone', 'verify'].includes(p.step)) {
        if (p.step === 'waybillDone') {
          const idx = Number(p.boxIdx) || 1;
          const need = needOf(p) || 1;
          const ordNo = ordAt(p, idx);
          // 이 박스의 주문번호로 다시 조회해서 발급된 운송장번호를 읽는다.
          if (Date.now() - (p.searchedAt2 || 0) > 5000) {
            const search2 = find(TEXT.search);
            if (search2) realClick(search2);
            await patch({ searchedAt2: Date.now(), status: `${ordNo} 운송장번호 가져오는 중…` });
            return;
          }
          // 목록(통합관리 운송장출력 표)에서 이 박스의 주문번호 줄에 적힌 운송장번호만 쓴다.
          // 화면 가운데 "운송장번호" 칸은 롯데가 다음에 발급할 번호라서(예전에 앱이 이걸 읽어 늘 한 칸 뒤
          // 번호가 들어갔다) 절대 쓰지 않는다. 다시 조회한 뒤에 들어온 목록만 믿는다.
          const seen = byOrder.get(ordNo);
          if (seen && seen.at >= (p.searchedAt2 || 0) && !seen.waybill.w && /칸 이름 불확실/.test(seen.waybill.why)) {
            await patch({ step: 'manual', status: `⛔ 롯데 ${ordNo} 줄에서 송장번호 칸을 정확히 못 찾아 넣지 않았어요. 롯데 화면 구조가 바뀐 것 같아요. [화면 구조 저장]을 눌러 파일을 보내 주세요.`, diag: seen.waybill.why });
            return;
          }
          if (seen && seen.at >= (p.searchedAt2 || 0) && !seen.waybill.w && /같은 주문번호 줄/.test(seen.waybill.why)) {
            await patch({ step: 'manual', status: `⛔ 롯데에 ${ordNo} 줄이 여러 개(같은 주문번호로 예약이 두 번)라 어느 송장번호인지 몰라서 넣지 않았어요. 롯데에서 겹친 예약을 지운 뒤 앱에서 "이어서 하기"를 눌러 주세요.`, diag: seen.waybill.why });
            return;
          }
          // 목록에 이 주문번호 줄은 있는데 운송장번호 칸이 비어 있으면: 출력(발급)이 롯데에서 안 된 것이다.
          // 짐작해서 넣지 않고, 출력부터 다시 한다(두 번까지). 그래도 안 되면 사람에게 넘긴다.
          if (seen && seen.at >= (p.searchedAt2 || 0) && !seen.waybill.w && !seen.waybill.why && Date.now() - (p.printedAt || 0) > 30000) {
            const tries = Number(p.reprintTries) || 0;
            if (tries < 2) {
              await patch({
                step: 'waybillPage', reprintTries: tries + 1, printedAt: null, previewPrintedAt: null, searchedAt2: 0,
                status: `${ordNo} 운송장이 발급되지 않아서 다시 출력해요… (${tries + 1}/2)`,
              });
              return;
            }
            await patch({ step: 'manual', status: `⛔ ${ordNo} 운송장을 두 번 다시 출력했는데도 발급이 안 됐어요. 롯데 미리보기 창에서 직접 [출력]을 눌러 주신 뒤 앱에서 "이어서 하기"를 눌러 주세요.` });
            return;
          }
          const fresh = seen && seen.at >= (p.searchedAt2 || 0) && seen.waybill.w;
          const usedByOthers = new Set((p.collected || []).filter((c) => c.ordNo !== ordNo).map((c) => String(c.waybill).replace(/-/g, '')));
          if (!fresh || usedByOthers.has(seen.waybill.w.replace(/-/g, ''))) {
            // 오래 기다려도 이 주문번호 줄의 번호가 안 보이면 추측해서 넣지 않고 사람에게 넘긴다.
            if (Date.now() - (p.printedAt || 0) > 60000) {
              await patch({ step: 'manual', status: `${ordNo}의 송장번호가 롯데 목록에 아직 안 보여요. 이 창 아래 [다시 조회]를 눌러 주세요.` });
              return;
            }
            // 조회 결과가 아직 안 왔다. 조금 뒤 다시 조회한다.
            if (Date.now() - (p.searchedAt2 || 0) > 4000) await patch({ searchedAt2: 0, status: `${ordNo} 줄을 찾는 중…` });
            return;
          }
          const own = seen.waybill;
          const row = { waybill: own.w, receiver: seen.receiver };
          const collected = [...(p.collected || []).filter((c) => c.ordNo !== ordNo), { ordNo, waybill: row.waybill, receiver: row.receiver || '', from: own.why }];

          // 아직 남은 박스가 있으면 다음 박스로. 없으면 끝.
          if (idx < need) {
            await patch({
              step: 'waybillPage',
              boxIdx: idx + 1,
              collected,
              previewPrintedAt: null,
              printedAt: null,
              searchedAt2: 0,
              status: `박스 ${idx}/${need} 완료(${row.waybill} · ${own.why}). 다음 박스 시작…`,
            });
            return;
          }
          // 다 모았으면 바로 넘기지 않고, 주문번호마다 목록을 한 번 더 조회해 같은 번호인지 스스로 대조한다.
          await patch({
            step: 'verify', verifyIdx: 1, verifyBatchDone: false, verifiedOk: [], verifySearchedAt: 0, verifyStartedAt: Date.now(), collected,
            status: `운송장번호 ${collected.length}건을 모았어요. 롯데 목록과 한 번 더 대조하는 중…`,
          });
          return;
        }

        // 대조: 주문번호로 다시 조회 → 그 줄의 운송장번호가 모아 둔 번호와 같은지 본다. 모두 같아야만 앱으로 넘긴다.
        if (p.step === 'verify') {
          const need = needOf(p) || 1;
          const vIdx = Number(p.verifyIdx) || 1;
          const collected = p.collected || [];
          const ordNo = ordAt(p, vIdx);
          const mine = collected.find((c) => c.ordNo === ordNo);
          const digitsOf = (w) => String(w || '').replace(/\D/g, '');
          const finish = () => patch({
            step: 'waybills', waybills: collected, collected,
            status: `✅ 운송장번호 ${collected.length}건을 가져와 롯데 목록과 대조까지 마쳤어요. ${collected.map((c) => `${c.ordNo}=${c.waybill}`).join(' / ')}`,
          });
          // 1) 예약 번호 앞부분(W…- / S…-)으로 한 번 조회해 모은 박스를 한꺼번에 대조한다. 롯데 검색이 앞부분 일치라
          //    이번 예약 박스가 다 나온다. 박스마다 조회하면 박스 수만큼 오래 걸려서다.
          //    목록에 안 보인 박스만 2)에서 하나씩 대조한다.
          if (!p.verifyBatchDone && p.batchId) {
            const toEach = (ok, why) => patch({
              verifyBatchDone: true, verifiedOk: ok, verifyIdx: 1, verifySearchedAt: 0, verifyStartedAt: Date.now(),
              status: `${why} 나머지는 하나씩 대조해요…`,
            });
            if (Date.now() - (p.verifyStartedAt || 0) > 30000) {
              await toEach([], '예약 번호로 한 번에 조회했는데 목록이 안 떠요.');
              return;
            }
            if (!p.verifySearchedAt) {
              const box = document.querySelector('input[name="edtSrchCondVal"]');
              const search = find(TEXT.search);
              if (!box || !search) return;
              if (!(await pickOrderNoCond())) {
                await patch({ step: 'manual', status: '롯데 화면의 검색조건을 "주문번호"로 바꾸지 못했어요. 이 창 아래 [다시 조회]를 눌러 주세요.', diag: condWhy });
                return;
              }
              setVal(box, `${p.batchId}-`);
              await sleep(300);
              realClick(search);
              await patch({ verifySearchedAt: Date.now(), status: `대조 중 · ${p.batchId} 박스 ${collected.length}개 한 번에 조회…` });
              return;
            }
            const got = collected.map((c) => {
              const s = byOrder.get(c.ordNo);
              return { c, s: s && s.at >= p.verifySearchedAt ? s : null };
            });
            if (!got.some((g) => g.s)) {
              if (Date.now() - p.verifySearchedAt > 6000) await patch({ verifySearchedAt: 0 });
              return;
            }
            // 목록 데이터가 다 들어오도록 조금 더 기다린다.
            if (Date.now() - p.verifySearchedAt < 3000) return;
            for (const { c, s } of got) {
              if (!s) continue;
              if (!s.waybill.w && /칸 이름 불확실/.test(s.waybill.why)) {
                await patch({ step: 'manual', status: `⛔ 롯데 ${c.ordNo} 줄에서 송장번호 칸을 정확히 못 찾아 넣지 않았어요. 롯데 화면 구조가 바뀐 것 같아요. [화면 구조 저장]을 눌러 파일을 보내 주세요.`, diag: s.waybill.why });
                return;
              }
              if (!s.waybill.w && /같은 주문번호 줄/.test(s.waybill.why)) {
                await patch({ step: 'manual', status: `⛔ 롯데에 ${c.ordNo} 줄이 여러 개(같은 주문번호로 예약이 두 번)라 어느 송장번호인지 몰라서 넣지 않았어요. 롯데에서 겹친 예약을 지운 뒤 앱에서 "이어서 하기"를 눌러 주세요.`, diag: s.waybill.why });
                return;
              }
              if (s.waybill.w && digitsOf(s.waybill.w) !== digitsOf(c.waybill)) {
                await patch({ step: 'manual', status: `${c.ordNo}의 송장번호가 조회할 때마다 달라서(${c.waybill} / ${s.waybill.w}) 넣지 않았어요. 이 창 아래 [다시 조회]를 눌러 주세요.` });
                return;
              }
            }
            const ok = got.filter((g) => g.s && g.s.waybill.w).map((g) => g.c.ordNo);
            if (ok.length === collected.length && ok.length >= need) {
              await finish();
              return;
            }
            await toEach(ok, `한 번에 ${ok.length}/${collected.length}건 일치.`);
            return;
          }
          // 2) 한 번에 조회해서 이미 맞춰 본 박스는 건너뛴다.
          if ((p.verifiedOk || []).includes(ordNo)) {
            if (vIdx < need) await patch({ verifyIdx: vIdx + 1, verifySearchedAt: 0 });
            else await finish();
            return;
          }
          if (!mine) {
            await patch({ step: 'manual', status: `${ordNo}의 송장번호를 아직 못 받았어요. 이 창 아래 [다시 조회]를 눌러 주세요.` });
            return;
          }
          if (Date.now() - (p.verifyStartedAt || 0) > 90000) {
            await patch({ step: 'manual', status: `${ordNo}를 다시 조회했는데 롯데 목록이 안 떠요. 이 창 아래 [다시 조회]를 눌러 주세요.` });
            return;
          }
          if (!p.verifySearchedAt) {
            const box = document.querySelector('input[name="edtSrchCondVal"]');
            const search = find(TEXT.search);
            if (!box || !search) return;
            // 사람이 직접 하다 넘어온 경우 검색조건이 "운송장번호"일 수 있다. 주문번호로 맞춘 뒤 조회한다.
            if (!(await pickOrderNoCond())) {
              await patch({ step: 'manual', status: '롯데 화면의 검색조건을 "주문번호"로 바꾸지 못했어요. 이 창 아래 [다시 조회]를 눌러 주세요.', diag: condWhy });
              return;
            }
            setVal(box, ordNo);
            await sleep(300);
            realClick(search);
            await patch({ verifySearchedAt: Date.now(), status: `대조 중 ${vIdx}/${need} · ${ordNo} 다시 조회…` });
            return;
          }
          const seen = byOrder.get(ordNo);
          if (seen && seen.at >= p.verifySearchedAt && !seen.waybill.w && /칸 이름 불확실/.test(seen.waybill.why)) {
            await patch({ step: 'manual', status: `⛔ 롯데 ${ordNo} 줄에서 송장번호 칸을 정확히 못 찾아 넣지 않았어요. 롯데 화면 구조가 바뀐 것 같아요. [화면 구조 저장]을 눌러 파일을 보내 주세요.`, diag: seen.waybill.why });
            return;
          }
          if (seen && seen.at >= p.verifySearchedAt && !seen.waybill.w && /같은 주문번호 줄/.test(seen.waybill.why)) {
            await patch({ step: 'manual', status: `⛔ 롯데에 ${ordNo} 줄이 여러 개(같은 주문번호로 예약이 두 번)라 어느 송장번호인지 몰라서 넣지 않았어요. 롯데에서 겹친 예약을 지운 뒤 앱에서 "이어서 하기"를 눌러 주세요.`, diag: seen.waybill.why });
            return;
          }
          if (!seen || seen.at < p.verifySearchedAt || !seen.waybill.w) {
            // 조회 결과가 아직 안 왔다. 조금 뒤 한 번 더 누른다.
            if (Date.now() - p.verifySearchedAt > 5000) await patch({ verifySearchedAt: 0 });
            return;
          }
          if (digitsOf(seen.waybill.w) !== digitsOf(mine.waybill)) {
            await patch({
              step: 'manual',
              status: `${ordNo}의 송장번호가 조회할 때마다 달라서(${mine.waybill} / ${seen.waybill.w}) 넣지 않았어요. 이 창 아래 [다시 조회]를 눌러 주세요.`,
            });
            return;
          }
          if (vIdx < need) {
            await patch({ verifyIdx: vIdx + 1, verifySearchedAt: 0, status: `대조 ${vIdx}/${need} 일치(${ordNo}=${mine.waybill}). 다음…` });
            return;
          }
          await finish();
          return;
        }

        if (p.step === 'waybillPage') {
          // 화면이 여러 개(일괄주문접수·운송장출력) 떠 있다. "검색조건"이 눈에 보이는 화면에서만 진행한다.
          // (안 보이는 화면의 요소는 크기가 0이라 find가 걸러낸다.)
          if (!find(TEXT.condLabel)) {
            if (!wbWaitSince) wbWaitSince = Date.now();
            if (Date.now() - wbWaitSince > 45000) {
              await patch({ step: 'manual', status: '롯데 운송장출력 화면이 안 열렸어요. 이 창을 닫고 앱에서 "이어서 하기"를 눌러 주세요.' });
            }
            return;
          }
          if (canvasBusy) return;
          canvasBusy = true;
          try {
            const need = needOf(p);
            const batch = String(p.batchId || '');
            if (!need || !batch) {
              await patch({ step: 'error', status: '예약 정보(박스 수·쉽먼트 번호)가 없어 자동 출력을 못 해요.' });
              return;
            }

            // 1) 검색조건을 "주문번호"로 맞춘다.
            await patch({ status: '검색조건을 주문번호로 바꾸는 중…' });
            if (!(await pickOrderNoCond())) {
              await patch({ step: 'manual', status: '롯데 화면의 검색조건을 "주문번호"로 바꾸지 못했어요. 이 창 아래 [다시 조회]를 눌러 주세요.', diag: condWhy });
              return;
            }

            // 2) 지금 차례인 박스의 주문번호로 조회 → 목록에 우리 1건만 남는다.
            const boxIdx = Number(p.boxIdx) || 1;
            const ordNo = ordAt(p, boxIdx);
            const box = document.querySelector('input[name="edtSrchCondVal"]');
            if (!box) {
              await patch({ step: 'manual', status: '롯데 화면의 검색칸을 못 찾았어요. 이 창 아래 [다시 조회]를 눌러 주세요.' });
              return;
            }
            setVal(box, ordNo);
            gridRows = [];
            await patch({ status: `${ordNo} 조회 중…` });
            // 로그인 바로 뒤에는 거래처코드 칸이 늦게 채워져서 "거래처코드를 입력 하십시오"가 뜬다. 닫고 기다렸다 다시 조회한다.
            for (let round = 0; round < 4 && !gridRows.length; round++) {
              const search = find(TEXT.search);
              if (search) realClick(search);
              for (let t = 0; t < 30 && !gridRows.length; t++) {
                await sleep(500);
                if (closeNotice(/거래처\s*코드/)) {
                  await patch({ status: `거래처코드가 아직 안 들어와서 기다렸다 다시 조회해요… (${round + 1})` });
                  await sleep(2500);
                  break;
                }
              }
            }
            if (!gridRows.length) {
              await patch({ step: 'manual', status: `${ordNo}로 조회했는데 롯데 목록이 안 떠요. 이 창 아래 [다시 조회]를 눌러 주세요.` });
              return;
            }
            // 아래에서 "첫 줄"을 눌러 체크하므로, 목록에 우리 주문번호 1줄만 남아 있어야 한다.
            // 검색조건이 안 먹어 다른 줄(예전 예약)까지 보이면 남의 운송장을 출력하게 된다(출력의심목록이 뜬 일).
            const ordOf = (r) => Object.values(r.raw || {}).map((v) => String(v == null ? '' : v).trim()).find((v) => ORD_RE.test(v)) || '';
            // 롯데가 주는 데이터에는 같은 줄이 두 번 들어오기도 해서 줄 수 대신, 화면의 건수(1/1 총)와
            // 데이터에 든 주문번호 종류로 본다: 화면 건수가 1이고, 주문번호가 우리 것 하나뿐이어야 한다.
            const shownCount = () => {
              const el = document.getElementById('spTotCnt');
              const n = el ? Number(String(el.textContent || '').replace(/[^0-9]/g, '')) : NaN;
              return Number.isFinite(n) ? n : -1;
            };
            const onlyOurs = () => {
              const ords = new Set(gridRows.map(ordOf).filter(Boolean));
              const n = shownCount();
              return ords.size === 1 && ords.has(ordNo) && (n === 1 || (n === -1 && gridRows.length === 1));
            };
            // 롯데 주문번호 검색은 앞부분 일치라, 예전 번호(-1)로 찾으면 같은 예약의 -10~-19도 같이 나온다.
            // 같이 나온 줄이 모두 이번 예약 박스이고 맨 위 줄이 우리 주문번호면(데이터 맨 앞의 주문번호 없는 줄은 화면 줄이 아니라 뺀다), 평소처럼 첫 줄만 체크해 출력한다.
            // (머리줄 전체선택은 잘 안 먹어서 쓰지 않는다. 혹시 다른 박스가 찍혀도 이번 예약 것이라 남의 송장이 아니고,
            //  송장번호는 주문번호가 똑같은 줄에서만 읽으며, 먼저 발급된 박스는 차례가 오면 다시 출력하지 않는다.)
            const mineAll = () => {
              const ours = new Set(ordList(p));
              const ords = new Set(gridRows.map(ordOf).filter(Boolean));
              const n = shownCount();
              return ords.has(ordNo) && ords.size > 1 && (n === -1 || n === ords.size) && gridRows.map(ordOf).filter(Boolean)[0] === ordNo
                && [...ords].every((o) => ours.has(o) && o.startsWith(ordNo));
            };
            for (let again = 0; again < 3 && !onlyOurs() && !mineAll(); again++) {
              await patch({ status: `${ordNo} 조회 결과가 ${shownCount() >= 0 ? shownCount() : gridRows.length}건이라 다시 조회해요… (${again + 1})` });
              await pickOrderNoCond();
              const box2 = document.querySelector('input[name="edtSrchCondVal"]');
              if (box2) setVal(box2, ordNo);
              gridRows = [];
              const s2 = find(TEXT.search);
              if (s2) realClick(s2);
              for (let t = 0; t < 30 && !gridRows.length; t++) await sleep(500);
            }
            const together = !onlyOurs() && mineAll();
            if (!onlyOurs() && !together) {
              await patch({
                step: 'manual',
                status: `${ordNo}로 조회했더니 ${shownCount() >= 0 ? shownCount() : gridRows.length}줄이 나와서 출력하지 않았어요(다른 송장을 출력하지 않으려고). 이 창 아래 [다시 조회]를 눌러 주세요. 계속 이러면 롯데에 같은 주문번호 예약이 두 번 들어간 거라, 겹친 예약을 지워 주세요.`,
                // 왜 멈췄는지 보려고 목록 순서·화면 건수를 남긴다(맨 위 줄이 우리 것이어야 첫 줄을 찍는다).
                diag: `화면 ${shownCount()}건 · 목록 순서 ${gridRows.map(ordOf).map((o) => o || '?').slice(0, 15).join(', ')}`,
              });
              return;
            }
            // 이미 운송장이 발급된 줄(사람이 롯데에서 직접 출력한 경우 등)은 다시 출력하지 않고 그 번호를 읽어 온다.
            const already = byOrder.get(ordNo);
            if (already && already.waybill && already.waybill.w) {
              await patch({
                step: 'waybillDone', printedAt: Date.now(), searchedAt2: 0,
                status: `${ordNo}는 이미 운송장이 발급돼 있어요(${already.waybill.w}). 다시 출력하지 않고 번호를 가져와요…`,
              });
              return;
            }
            // 출력 전에 목록에 있던 번호를 기억해 둔다. 출력 뒤에 "새로 생긴" 번호만 우리 것으로 가져간다
            // (남의 운송장번호를 절대 건드리지 않기 위한 안전장치).
            const before = gridRows.map((r) => r.waybill).filter(Boolean);

            // 3) 그 한 줄의 체크칸을 눌러 보고 출력. 목록에 우리 1건뿐이라 위치를 바꿔가며 다시 시도해도 안전하다.
            const TRIES = [
              { dom: true, label: '화면 체크박스' },
              { x: 37, y: 41, label: '첫 줄 37' },
              { x: 33, y: 41, label: '첫 줄 33' },
              { x: 41, y: 41, label: '첫 줄 41' },
              { x: 29, y: 41, label: '첫 줄 29' },
              { x: 45, y: 41, label: '첫 줄 45' },
              { x: 37, y: 13, label: '머리줄 37' },
              { x: 33, y: 13, label: '머리줄 33' },
              { x: 41, y: 13, label: '머리줄 41' },
              { x: 25, y: 41, label: '첫 줄 25' },
              { x: 49, y: 41, label: '첫 줄 49' },
              { x: 21, y: 41, label: '첫 줄 21' },
              { x: 53, y: 41, label: '첫 줄 53' },
            ].filter((tr) => !together || !/머리줄/.test(tr.label));
            if (together) await patch({ status: `${ordNo}로 찾으니 이번 예약 박스 ${new Set(gridRows.map(ordOf).filter(Boolean)).size}개가 같이 나왔어요. 맨 위 ${ordNo} 줄만 체크해 출력해요…` });
            for (let t = 0; t < TRIES.length; t++) {
              const tr = TRIES[t];
              await patch({ status: `체크 시도 ${t + 1}/${TRIES.length} · ${tr.label} (${ordNo})` });
              if (tr.dom) {
                if (!(await clickDomCheckbox())) continue;
              } else {
                await clickAt(tr.x, tr.y);
              }
              const at = Date.now();
              lastAlert = null;
              const printBtn = findAll(TEXT.print).find((el) => el.closest('button, a, [role="button"], span')) || find(TEXT.print);
              if (!printBtn) {
                await patch({ step: 'error', status: '"출력" 버튼을 못 찾았어요.' });
                return;
              }
              lastOpen = null;
              realClick(printBtn);
              await sleep(3000);
              if (await handleSuspect()) await patch({ status: `${ordNo} 출력의심목록 창이 떠서 "출력 안 됨(다시 출력)"으로 적용했어요…` });
              if (lastOpen && lastOpen.blocked) {
                await patch({
                  step: 'manual',
                  status: '크롬이 롯데 미리보기 창을 막았어요. 주소창 오른쪽 팝업 차단 아이콘에서 "항상 허용"을 고른 뒤 이 창 아래 [다시 조회]를 눌러 주세요',
                });
                return;
              }
              const notice = closeNotice(EMPTY_MSG);
              const failed = notice || (lastAlert && lastAlert.at >= at && /없|선택/.test(lastAlert.text));
              if (!failed) {
                // 출력 버튼이 실제로 무슨 일을 했는지 그대로 적어 둔다.
                const diag = await printDiagText();
                await patch({
                  step: 'preview',
                  printedAt: Date.now(),
                  preWaybills: before,
                  openInfo: diag,
                  status: `${ordNo} 송장 출력 중…`,
                  diag: `${tr.label} · ${diag}`,
                });
                return;
              }
            }
            await patch({
              step: 'manual',
              status: `${ordNo} 줄을 체크하지 못했어요. 이 창 아래 [다시 조회]를 눌러 주세요.`,
            });
          } finally {
            canvasBusy = false;
          }
          return;
        }


        // 사람이 직접 체크·출력하는 동안 기다렸다가, 운송장번호가 채워지면 가져간다.
        // 이때도 목록에서 이 쉽먼트의 주문번호(S…-1, -2 …) 줄마다 적힌 번호만, 박스가 다 모였을 때 가져간다.
        if (p.step === 'manual') {
          const need = needOf(p);
          const batch = String(p.batchId || '');
          if (!need || !batch) return;
          const since = p.manualAt || 0;
          const done = [];
          for (let i = 1; i <= need; i++) {
            const ordNo = ordAt(p, i);
            const seen = byOrder.get(ordNo);
            // 멈춘 뒤에 새로 조회된 줄만 본다(예전에 본 줄로 넘기지 않게).
            if (!seen || seen.at < since || !seen.waybill.w) return;
            done.push({ ordNo, waybill: seen.waybill.w, receiver: seen.receiver || '', from: seen.waybill.why });
          }
          // 바로 넘기지 않고 주문번호마다 한 번 더 조회해 같은 번호인지 대조한 뒤에만 앱으로 보낸다.
          await patch({
            step: 'verify', verifyIdx: 1, verifyBatchDone: false, verifiedOk: [], verifySearchedAt: 0, verifyStartedAt: Date.now(), collected: done,
            status: `송장번호 ${done.length}건을 찾았어요. 롯데 목록과 한 번 더 대조하는 중…`,
          });
          return;
        }

        // 미리보기 창이 안 뜨면 알려준다.
        if (p.step === 'preview' && p.printedAt && Date.now() - p.printedAt > 40000 && !p.previewPrintedAt) {
          await patch({
            step: 'manual',
            status: '송장 미리보기 창이 안 떴어요. 이 창 아래 [다시 조회]를 눌러 주세요.',
            diag: p.openInfo || '창 열림 기록 없음',
          });
          return;
        }
        return;
      }

      // 일괄주문접수 화면(사용자파일 선택지가 보임)이면 옵션을 고르고 파일을 올립니다.
      if (!UPLOADED_STEPS.includes(p.step) && (find(TEXT.userFile) || Array.from(document.querySelectorAll('select option')).some((o) => TEXT.userFile.test(clean(o.textContent))))) {
        await patch({ step: 'options', status: '사용자파일에서 B-type[지정송하인] 고르는 중…' });
        // 화면이 덜 그려졌을 수 있어 몇 번 더 시도한다(한 번 실패했다고 바로 포기하지 않는다).
        let picked = await pickSenderType();
        for (let i = 0; !picked && i < 3; i++) {
          await sleep(1000);
          await patch({ step: 'options', status: `사용자파일에서 B-type[지정송하인] 고르는 중… (다시 시도 ${i + 1}/3)` });
          picked = await pickSenderType();
        }
        if (!picked) {
          await patch({ step: 'error', status: '사용자파일 드롭다운에서 "B-type[지정송하인]"을 못 골랐어요. 직접 고른 뒤 "파일열기 및 업로드"로 다운로드 폴더의 파일을 올려주세요.' });
          return;
        }
        await sleep(400);
        if (!(await checkTitle())) {
          await patch({ step: 'error', status: '"타이틀있음"을 체크하지 못했어요. 직접 체크한 뒤 "파일열기 및 업로드"로 다운로드 폴더의 파일을 올려주세요.' });
          return;
        }
        await sleep(400);
        const input = Array.from(document.querySelectorAll('input[type="file"]'))[0];
        if (input) {
          // 파일을 넣기 "전에" 먼저 표시를 남깁니다(넣는 순간 창이 새로 떠서 이 코드가 끊길 수 있음).
          const latest = await get();
          if (!latest || DONE_STEPS.includes(latest.step)) return;
          await patch({ step: 'uploading', uploadingAt: Date.now(), uploaderFrame: FRAME_ID, status: '✅ 택배 예약 파일을 올렸어요. 곧 이 창이 닫혀요.' });
          // 끝 신호는 화면이 새로 뜨는 것(위 tick 첫 부분). 새로 안 뜨면 background.js가 3초 뒤 닫습니다.
          await attachFile(input, p.file);
        } else {
          await patch({
            step: 'error',
            status: `B-type[지정송하인]은 골랐는데 파일 칸을 못 찾았어요. "파일열기 및 업로드"를 눌러 다운로드 폴더의 ${p.file.name}을 골라주세요.`,
          });
        }
        return;
      }

      // 메뉴는 맨 위 화면에서만 누릅니다. 화면이 내부 창에 뜨므로 거기 있는 이 스크립트가 이어받을 때까지
      // 기다립니다(20초 안에 안 뜨면 한 번 더 누름).
      if (!IS_TOP) return;

      // 파일을 올린 뒤에는 집배달 › 통합관리 운송장출력으로 간다.
      if (['uploaded', 'waybillMenu'].includes(p.step)) {
        const wbLink = findAll(TEXT.waybillPage).find((el) => el.closest('a.menuLeaf, li'));
        if (wbLink && Date.now() - lastMenuClick > 3000) {
          lastMenuClick = Date.now();
          realClick(wbLink);
          await patch({ step: 'waybillPage', status: '통합관리 운송장출력 여는 중…' });
          return;
        }
        const dMenu = find(TEXT.deliveryMenu);
        if (!wbLink && dMenu && Date.now() - lastMenuClick > 3000) {
          lastMenuClick = Date.now();
          realClick(dMenu);
          await patch({ step: 'waybillMenu', status: '집배달 메뉴 여는 중…' });
        }
        return;
      }
      // 여기부터는 "아직 파일을 안 올린" 상태에서만 메뉴를 누른다. 올린 뒤에 다시 누르면 처음으로 되돌아가
      // 같은 파일을 또 올리게 된다.
      if (!['start', 'menu', 'page'].includes(p.step)) return;
      if (p.step === 'page' && Date.now() - (p.pageClickedAt || 0) < 20000) return;
      const pageLink = findAll(TEXT.page).find((el) => el.closest('a.menuLeaf, li')) || null;
      if (pageLink && Date.now() - lastMenuClick > 3000) {
        lastMenuClick = Date.now();
        realClick(pageLink);
        await patch({ step: 'page', pageClickedAt: Date.now(), status: '일괄주문접수 여는 중…' });
        return;
      }
      const menu = find(TEXT.menu);
      if (!pageLink && menu && Date.now() - lastMenuClick > 3000) {
        lastMenuClick = Date.now();
        realClick(menu);
        await patch({ step: 'menu', status: '거래처관리 메뉴 여는 중…' });
      }
    } catch (err) {
      await patch({ step: 'error', status: `진행 중 오류: ${String((err && err.message) || err)}` });
    } finally {
      busy = false;
    }
  };

  // ==== 송장 다시 출력(lotteReprint) ====
  // 앱의 발주서 박스 운송장번호 옆 🖨를 누르면 시작한다. 예약 올리기(lottePending)와는 저장 칸·창이 따로라
  // 서로 섞이지 않는다: 이 흐름은 자기가 연 창과 그 창에서 뜬 미리보기 창에서만 움직이고, 기존 흐름은 그 창들에서 쉰다.
  // 집하일자(입고예정일 7일 전 ~ 입고예정일) → 검색조건 운송장번호 → 조회 → 그 한 줄 체크 → 출력 → 미리보기 창에서
  // 운송장종류를 표준라벨E로 골라 두고 멈춘다(출력은 사람이 누른다). 관리번호 누르기(번호 발급)는 절대 하지 않는다.
  const RP_KEY = 'lotteReprint';
  const RP_DONE = ['done', 'error', 'manual'];
  const getRp = () =>
    new Promise((resolve) => {
      try {
        chrome.storage.local.get(RP_KEY, (r) => resolve((r && r[RP_KEY]) || null));
      } catch (err) {
        resolve(null);
      }
    });
  const patchRp = async (updates) => {
    const cur = await getRp();
    if (!cur) return;
    await new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [RP_KEY]: { ...cur, ...updates } }, () => resolve());
      } catch (err) {
        resolve();
      }
    });
  };
  const rpLive = (rp) => !!rp && !!rp.windowId && Date.now() - (rp.savedAt || 0) < 30 * 60 * 1000;
  const rpMine = (rp) => rpLive(rp) && (myWindowId === rp.windowId || (IS_PREVIEW && myOpenerWindowId === rp.windowId));
  // 기존 흐름이 이 창에서 쉬어야 하는지. 창 정보를 아직 못 받았으면 받을 때까지 쉰다.
  const reprintOwnsThisWindow = async () => {
    const rp = await getRp();
    if (!rpLive(rp)) return false;
    if (!windowInfoReady) return true;
    if (rpMine(rp)) return true;
    // 미리보기 창인데 누가 열었는지 모르고, 송장 다시 출력이 미리보기를 기다리는 중이면 손대지 않는다.
    if (IS_PREVIEW && !myOpenerWindowId && rp.step === 'preview') return true;
    return false;
  };

  const renderRp = (rp) => {
    if (!IS_TOP) return;
    if (!rp || rp.hidden) {
      if (rpPanel) rpPanel.remove();
      rpPanel = null;
      return;
    }
    if (!rpPanel) {
      rpPanel = document.createElement('div');
      rpPanel.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:280px;background:#fff;border:1px solid #d0d7e2;' +
        'border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.15);font:13px/1.5 -apple-system,sans-serif;color:#1f2937;padding:12px;';
      rpPanel.addEventListener('click', (e) => {
        const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'close') {
          try {
            chrome.storage.local.remove(RP_KEY);
          } catch (err) {}
        } else if (act === 'dump') dumpStructure();
        else if (act === 'hide') patchRp({ hidden: true });
      });
      document.body.appendChild(rpPanel);
    }
    const color = rp.step === 'error' ? '#dc2626' : rp.step === 'manual' ? '#b45309' : rp.step === 'done' ? '#059669' : '#1d4ed8';
    const btn = 'border:1px solid #d0d7e2;background:#f8fafc;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px;';
    rpPanel.innerHTML = `
      <div style="font-weight:700;margin-bottom:4px">🖨 송장 다시 출력</div>
      <div style="color:#64748b;font-size:12px;margin-bottom:6px">${rp.waybill || ''}${rp.edd ? ` · 입고예정 ${rp.edd}` : ''}</div>
      <div style="color:${color};font-size:13px;margin-bottom:8px">${rp.status || '진행 중…'}</div>
      <div style="display:flex;gap:6px">
        <button data-act="dump" style="${btn}" title="자동 진행이 안 될 때 화면 구조를 파일로 저장해 보내주세요">화면 구조 저장</button>
        ${RP_DONE.includes(rp.step) ? `<button data-act="hide" style="${btn};border-color:#bbf7d0;background:#f0fdf4;color:#047857">닫기</button>` : `<button data-act="close" style="${btn};border-color:#fecaca;background:#fff1f2;color:#b91c1c">멈춤</button>`}
      </div>`;
  };

  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // 입고예정일 7일 전 ~ 입고예정일(ALPS는 7일까지만 고를 수 있다).
  const rpRange = (edd) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(edd || ''));
    const end = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 7);
    return { from: ymd(start), to: ymd(end) };
  };

  // "집하일자" 오른쪽 같은 줄의 날짜 칸 두 개에 적는다. 적은 값이 그대로 남았는지까지 본다.
  const setPickupDates = async (from, to) => {
    const label = find(/^집하일자$/);
    if (!label) return '집하일자 칸을 못 찾음';
    const lr = label.getBoundingClientRect();
    const midY = lr.top + lr.height / 2;
    const boxes = Array.from(document.querySelectorAll('input'))
      .filter((el) => visible(el) && isTextBox(el) && /\d{4}\D?\d{2}\D?\d{2}/.test(el.value || ''))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= lr.right - 6 && Math.abs(r.top + r.height / 2 - midY) < 20;
      })
      .sort((x, y) => x.getBoundingClientRect().left - y.getBoundingClientRect().left)
      .slice(0, 2);
    if (boxes.length < 2) return `날짜 칸을 ${boxes.length}개만 찾음`;
    const digits = (v) => String(v || '').replace(/\D/g, '');
    const write = async (el, v) => {
      for (const form of [v, digits(v)]) {
        el.focus();
        setVal(el, form);
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        el.blur();
        await sleep(300);
        if (digits(el.value) === digits(v)) return true;
      }
      return false;
    };
    const ok1 = await write(boxes[0], from);
    const ok2 = await write(boxes[1], to);
    // 끝 날짜를 적으면서 시작 날짜가 바뀌었을 수 있어 한 번 더 본다.
    if (ok1 && digits(boxes[0].value) !== digits(from)) await write(boxes[0], from);
    if (digits(boxes[0].value) === digits(from) && digits(boxes[1].value) === digits(to)) return '';
    return `날짜가 ${boxes[0].value} ~ ${boxes[1].value}로 남음`;
  };

  const RP_TRIES = [
    { dom: true, label: '화면 체크박스' },
    { x: 37, y: 41, label: '첫 줄 37' },
    { x: 33, y: 41, label: '첫 줄 33' },
    { x: 41, y: 41, label: '첫 줄 41' },
    { x: 29, y: 41, label: '첫 줄 29' },
    { x: 45, y: 41, label: '첫 줄 45' },
    { x: 37, y: 13, label: '머리줄 37' },
    { x: 33, y: 13, label: '머리줄 33' },
    { x: 41, y: 13, label: '머리줄 41' },
  ];

  // 운송장출력 화면: 날짜 → 검색조건 → 조회 → 우리 한 줄만 남았는지 확인 → 체크 → 출력.
  const runReprintSearch = async (rp) => {
    const digitsOf = (v) => String(v == null ? '' : v).replace(/\D/g, '');
    const target = digitsOf(rp.waybill);
    const { from, to } = rpRange(rp.edd);
    await patchRp({ step: 'search', searchStartedAt: Date.now(), status: `집하일자를 ${from} ~ ${to}로 맞추는 중…` });
    const dateWhy = await setPickupDates(from, to);
    if (dateWhy) {
      await patchRp({ step: 'manual', status: `집하일자를 못 맞췄어요(${dateWhy}). ${from} ~ ${to}로 고르고 검색조건 "운송장번호"에 ${rp.waybill}를 넣어 조회·출력해 주세요.` });
      return;
    }
    await patchRp({ status: '검색조건을 운송장번호로 바꾸는 중…' });
    if (!(await pickCombo(TEXT.condLabel, /^운송장\s*번호$/))) {
      await patchRp({ step: 'manual', status: `검색조건을 "운송장번호"로 바꾸지 못했어요(${condWhy}). 직접 바꿔 ${rp.waybill}로 조회·출력해 주세요.` });
      return;
    }
    const box = document.querySelector('input[name="edtSrchCondVal"]');
    if (!box) {
      await patchRp({ step: 'manual', status: '검색값 칸을 못 찾았어요. 직접 조회·출력해 주세요.' });
      return;
    }
    setVal(box, target);
    const hasOurs = () => gridRows.some((r) => Object.values(r.raw || {}).some((v) => digitsOf(v) === target));
    const total = () => {
      const el = document.getElementById('spTotCnt');
      const n = el ? Number(String(el.textContent || '').replace(/[^0-9]/g, '')) : NaN;
      return Number.isFinite(n) ? n : -1;
    };
    gridRows = [];
    await patchRp({ status: `${rp.waybill} 조회 중…` });
    const searchedAt = Date.now();
    for (let round = 0; round < 4 && !hasOurs(); round++) {
      const search = find(TEXT.search);
      if (search) realClick(search);
      for (let t = 0; t < 20 && !hasOurs(); t++) {
        await sleep(500);
        if (closeNotice(/거래처\s*코드/)) {
          await patchRp({ status: `거래처코드가 아직 안 들어와서 기다렸다 다시 조회해요… (${round + 1})` });
          await sleep(2500);
          break;
        }
        const notice = closeNotice(/(\d+\s*일|기간).{0,20}(초과|넘|이내|까지|선택|조회)/);
        if (notice) {
          await patchRp({ step: 'manual', status: `ALPS 안내: ${notice}` });
          return;
        }
        if (lastAlert && lastAlert.at >= searchedAt && /일|기간/.test(lastAlert.text)) {
          await patchRp({ step: 'manual', status: `ALPS 안내: ${lastAlert.text}` });
          return;
        }
      }
    }
    if (!hasOurs()) {
      await patchRp({ step: 'manual', status: `${from} ~ ${to} 사이에서 ${rp.waybill}를 찾지 못했어요. 집하일자를 넓혀 직접 조회해 주세요.` });
      return;
    }
    // 첫 줄을 눌러 체크하므로 목록에 이 송장 한 줄만 있어야 한다(남의 송장을 출력하지 않게).
    const n = total();
    if (n !== 1 && !(n === -1 && gridRows.length === 1)) {
      await patchRp({ step: 'manual', status: `${rp.waybill}로 조회했는데 ${n >= 0 ? n : gridRows.length}건이 보여서 체크·출력하지 않았어요. 직접 체크하고 출력해 주세요.` });
      return;
    }
    for (let t = 0; t < RP_TRIES.length; t++) {
      const tr = RP_TRIES[t];
      await patchRp({ status: `체크 시도 ${t + 1}/${RP_TRIES.length} · ${tr.label}` });
      if (tr.dom) {
        if (!(await clickDomCheckbox())) continue;
      } else {
        await clickAt(tr.x, tr.y);
      }
      const at = Date.now();
      lastAlert = null;
      lastOpen = null;
      const printBtn = findAll(TEXT.print).find((el) => el.closest('button, a, [role="button"], span')) || find(TEXT.print);
      if (!printBtn) {
        await patchRp({ step: 'error', status: '"출력" 버튼을 못 찾았어요.' });
        return;
      }
      // 미리보기 창이 이 흐름 것임을 알 수 있게 먼저 적어 둔다.
      await patchRp({ step: 'preview', printedAt: Date.now(), status: '출력 누름. 미리보기 창 기다리는 중…' });
      realClick(printBtn);
      await sleep(3000);
      if (await handleSuspect()) await patchRp({ status: '출력의심목록 창이 떠서 "출력 안 됨(다시 출력)"으로 적용했어요…' });
      if (lastOpen && lastOpen.blocked) {
        await patchRp({ step: 'manual', status: '크롬이 미리보기 창(팝업)을 막았어요. 주소창 오른쪽 팝업 차단 아이콘에서 "항상 허용"으로 바꾼 뒤 다시 해주세요.' });
        return;
      }
      const notice = closeNotice(EMPTY_MSG);
      const failed = notice || (lastAlert && lastAlert.at >= at && /없|선택/.test(lastAlert.text));
      if (!failed) return;
      await patchRp({ step: 'search' });
    }
    await patchRp({ step: 'manual', status: '체크가 안 돼요. 직접 체크하고 출력해 주세요.' });
  };

  let rpBusy = false;
  let rpMenuClick = 0;
  const tickReprint = async () => {
    if (rpBusy) return;
    const rp = await getRp();
    if (!windowInfoReady || !rpMine(rp)) {
      if (IS_TOP && rpPanel) renderRp(null);
      return;
    }
    if (IS_TOP) renderRp(rp);
    if (RP_DONE.includes(rp.step)) return;
    if (Date.now() - (rp.savedAt || 0) > MAX_AGE_MS) {
      if (IS_TOP) await patchRp({ step: 'error', status: '시간이 너무 오래 걸려 멈췄어요. 앱에서 다시 눌러주세요.' });
      return;
    }
    document.documentElement.setAttribute('data-rocket-auto-confirm', '1');
    rpBusy = true;
    try {
      const onLoginPage = /\/sec\/|login|auth/i.test(location.pathname) && !find(TEXT.menu);
      const pw = onLoginPage ? Array.from(document.querySelectorAll('input[type="password"]')).find(visible) : null;
      if (pw) {
        await tryLogin(rp, pw, patchRp);
        return;
      }
      // 미리보기 창: 앞으로 띄우고 운송장종류를 표준라벨E로 고른 뒤 멈춘다.
      if (IS_PREVIEW) {
        if (rp.step !== 'preview' || !document.querySelector('canvas')) return;
        await sleep(1500);
        try {
          chrome.runtime.sendMessage({ type: 'FOCUS_MY_WINDOW' });
        } catch (err) {}
        const how = await pickLabelE();
        await patchRp({ step: 'done', status: `✅ 송장 출력 창을 열고 운송장종류를 표준라벨E로 골라 뒀어요(${how}). 확인하고 출력을 눌러 주세요.` });
        return;
      }
      if (rp.step === 'preview') {
        if (Date.now() - (rp.printedAt || 0) > 40000) {
          await patchRp({ step: 'manual', status: '미리보기 창을 잡지 못했어요. 떠 있는 창에서 운송장종류를 표준라벨E로 고르고 출력해 주세요.' });
        }
        return;
      }
      if (rp.step === 'search') {
        // 조회하던 화면이 새로 떠서 끊겼으면 사람에게 넘긴다.
        if (!canvasBusy && Date.now() - (rp.searchStartedAt || 0) > 120000) {
          await patchRp({ step: 'manual', status: `조회가 멈췄어요. 직접 ${rp.waybill}로 조회·출력해 주세요.` });
        }
        return;
      }
      // 운송장출력 화면(검색조건이 보이는 프레임)에서 조회·출력.
      if (find(TEXT.condLabel) && isWaybillScreen()) {
        if (canvasBusy) return;
        canvasBusy = true;
        try {
          await runReprintSearch(rp);
        } finally {
          canvasBusy = false;
        }
        return;
      }
      // 메뉴는 맨 위 화면에서만: 집배달 › 통합관리 운송장출력.
      if (!IS_TOP || Date.now() - rpMenuClick < 3000) return;
      const wbLink = findAll(TEXT.waybillPage).find((el) => el.closest('a.menuLeaf, li'));
      if (wbLink) {
        rpMenuClick = Date.now();
        realClick(wbLink);
        await patchRp({ step: 'page', status: '통합관리 운송장출력 여는 중…' });
        return;
      }
      const dMenu = find(TEXT.deliveryMenu);
      if (dMenu) {
        rpMenuClick = Date.now();
        realClick(dMenu);
        await patchRp({ step: 'menu', status: '집배달 메뉴 여는 중…' });
      }
    } catch (err) {
      await patchRp({ step: 'error', status: `진행 중 오류: ${String((err && err.message) || err)}` });
    } finally {
      rpBusy = false;
    }
  };
  setInterval(tickReprint, 1000);
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[RP_KEY] && IS_TOP && rpMine(changes[RP_KEY].newValue)) renderRp(changes[RP_KEY].newValue);
    });
  } catch (err) {}

  setInterval(tick, 1000);
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY] && IS_TOP && !rpOwnsCache) render(changes[KEY].newValue || null);
    });
  } catch (err) {}
  tick();
})();
