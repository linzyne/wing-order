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

onSnapshot(q, (snap) => {
  if (snap.empty && snap.docChanges().length === 0) return;
  chrome.runtime.sendMessage({ type: 'FIRESTORE_CHANGED', count: snap.size }).catch(() => {});
}, (err) => {
  console.warn('[구독 실패]', err);
  // 끊기면 뒤편이 이 창을 다시 띄운다
  chrome.runtime.sendMessage({ type: 'FIRESTORE_FAILED', message: String(err?.message || err) }).catch(() => {});
});
