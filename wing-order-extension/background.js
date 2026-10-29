// 확장 뒤편: 윙발주(Firestore wingInbox)로 보내기, 파일 주소로 직접 받기, 진단 로그 저장
importScripts('config.js');

const pad = (n) => String(n).padStart(2, '0');

// "엑셀 다운"을 누른 뒤 크롬이 시작한 다운로드 주소 (hook이 못 잡았을 때 대신 받아 보기용)
let armedAt = 0;
let lastDownloadUrl = null;
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ARM') {
    armedAt = Date.now();
    lastDownloadUrl = null;
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
