// 확장 뒤편: 윙발주(Firestore wingInbox)로 보내기, 파일 주소로 직접 받기, 진단 로그 저장
importScripts('config.js');

const pad = (n) => String(n).padStart(2, '0');

// "엑셀 다운"을 누른 뒤 크롬이 시작한 다운로드 주소 (hook이 못 잡았을 때 대신 받아 보기용)
let armedAt = 0;
let lastDownloadUrl = null;
let armedName = '';

// 보내는 엑셀이 다운로드 폴더에도 저장될 때 윙 원래 이름 대신 윙발주에 보낸 이름으로 저장
// (보내기가 실패해 직접 올려도 사업자·시간이 그대로 인식되게)
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (armedName && Date.now() - armedAt < 2 * 60 * 1000 && /\.xlsx?$/i.test(item.filename || '')) {
    suggest({ filename: armedName, conflictAction: 'uniquify' });
    armedName = '';
    return;
  }
  suggest();
});
chrome.downloads.onCreated.addListener((item) => {
  if (Date.now() - armedAt > 2 * 60 * 1000) return;
  const url = item.finalUrl || item.url || '';
  if (/^https?:/i.test(url)) lastDownloadUrl = url;
});

const toBase64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

async function fetchFile(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const b = new Uint8Array(buf);
  if (b[0] !== 0x50 || b[1] !== 0x4b) throw new Error('엑셀 파일이 아니에요');
  return toBase64(buf);
}

async function sendInbox({ fileName, fileBase64, wingCount, businessName }) {
  // Firestore 문서 한 개는 1MB까지
  if (fileBase64.length > 1_000_000) throw new Error('파일이 너무 커요(1MB 넘음)');
  const { projectId, apiKey } = self.WING_FIREBASE;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/wingInbox?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        fileName: { stringValue: fileName },
        fileBase64: { stringValue: fileBase64 },
        businessName: { stringValue: businessName },
        wingCount: wingCount == null ? { nullValue: null } : { integerValue: String(wingCount) },
        createdAt: { timestampValue: new Date().toISOString() },
      },
    }),
  });
  if (!res.ok) throw new Error(`Firestore ${res.status} ${(await res.text()).slice(0, 200)}`);
}

function saveLog(log, page) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const json = JSON.stringify({ version: chrome.runtime.getManifest().version, page, log }, null, 2);
  const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
  chrome.downloads.download({ url: dataUrl, filename: `윙주문서로그_${stamp}.json`, saveAs: false });
}

// ── 자동 새로고침 ──
// 확장 폴더의 파일이 바뀌면(코드 수정) 윙 화면을 열 때 스스로 다시 불러온다.
// 프로필마다 chrome://extensions 에서 ↻ 를 누르지 않아도 되게.
const FILES = ['manifest.json', 'background.js', 'hook.js', 'wing.js', 'config.js'];
async function diskHash() {
  const texts = await Promise.all(FILES.map((f) => fetch(chrome.runtime.getURL(f), { cache: 'no-store' }).then((r) => r.text())));
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texts.join('\n\u0000\n')));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// 설치·다시 불러오기 직후의 파일 상태를 기준으로 저장
chrome.runtime.onInstalled.addListener(() => {
  diskHash().then((loadedHash) => chrome.storage.local.set({ loadedHash })).catch(() => {});
});
async function checkUpdate() {
  const [{ loadedHash, reloadAt }, now] = await Promise.all([chrome.storage.local.get(['loadedHash', 'reloadAt']), diskHash()]);
  // 기준이 없거나 방금 다시 불러온 직후면(onInstalled 저장 전일 수 있음) 지금 상태를 기준으로 — 되풀이 새로고침 방지
  if (!loadedHash || Date.now() - (reloadAt || 0) < 15000) {
    await chrome.storage.local.set({ loadedHash: now });
    return false;
  }
  if (loadedHash === now) return false;
  await chrome.storage.local.set({ reloadAt: Date.now() });
  return true;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'CHECK_UPDATE') {
    checkUpdate().then((changed) => {
      sendResponse({ reloading: changed });
      if (changed) setTimeout(() => chrome.runtime.reload(), 200);
    }, () => sendResponse({ reloading: false }));
    return true;
  }
  if (msg.type === 'ARM') {
    armedAt = Date.now();
    lastDownloadUrl = null;
    armedName = msg.fileName || '';
    return false;
  }
  if (msg.type === 'LAST_DOWNLOAD_URL') {
    sendResponse(lastDownloadUrl);
    return false;
  }
  if (msg.type === 'SAVE_LOG') {
    saveLog(msg.log, msg.page);
    return false;
  }
  if (msg.type === 'FETCH_FILE') {
    fetchFile(msg.url).then((base64) => sendResponse({ base64 }), (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'SEND_INBOX') {
    sendInbox(msg).then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: e.message }));
    return true;
  }
  return false;
});
