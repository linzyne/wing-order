// 확장 자동 새로고침 (뒤편). 확장 폴더의 파일이 바뀌면(코드 수정) 이 확장이 일하는 화면을 열 때
// 스스로 다시 불러온다 — 프로필마다 chrome://extensions 에서 ↻ 를 누르지 않아도 되게.
// 화면 쪽은 auto-reload-page.js. 여러 확장이 같은 파일을 쓴다(고치면 다 같이 복사).
(() => {
  const HASH = '__autoReloadHash';
  const AT = '__autoReloadAt';
  // 살펴볼 파일: 매니페스트에 적힌 뒤편·화면 스크립트 + 확장마다 더 적은 것(self.AUTO_RELOAD_FILES)
  const files = () => {
    const m = chrome.runtime.getManifest();
    const set = new Set(['manifest.json', 'auto-reload.js', ...(self.AUTO_RELOAD_FILES || [])]);
    if (m.background && m.background.service_worker) set.add(m.background.service_worker);
    for (const cs of m.content_scripts || []) for (const f of [...(cs.js || []), ...(cs.css || [])]) set.add(f);
    return [...set];
  };
  async function diskHash() {
    const texts = await Promise.all(files().map((f) =>
      fetch(chrome.runtime.getURL(f), { cache: 'no-store' }).then((r) => (r.ok ? r.text() : ''), () => '')));
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texts.join('\n\u0000\n')));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // 설치·다시 불러오기 직후의 파일 상태를 기준으로 저장
  chrome.runtime.onInstalled.addListener(() => {
    diskHash().then((h) => chrome.storage.local.set({ [HASH]: h })).catch(() => {});
  });
  async function changed() {
    const [got, now] = await Promise.all([chrome.storage.local.get([HASH, AT]), diskHash()]);
    // 기준이 없거나 방금 다시 불러온 직후면(onInstalled 저장 전일 수 있음) 지금 상태를 기준으로 — 되풀이 새로고침 방지
    if (!got[HASH] || Date.now() - (got[AT] || 0) < 15000) {
      await chrome.storage.local.set({ [HASH]: now });
      return false;
    }
    if (got[HASH] === now) return false;
    await chrome.storage.local.set({ [AT]: Date.now() });
    return true;
  }
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== '__AUTO_RELOAD_CHECK') return false;
    changed().then((c) => {
      sendResponse({ reloading: c });
      if (c) setTimeout(() => chrome.runtime.reload(), 200);
    }, () => sendResponse({ reloading: false }));
    return true;
  });
})();
