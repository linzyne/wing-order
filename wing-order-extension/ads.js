// 쿠팡 광고센터 대시보드에서 어제 '전체 집행 광고비'를 읽어 윙발주(Firestore adSpend)로 보낸다.
// 윙발주 사업자 버튼의 '순' 마진 = 마진 − 어제 광고비(부가세 포함).
// 윙발주 요청(mode 'ads')으로 연 탭이면 '어제'를 눌러 읽고 결과를 알린다.
// 직접 연 대시보드라도 날짜가 어제 하루로 보이면 같이 읽어 둔다.
(() => {
  if (window.__wingAdSpend) return;
  window.__wingAdSpend = true;

  const DASHBOARD = 'https://advertising.coupang.com/marketing/dashboard/sales';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, '0');
  const normName = (s) => String(s || '').normalize('NFC').replace(/주식회사|\(주\)|㈜|\s/g, '').toLowerCase();

  const log = [];
  const L = (text) => {
    const d = new Date();
    log.push(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${text}`);
  };

  const yesterday = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  // 요소 자기 글자 — 옆에 ⓘ 아이콘 같은 자식이 붙어 있어도 읽히게 자식 요소 글자는 빼고, 입력칸은 값
  const ownText = (el) => {
    if (el.tagName === 'INPUT') return (el.value || '').trim();
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.replace(/\s+/g, ' ').trim();
  };
  const allOwn = () => [...document.querySelectorAll('body *')]
    .filter((el) => !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName))
    .map((el) => [el, ownText(el)])
    .filter(([, t]) => t);
  // 자기 글자가 정확히 text인 요소들
  const byText = (text) => allOwn().filter(([, t]) => t === text).map(([el]) => el);

  // '전체 집행 광고비' 카드의 숫자 (부가세 별도)
  function readSpend() {
    for (const label of byText('전체 집행 광고비')) {
      let card = label.parentElement;
      for (let i = 0; i < 4 && card; i++, card = card.parentElement) {
        const m = card.textContent.replace(/전체 집행 광고비/, '').match(/(\d[\d,]*)\s*원/);
        if (m) return Number(m[1].replace(/,/g, ''));
      }
    }
    return null;
  }

  // 오른쪽 위 날짜 칸이 '2026.11.07'처럼 하루만 보이면 그 날짜 (기간이면 null)
  function shownDate() {
    const texts = [...new Set(allOwn().map(([, t]) => t)
      .filter((t) => /^\d{4}\.\s?\d{1,2}\.\s?\d{1,2}\.?(\s*[~-]\s*\d{4}\.\s?\d{1,2}\.\s?\d{1,2}\.?)?$/.test(t))
      .map((t) => t.replace(/\s/g, '').replace(/\.$/, '').replace(/\.(?=[~-])/, '')))];
    if (texts.length !== 1) return null;
    const parts = texts[0].split(/\s*[~-]\s*(?=\d{4}\.)/);
    const [a, b] = parts.map((p) => p.split('.').map((x) => pad(Number(x))).join('-'));
    return !b || a === b ? a : null;
  }

  // 왼쪽 위 사업자 이름 — 확장에 적은 사업자명과 다르면 잘못 저장하지 않는다
  function pageBusiness(businessName) {
    const want = normName(businessName);
    return allOwn().some(([, text]) => {
        const t = normName(text);
        return t.length >= 2 && t.length <= 30 && (t === want || t.includes(want) || want.includes(t));
      });
  }

  // 날짜가 어제이고 숫자가 1.5초 동안 그대로면 그 값
  async function waitSpend(ms) {
    const date = yesterday();
    const end = Date.now() + ms;
    let last = null;
    while (Date.now() < end) {
      const d = shownDate();
      const v = d === date ? readSpend() : null;
      if (v != null && v === last) return v;
      last = v;
      await sleep(1500);
    }
    L(`날짜 칸 ${shownDate() || '못 읽음'} · 광고비 ${readSpend() ?? '못 읽음'} (어제 ${date})`);
    return null;
  }

  async function report(businessName, spend) {
    const vat = Math.round(spend * 1.1);
    await chrome.runtime.sendMessage({ type: 'AD_SPEND', businessName, date: yesterday(), spend, spendWithVat: vat });
    return vat;
  }

  async function runJob(businessName) {
    try {
      // 로그인 화면이면 저절로 대시보드로 넘어가길 잠깐 기다린다 (넘어가면 이 스크립트는 새로 뜬다)
      if (!location.href.startsWith(DASHBOARD)) {
        await sleep(15000);
        chrome.runtime.sendMessage({ type: 'JOB_DONE', ok: false, message: '광고센터 로그인이 필요해요 — 그 프로필에서 광고센터 로그인' });
        return;
      }
      if (!businessName) throw new Error('확장에 사업자명이 없어요 (윙 화면 왼쪽 아래 패널에서 적기)');
      // 화면이 다 뜰 때까지 기다린 뒤 '어제'를 누른다
      for (let i = 0; i < 20 && readSpend() == null; i++) await sleep(1000);
      if (readSpend() == null) {
        L(`광고비 들어간 글자: ${JSON.stringify(allOwn().map(([, t]) => t).filter((t) => /광고비|원$/.test(t)).slice(0, 30))}`);
        L(`화면 글자 일부: ${JSON.stringify(document.body.innerText.slice(0, 1500))}`);
        throw new Error('전체 집행 광고비 칸을 못 찾았어요');
      }
      if (!pageBusiness(businessName)) L(`사업자명 못 찾음 — 화면 위쪽: ${JSON.stringify(document.body.innerText.slice(0, 300))}`);
      if (!pageBusiness(businessName)) throw new Error(`광고센터 사업자가 ${businessName}이 아니에요`);
      if (shownDate() !== yesterday()) {
        const btn = byText('어제')[0];
        if (!btn) throw new Error('어제 버튼을 못 찾았어요');
        (btn.closest('button,a,label,li,[role="button"]') || btn).click();
        L('어제 누름');
      }
      const spend = await waitSpend(20000);
      if (spend == null) {
        L(`날짜 비슷한 글자: ${JSON.stringify(allOwn().map(([, t]) => t).filter((t) => /\d{4}\.|\d{2}\.\d{2}|어제/.test(t)).slice(0, 20))}`);
        throw new Error('어제 광고비를 못 읽었어요');
      }
      const vat = await report(businessName, spend);
      chrome.runtime.sendMessage({ type: 'JOB_DONE', ok: true, message: `어제 광고비 ${vat.toLocaleString()}원 (부가세 포함)` });
    } catch (err) {
      L(`실패: ${err.message}`);
      chrome.runtime.sendMessage({ type: 'SAVE_LOG', log: log.slice(), page: location.href, prefix: '광고비로그' });
      chrome.runtime.sendMessage({ type: 'JOB_DONE', ok: false, message: err.message });
    }
  }

  chrome.runtime.sendMessage({ type: 'CHECK_UPDATE' }).then(async (r) => {
    if (r && r.reloading) {
      setTimeout(() => location.reload(), 1500);
      return;
    }
    const job = await chrome.runtime.sendMessage({ type: 'GET_JOB' });
    const { businessName } = await chrome.storage.local.get('businessName');
    if (job && job.mode === 'ads') {
      runJob(businessName || '');
      return;
    }
    // 직접 연 대시보드: 어제 하루로 보이면 조용히 저장
    if (!businessName || !location.href.startsWith(DASHBOARD)) return;
    const spend = await waitSpend(30000);
    if (spend != null && pageBusiness(businessName)) report(businessName, spend);
  }).catch(() => {});
})();
