// 두 확장(윙 주문서·어드민 발주)이 함께 쓰는 '바뀌면 알려줘' 창.
// 확장 뒤편은 잠들기 때문에, 보이지 않는 창(offscreen)이 Firestore 구독을 들고 있다가
// 요청 문서가 생기거나 바뀌면 뒤편을 깨워 알린다. 계속 물어보지 않아 요청이 있을 때만 읽는다.
// 고치면 `npm run build:ext` 로 각 확장 폴더의 offscreen.js 를 다시 만든다.
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, where, onSnapshot } from 'firebase/firestore';

const { projectId, apiKey } = self.WING_FIREBASE;
const { collectionId, pendingOnly } = self.LISTEN_TARGET;
const db = getFirestore(initializeApp({ projectId, apiKey }));
const col = collection(db, collectionId);
const q = pendingOnly ? query(col, where('status', '==', 'pending')) : col;

// 서버와 연결이 끊기면(전송 오류 등) SDK가 오류 없이 캐시만 보여 주며 멈춰 있을 수 있다(11/25 12:15 'Listen stream
// transport errored' 뒤로 어드민 발주가 안 들어가던 일). 그래서 '서버에서 온 화면'인지(fromCache)를 같이 받아,
// 캐시 상태가 1분 넘게 이어지면 끊긴 것으로 보고 뒤편에 알려 이 창을 새로 띄우게 한다(새 연결).
const STALE_MS = 60 * 1000;
let staleTimer = null;
const fail = (message) => {
  chrome.runtime.sendMessage({ type: 'FIRESTORE_FAILED', message }).catch(() => {});
};

onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
  if (snap.metadata.fromCache) {
    if (!staleTimer) staleTimer = setTimeout(() => fail('서버 연결이 1분 넘게 끊김'), STALE_MS);
  } else if (staleTimer) {
    clearTimeout(staleTimer);
    staleTimer = null;
  }
  // 내용이 바뀐 것만 알린다(연결 상태만 바뀐 건 빼고)
  if (snap.docChanges().length === 0) return;
  chrome.runtime.sendMessage({ type: 'FIRESTORE_CHANGED', count: snap.size }).catch(() => {});
}, (err) => {
  console.warn('[구독 실패]', err);
  // 끊기면 뒤편이 이 창을 다시 띄운다
  fail(String(err?.message || err));
});
