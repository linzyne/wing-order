// 발주서를 만든 주문서 파일을 세션별로 보관한다.
// 업체 줄에 따로 넣은 주문서(localFile)는 화면 상태라 줄이 다시 그려지거나 새로고침하면 사라지고,
// 그 뒤 송장 변환이 옛 공통 주문서로 돌아 새 주문 송장이 업로드 파일에서 빠졌다(2026-11-25 신선담다).
// 메모리 + IndexedDB 두 곳에 둬서 다시 그려져도, 새로고침해도 같은 파일로 변환한다.

const DB_NAME = 'wing-session-source-files';
const STORE = 'files';
const KEEP_MS = 3 * 24 * 60 * 60 * 1000; // 3일 지난 건 지움

const memory = new Map<string, File>();

const openDb = (): Promise<IDBDatabase | null> => new Promise(resolve => {
    try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    } catch { resolve(null); }
});

export const saveSessionSourceFile = async (sessionId: string, file: File) => {
    memory.set(sessionId, file);
    const db = await openDb();
    if (!db) return;
    try {
        const buf = await file.arrayBuffer();
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        store.put({ name: file.name, type: file.type, buf, savedAt: Date.now() }, sessionId);
        // 오래된 것 정리
        const cur = store.openCursor();
        cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return;
            if (Date.now() - (c.value?.savedAt || 0) > KEEP_MS) c.delete();
            c.continue();
        };
    } catch { /* 저장 실패해도 메모리 사본은 남음 */ }
};

export const loadSessionSourceFile = async (sessionId: string): Promise<File | null> => {
    const m = memory.get(sessionId);
    if (m) return m;
    const db = await openDb();
    if (!db) return null;
    return new Promise(resolve => {
        try {
            const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(sessionId);
            req.onsuccess = () => {
                const v = req.result;
                if (!v?.buf) return resolve(null);
                const f = new File([v.buf], v.name, { type: v.type });
                memory.set(sessionId, f);
                resolve(f);
            };
            req.onerror = () => resolve(null);
        } catch { resolve(null); }
    });
};

export const deleteSessionSourceFile = async (sessionId: string) => {
    memory.delete(sessionId);
    const db = await openDb();
    if (!db) return;
    try { db.transaction(STORE, 'readwrite').objectStore(STORE).delete(sessionId); } catch { /* 무시 */ }
};
