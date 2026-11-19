import { initializeApp } from 'firebase/app';
import { initializeFirestore, memoryLocalCache, persistentLocalCache, persistentSingleTabManager } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
// 사파리는 IndexedDB가 매우 느려서, 구독 중인 큰 문서(매출·작업공간)를 디스크 캐시에 쓰고 읽는 동안
// 저장(쓰기 확인)이 10초 넘게 밀렸다(CS 접수 '서버 응답이 느려…'). 사파리만 메모리 캐시로 쓴다.
const isSafari = typeof navigator !== 'undefined'
  && /Safari\//.test(navigator.userAgent)
  && !/Chrome\/|Chromium\/|CriOS\/|Edg\/|FxiOS\/|Firefox\//.test(navigator.userAgent);

export const db = initializeFirestore(app, {
  ignoreUndefinedProperties: true,
  localCache: isSafari
    ? memoryLocalCache()
    : persistentLocalCache({ tabManager: persistentSingleTabManager(undefined) }),
});

export default app;
