// 확장 뒤편: 윙발주가 넣은 발주서(Firestore adminOutbox) 찾기·가져가기, 진단 로그 저장
importScripts('config.js');

const pad = (n) => String(n).padStart(2, '0');
const base = () => {
  const { projectId } = self.WING_FIREBASE;
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
};
const key = () => `key=${self.WING_FIREBASE.apiKey}`;
const str = (f) => f?.stringValue ?? '';

// 이 탭의 업체·사업자 앞으로 온 발주서 목록 (오래된 것부터)
async function listOutbox(company, business) {
  const res = await fetch(`${base()}/adminOutbox?pageSize=50&${key()}`);
  if (!res.ok) throw new Error(`Firestore ${res.status}`);
  const docs = (await res.json()).documents || [];
  return docs
    .map((d) => ({
      name: d.name,
      company: str(d.fields?.company),
      business: str(d.fields?.business),
      fileName: str(d.fields?.fileName),
      fileBase64: str(d.fields?.fileBase64),
      label: str(d.fields?.label),
      rowCount: Number(d.fields?.rowCount?.integerValue ?? 0),
      createTime: d.createTime,
    }))
    .filter((d) => d.company === company && d.business === business && d.fileBase64)
    .sort((a, b) => a.createTime.localeCompare(b.createTime));
}

// 가져가기 = 서버에서 지우기. 아직 있을 때만 지워지므로 탭이 여러 개여도 한 탭만 성공한다.
async function claim(docName) {
  const res = await fetch(`https://firestore.googleapis.com/v1/${docName}?currentDocument.exists=true&${key()}`, { method: 'DELETE' });
  return res.ok;
}

function saveLog(log, page) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const json = JSON.stringify({ version: chrome.runtime.getManifest().version, page, log }, null, 2);
  const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
  chrome.downloads.download({ url: dataUrl, filename: `어드민발주로그_${stamp}.json`, saveAs: false });
}

// 발주서가 오면 offscreen 창(Firestore 구독)이 알려 주고, 그때 열린 어드민 탭들에 '가져가 봐'를 보낸다.
// 계속 물어보지 않으므로 발주서가 있을 때만 읽는다. 창이 닫혀 있으면 1분마다 다시 띄우기만 한다.
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: '윙발주 발주서가 오면 바로 알기 위한 Firestore 구독',
  }).catch((e) => { if (!/single offscreen/i.test(e.message)) console.warn('[구독 창]', e); });
}
chrome.alarms.create('adminOutbox', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'adminOutbox') ensureOffscreen(); });
chrome.runtime.onStartup.addListener(ensureOffscreen);
chrome.runtime.onInstalled.addListener(ensureOffscreen);
ensureOffscreen();

async function tellAdminTabs() {
  const tabs = await chrome.tabs.query({ url: '*://*.adminplus.co.kr/partner-app/*' });
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'OUTBOX_CHANGED' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FIRESTORE_CHANGED') {
    // 남은 발주서가 없으면(가져가서 지워진 것) 탭에 알릴 것도 없다
    if (msg.count > 0) tellAdminTabs();
    return false;
  }
  if (msg.type === 'FIRESTORE_FAILED') {
    console.warn('[구독 끊김]', msg.message);
    chrome.offscreen.closeDocument().catch(() => {}).finally(() => setTimeout(ensureOffscreen, 5000));
    return false;
  }
  if (msg.type === 'TAKE') {
    // 맨 앞 발주서 하나를 가져간다
    (async () => {
      const list = await listOutbox(msg.company, msg.business);
      for (const d of list) {
        if (await claim(d.name)) return { item: d };
      }
      return { item: null };
    })().then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'SAVE_LOG') {
    saveLog(msg.log, msg.page);
    return false;
  }
  return false;
});
