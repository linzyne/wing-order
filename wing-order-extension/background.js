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

async function sendInbox({ fileName, fileBase64, wingCount, businessName, source }) {
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
        // 어느 탭에서 받은 파일인지 (상품준비중 = 그날 전체, 결제완료 = 새 주문만)
        source: { stringValue: source || '' },
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

// ── 윙발주에서 온 받기 요청 (wingRequests) ──
// 윙발주의 "1차 받기 / 2차 받기"가 사업자별 요청 문서를 남기면, 그 사업자 프로필의 확장이
// 윙 주문배송관리 탭을 뒤에서 열어 받아 보내고 결과를 문서에 적는다. 프로필 창이 열려 있기만 하면 된다.
const MANAGE_URL = 'https://wing.coupang.com/tenants/sfl-portal/delivery/management';
const docsBase = () => `https://firestore.googleapis.com/v1/projects/${self.WING_FIREBASE.projectId}/databases/(default)/documents`;
const keyQ = () => `key=${self.WING_FIREBASE.apiKey}`;

// 윙발주 사업자명('주식회사 안군농원')과 확장에 적은 이름('안군농원')이 조금 달라도 같은 사업자로 본다
const normName = (s) => String(s || '').normalize('NFC').replace(/주식회사|\(주\)|㈜|\s/g, '').toLowerCase();
const sameBusiness = (a, b) => {
  const x = normName(a);
  const y = normName(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

async function findRequests(businessName) {
  const res = await fetch(`${docsBase()}:runQuery?${keyQ()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'wingRequests' }],
        where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'pending' } } },
      },
    }),
  });
  if (!res.ok) throw new Error(`Firestore ${res.status}`);
  return (await res.json())
    .filter((r) => r.document && sameBusiness(r.document.fields?.businessName?.stringValue, businessName))
    .map((r) => r.document);
}

async function patchRequest(name, fields, updateTime) {
  const mask = Object.keys(fields).map((f) => `updateMask.fieldPaths=${f}`).join('&');
  const pre = updateTime ? `&currentDocument.updateTime=${encodeURIComponent(updateTime)}` : '';
  const body = {};
  for (const [k, v] of Object.entries(fields)) body[k] = { stringValue: String(v) };
  const res = await fetch(`https://firestore.googleapis.com/v1/${name}?${mask}${pre}&${keyQ()}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: body }),
  });
  return res.ok;
}

let polling = false;
async function pollRequests() {
  if (polling) return;
  polling = true;
  try {
    const { businessName } = await chrome.storage.local.get('businessName');
    if (!businessName) return;
    for (const doc of await findRequests(businessName)) {
      const f = doc.fields || {};
      if (f.status?.stringValue !== 'pending') continue;
      // 3분 넘게 묵은 요청은 버린다 (프로필을 늦게 열었을 때 예전 요청이 실행되지 않게)
      if (Date.now() - Date.parse(f.createdAt?.timestampValue || 0) > 3 * 60 * 1000) {
        await patchRequest(doc.name, { status: 'error', message: '요청이 오래돼서 건너뜀' }, doc.updateTime);
        continue;
      }
      // 같은 프로필 창이 둘이어도 한 번만 실행되도록 문서가 그대로일 때만 가져간다
      if (!(await patchRequest(doc.name, { status: 'running', message: '윙 여는 중' }, doc.updateTime))) continue;
      const tab = await chrome.tabs.create({ url: MANAGE_URL, active: false });
      const { jobs = {} } = await chrome.storage.local.get('jobs');
      const mode = f.mode?.stringValue;
      jobs[tab.id] = { mode: mode === 'next' || mode === 'invoice' ? mode : 'first', reqName: doc.name, at: Date.now() };
      // 송장 올리기: 윙발주가 문서에 담아 보낸 송장 파일
      if (mode === 'invoice') {
        jobs[tab.id].fileName = f.fileName?.stringValue || '송장.xlsx';
        jobs[tab.id].fileBase64 = f.fileBase64?.stringValue || '';
      }
      await chrome.storage.local.set({ jobs });
    }
  } catch (err) {
    console.warn('[윙 요청 확인]', err);
  } finally {
    polling = false;
  }
}

// 요청으로 연 탭이 윙 로그인 화면으로 넘어가면(로그인 풀림) 실패로 적고 탭은 남겨 둔다
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url || /^https:\/\/wing\.coupang\.com\//.test(info.url) || !/login|xauth/i.test(info.url)) return;
  const { jobs = {} } = await chrome.storage.local.get('jobs');
  const job = jobs[tabId];
  if (!job) return;
  delete jobs[tabId];
  await chrome.storage.local.set({ jobs });
  await patchRequest(job.reqName, { status: 'error', message: '윙 로그인이 풀렸어요 — 그 프로필에서 다시 로그인' });
  chrome.tabs.update(tabId, { active: true }).catch(() => {});
});

// 서비스 워커가 잠들지 않게 30초마다 깨우고, 깨어 있는 동안 5초마다 요청을 확인한다
chrome.alarms.create('wingRequests', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'wingRequests') return;
  for (let i = 0; i < 5; i++) {
    await pollRequests();
    await new Promise((r) => setTimeout(r, 5000));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_JOB') {
    chrome.storage.local.get('jobs').then(({ jobs = {} }) => {
      const job = sender.tab && jobs[sender.tab.id];
      sendResponse(job && Date.now() - job.at < 10 * 60 * 1000 ? job : null);
    });
    return true;
  }
  if (msg.type === 'JOB_DONE') {
    chrome.storage.local.get('jobs').then(async ({ jobs = {} }) => {
      const tabId = sender.tab && sender.tab.id;
      const job = jobs[tabId];
      if (!job) return;
      delete jobs[tabId];
      await chrome.storage.local.set({ jobs });
      await patchRequest(job.reqName, { status: msg.ok ? 'done' : 'error', message: msg.message || '' });
      // 잘 끝난 탭은 닫고, 실패한 탭은 화면을 볼 수 있게 남겨 둔다
      if (msg.ok) chrome.tabs.remove(tabId).catch(() => {});
    });
    return false;
  }
  if (msg.type === 'JOB_STEP') {
    chrome.storage.local.get('jobs').then(({ jobs = {} }) => {
      const job = sender.tab && jobs[sender.tab.id];
      if (job) patchRequest(job.reqName, { message: msg.message });
    });
    return false;
  }
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
