import { db } from '../firebase';
import {
  doc, setDoc, updateDoc, getDoc, deleteDoc,
  collection, query, orderBy, where, getDocs,
  onSnapshot, getDocFromServer, getDocFromCache, Timestamp, deleteField, writeBatch, runTransaction, limit,
  type Unsubscribe
} from 'firebase/firestore';
import { isCsFullyCompleted } from '../types';
import type { PricingConfig, CsRecord, DailySales, PlatformConfigs, TodoItem, BusinessInfo, CourierTemplate, CompanyDeposit } from '../types';

// ===== Firestore 한도 초과 감지 =====

const isQuotaError = (e: any): boolean => {
  // 실제 Firestore 할당량 초과 에러는 code=resource-exhausted / message="Quota exceeded."
  // (기존 'RESOURCE_EXHAUSTED' 대문자 매칭은 절대 안 걸렸음)
  const s = `${e?.code ?? ''} ${e?.message ?? ''}`.toLowerCase();
  return s.includes('resource-exhausted') || s.includes('resource_exhausted')
    || s.includes('quota-exceeded') || s.includes('quota exceeded');
};

export const notifyQuotaExceeded = () =>
  window.dispatchEvent(new CustomEvent('firestore-quota-exceeded'));

// 할당량 초과가 감지되면 일정 시간 동안 "쿨다운" — 구독 재연결/재시도를 멈춰
// 이미 바닥난 할당량을 재시도로 계속 갉아먹는 악순환(할당량이 리셋돼도 다시 바로 소진)을 끊는다.
const QUOTA_COOLDOWN_MS = 90 * 1000;
let quotaCooldownUntil = 0;
export const isQuotaCooldown = (): boolean => Date.now() < quotaCooldownUntil;
export const quotaCooldownRemainingMs = (): number => Math.max(0, quotaCooldownUntil - Date.now());
const enterQuotaCooldown = (): void => {
  quotaCooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
  notifyQuotaExceeded();
};
// Firestore 요청이 한 번이라도 성공하면 쿨다운 해제 — Blaze 전환 등으로 할당량이 풀렸는데
// 다른 구독이 백오프 대기 중이라 앱이 몇 분간 계속 비어 보이는 걸 방지한다.
const clearQuotaCooldown = (): void => { quotaCooldownUntil = 0; };

// ===== 공유 컬렉션 구독 (샤드 컬렉션용) =====
// 같은 컬렉션을 여러 컴포넌트가 각자 onSnapshot으로 구독하면(예: 사업자별로 항상 마운트되는
// SalesTracker가 전역 정산맵을 N번 구독) 리스너 수와 초기 읽기가 N배가 된다.
// key(사업자ID 등)별로 리스너 1개만 열고 fan-out, 마지막 해제 후에도 30초 linger(탭 전환 대비).
type SharedSubEntry<T> = {
  listeners: Set<(v: T) => void>;
  unsub: Unsubscribe | null;
  last: T;
  closeTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
};
const makeSharedCollectionSub = <T>(
  getCol: (key: string) => any,
  read: (snap: any) => T,
  empty: () => T,
  label: string,
) => {
  const entries = new Map<string, SharedSubEntry<T>>();
  return (callback: (v: T) => void, key = ''): Unsubscribe => {
    let entry = entries.get(key);
    if (!entry) {
      entry = { listeners: new Set(), unsub: null, last: empty(), closeTimer: null, retryTimer: null };
      entries.set(key, entry);
    }
    const e = entry;
    if (e.closeTimer) { clearTimeout(e.closeTimer); e.closeTimer = null; }
    e.listeners.add(callback);
    callback(e.last); // 새 구독자에게 마지막 값 즉시 전달

    const open = () => {
      if (e.unsub || e.listeners.size === 0) return;
      if (isQuotaCooldown()) { scheduleRetry(); return; }
      e.unsub = onSnapshot(getCol(key), (snap: any) => {
        clearQuotaCooldown();
        e.last = read(snap);
        e.listeners.forEach(l => l(e.last));
      }, (error: any) => {
        console.error(`[Firestore] ${label} 공유 구독 오류:`, error);
        if (isQuotaError(error)) enterQuotaCooldown();
        e.unsub = null; // onSnapshot은 에러 후 죽으므로 참조 정리
        e.listeners.forEach(l => l(e.last)); // 마지막 정상값 유지 (깜빡임 방지)
        scheduleRetry();
      });
    };
    const scheduleRetry = () => {
      if (e.retryTimer) return;
      const wait = isQuotaCooldown() ? Math.max(quotaCooldownRemainingMs() + 1000, 30000) : 60000;
      e.retryTimer = setTimeout(() => { e.retryTimer = null; open(); }, wait);
    };

    open();

    return () => {
      e.listeners.delete(callback);
      if (e.listeners.size === 0 && !e.closeTimer) {
        e.closeTimer = setTimeout(() => {
          e.unsub?.();
          e.unsub = null;
          if (e.retryTimer) { clearTimeout(e.retryTimer); e.retryTimer = null; }
          e.closeTimer = null;
        }, 30000);
      }
    };
  };
};

// ===== CS 접수/정산 반영 알림 (통합CS현황 등 매출현황과 별개로 마운트된 화면에서 저장했을 때
// 같은 사업자의 SalesTracker/워크스테이션이 이미 열려 있어도 자동 갱신되도록 알림) =====

export const CS_SAVED_EVENT = 'wing:cs-saved';
export const WORKSPACE_ADJUSTMENT_EVENT = 'wing:workspace-adjustment-saved';

// ===== 사업자별 Firestore 경로 헬퍼 =====
// 안군농원(또는 미지정)이면 기존 경로 그대로, 그 외 사업자는 접미사 추가
const getConfigDocId = (businessId?: string): string =>
  (!businessId || businessId === '안군농원') ? 'pricingConfig' : `pricingConfig_${businessId}`;

const getSalesCollectionName = (businessId?: string): string =>
  (!businessId || businessId === '안군농원') ? 'salesHistory' : `salesHistory_${businessId}`;

const getWorkspaceCollectionName = (businessId?: string): string =>
  (!businessId || businessId === '안군농원') ? 'dailyWorkspace' : `dailyWorkspace_${businessId}`;

const getManualOrdersDocId = (businessId?: string): string =>
  (!businessId || businessId === '안군농원') ? 'pendingManualOrders' : `pendingManualOrders_${businessId}`;

const getQuickRecipientsDocId = (businessId?: string): string =>
  (!businessId || businessId === '안군농원') ? 'quickRecipients' : `quickRecipients_${businessId}`;

const getCompanyOrderDocId = (businessId?: string): string =>
  (!businessId || businessId === '안군농원') ? 'companyOrder' : `companyOrder_${businessId}`;

// 플랫폼 감지 설정(헤더 매칭 등)은 사업자 공통이므로 항상 같은 문서 사용
const getPlatformConfigsDocId = (_businessId?: string): string => 'platformConfigs';

const getCourierTemplatesDocId = (): string => 'courierTemplates';

const getTodosDocId = (businessId?: string): string =>
  (!businessId || businessId === '안군농원') ? 'todos' : `todos_${businessId}`;

const getDepositLedgerDocId = (businessId?: string): string =>
  (!businessId || businessId === '안군농원') ? 'default' : businessId;

// ===== Pricing Config =====

export const subscribePricingConfig = (
  callback: (config: PricingConfig | null, connected: boolean) => void,
  businessId?: string
): Unsubscribe => {
  const docRef = doc(db, 'config', getConfigDocId(businessId));
  let active = true;
  let currentUnsub: Unsubscribe;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = 2000; // 지수 백오프 (2s → 4 → 8 … 최대 60s). 성공 시 리셋.

  const subscribe = () => {
    currentUnsub = onSnapshot(docRef, (snapshot) => {
      if (!active) return;
      retryDelay = 2000;
      clearQuotaCooldown();
      const fromCache = snapshot.metadata.fromCache;
      if (snapshot.exists()) {
        callback(snapshot.data().data as PricingConfig, true);
      } else if (fromCache) {
        // 캐시상 "없음"은 서버 확인 전이라 믿지 않음 — 서버에 직접 물어봄
        // (서버도 "없음"이면 onSnapshot이 다시 안 불려 로딩이 안 끝나므로)
        getDocFromServer(docRef).then(s => {
          if (!active) return;
          if (s.exists()) callback(s.data().data as PricingConfig, true);
          else callback(null, true);
        }).catch(() => { if (active) callback(null, false); });
      } else {
        callback(null, true);
      }
    }, (error) => {
      if (!active) return;
      console.error('[Firestore] PricingConfig 구독 오류:', error);
      callback(null, false);
      if (isQuotaError(error)) enterQuotaCooldown();
      // 구독이 종료됐으므로 재구독. 할당량 쿨다운 중이면 쿨다운이 끝날 때까지 기다린다
      // (2초마다 재시도하면 리셋된 할당량도 즉시 다시 소진됨). 그 외엔 지수 백오프.
      const wait = isQuotaCooldown()
        ? Math.max(quotaCooldownRemainingMs() + 1000, 30000)
        : retryDelay;
      retryDelay = Math.min(retryDelay * 2, 60000);
      retryTimer = setTimeout(() => {
        if (active) subscribe();
      }, wait);
    });
  };

  subscribe();

  return () => {
    active = false;
    if (retryTimer) clearTimeout(retryTimer);
    currentUnsub?.();
  };
};

export const loadPricingConfig = async (
  businessId?: string
): Promise<{ config: PricingConfig | null; exists: boolean }> => {
  try {
    const docRef = doc(db, 'config', getConfigDocId(businessId));
    const snapshot = await getDoc(docRef);
    if (snapshot.exists()) return { config: snapshot.data().data as PricingConfig, exists: true };
    return { config: null, exists: false };
  } catch (e) {
    if (isQuotaError(e)) enterQuotaCooldown();
    return { config: null, exists: false };
  }
};

export const savePricingConfigToFirestore = async (
  config: PricingConfig,
  businessId?: string
): Promise<void> => {
  const docRef = doc(db, 'config', getConfigDocId(businessId));
  await setDoc(docRef, {
    data: config,
    updatedAt: Timestamp.now(),
  });
};

// 단가 설정 바뀐 칸만 저장.
// 예전엔 창이 들고 있던 설정 전체를 덮어써서, 옛 단가를 들고 있던 다른 창·PC가 아무 칸이나 저장하면
// 다른 사람이 고친 값(신선담다 배송비 3,500 → 4,000)이 되돌아갔다.
// base(이 창이 알던 설정)와 next를 비교해 바뀐 칸만 뽑고, 서버 최신본에 그 칸만 얹어 트랜잭션으로 쓴다.
type PricingPatch = { path: string[]; value: unknown; del: boolean };
const isPlainObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const diffPricing = (a: unknown, b: unknown, path: string[], out: PricingPatch[]) => {
  if (isPlainObj(a) && isPlainObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in b) || b[k] === undefined) { if (k in a && a[k] !== undefined) out.push({ path: [...path, k], value: undefined, del: true }); }
      else diffPricing(a[k], b[k], [...path, k], out);
    }
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, value: b, del: false });
};
const applyPricingPatch = (target: Record<string, unknown>, p: PricingPatch) => {
  let cur = target;
  for (let i = 0; i < p.path.length - 1; i++) {
    const k = p.path[i];
    if (!isPlainObj(cur[k])) { if (p.del) return; cur[k] = {}; }
    cur = cur[k] as Record<string, unknown>;
  }
  const last = p.path[p.path.length - 1];
  if (p.del) delete cur[last];
  else cur[last] = JSON.parse(JSON.stringify(p.value ?? null));
};

export const savePricingConfigChanges = async (
  base: PricingConfig,
  next: PricingConfig,
  businessId?: string
): Promise<PricingConfig> => {
  const patches: PricingPatch[] = [];
  diffPricing(base, next, [], patches);
  const docRef = doc(db, 'config', getConfigDocId(businessId));
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists()) {
      tx.set(docRef, { data: next, updatedAt: Timestamp.now() });
      return next;
    }
    const server = JSON.parse(JSON.stringify(snap.data().data || {})) as Record<string, unknown>;
    if (patches.length === 0) return server as PricingConfig;
    patches.forEach(p => applyPricingPatch(server, p));
    tx.set(docRef, { data: server, updatedAt: Timestamp.now() });
    return server as PricingConfig;
  });
};

// ===== Sales History =====

// loadAllSalesHistory는 사업자별 매출 문서 전체(수십~수백 건)를 매번 읽는다.
// 통합CS현황 / 주문서업로드 대기CS / 주문자검색 패널이 마운트·이벤트마다 사업자별로 호출해
// Firestore 읽기가 폭증하던 것을 짧은 TTL 인메모리 캐시로 억제한다.
// 쓰기(upsert/delete)가 나가면 해당 사업자 캐시를 즉시 무효화하므로 최신성은 유지된다.
const SALES_HISTORY_TTL_MS = 90 * 1000;
const salesHistoryCache = new Map<string, { at: number; promise: Promise<DailySales[]> }>();
const invalidateSalesHistoryCache = (businessId?: string): void => {
  salesHistoryCache.delete(getSalesCollectionName(businessId));
};

// ===== CS 전용 저장소 =====
// CS 기록은 매출 문서(발주·송장 행 등 수십KB)와 따로 csHistory[_사업자]/{날짜} 작은 문서에 둔다.
// 예전엔 CS 몇 줄을 보려고 매출 문서를 통째로 받아서 대기·접수 목록과 저장이 느렸다.
// 문서: { date, records: CsRecord[], hasOpen } — hasOpen은 미완료·대기 CS가 하나라도 있으면 true
type CsRecords = NonNullable<DailySales['csRecords']>;
type ReturnRecords = NonNullable<DailySales['returnRecords']>;
const getCsCollectionName = (businessId?: string): string =>
  getSalesCollectionName(businessId).replace(/^salesHistory/, 'csHistory');
const getCsIndexMarkerDocId = (businessId?: string): string => `csIndex_v1_${getSalesCollectionName(businessId)}`;

const hasOpenCsRecords = (d: DailySales): boolean =>
  (d.csRecords || []).some(r => r.pending || !isCsFullyCompleted(r));

const csDocFields = (date: string, records: CsRecords) => ({
  date,
  records,
  hasOpen: hasOpenCsRecords({ csRecords: records } as DailySales),
});

// 매출 문서에 들어 있던 CS를 사업자별로 1회 csHistory로 옮긴다.
// 옮기기 전엔 CS 읽기·쓰기와 매출 문서 저장을 기다리게 해서(upsertDailySales는 csRecords를 빼고 덮어씀)
// 옮기기 전에 CS가 지워지는 일이 없게 한다. 매출 문서의 옛 csRecords는 남겨두지만 더는 읽지 않는다.
const csSplitReady = new Map<string, Promise<void>>();
const ensureCsSplit = (businessId?: string): Promise<void> => {
  const key = getSalesCollectionName(businessId);
  let ready = csSplitReady.get(key);
  if (!ready) {
    ready = (async () => {
      const markerRef = doc(db, 'config', `csSplit_v1_${key}`);
      if ((await getDoc(markerRef)).exists()) return;
      // hasCs 플래그가 다 채워진 사업자는 CS 있는 문서만, 아니면 전체를 훑는다
      const flagged = (await getDoc(doc(db, 'config', getCsIndexMarkerDocId(businessId)))).exists();
      const snapshot = await getDocs(flagged ? query(collection(db, key), where('hasCs', '==', true)) : collection(db, key));
      const withCs = snapshot.docs
        .map(d => ({ date: d.id, records: (d.data().csRecords || []) as CsRecords }))
        .filter(d => d.records.length > 0);
      for (let i = 0; i < withCs.length; i += 400) {
        const batch = writeBatch(db);
        withCs.slice(i, i + 400).forEach(d => batch.set(doc(db, getCsCollectionName(businessId), d.date), csDocFields(d.date, d.records)));
        await batch.commit();
      }
      await setDoc(markerRef, { doneAt: Timestamp.now(), count: withCs.length });
    })();
    csSplitReady.set(key, ready);
    ready.catch(() => csSplitReady.delete(key));
  }
  return ready;
};

// ===== CS 한 건 = 문서 하나 (csItems[_사업자]/{CS id}) =====
// 예전 csHistory/{날짜}는 그날 CS를 배열 하나에 담아서, 한 건 저장하려 해도 서버에서 읽고 → 고치고 → 다시 쓰고
// → 서버 확인까지 기다려야 했다(사파리에서 수십 초). 이제 한 건씩 바로 쓴다. 읽기가 없으니 기다릴 것도, 줄 세울 것도 없다.
// 문서: CsRecord + { date(접수한 날), open(대기·미완료면 true) }. 목록은 open==true 구독.
const getCsItemsCollectionName = (businessId?: string): string =>
  getSalesCollectionName(businessId).replace(/^salesHistory/, 'csItems');
const csItemRef = (businessId: string | undefined, id: string) => doc(db, getCsItemsCollectionName(businessId), id);
const isCsOpen = (r: CsRecord): boolean => !!r.pending || !isCsFullyCompleted(r);
// 화면용 필드(businessId 등)가 섞여 와도 CS 칸만 저장한다
const CS_VIEW_ONLY_FIELDS = ['businessId', 'businessName', 'date', 'syncing', 'open'];
const csItemFields = (date: string, record: CsRecord): Record<string, unknown> => {
  const fields: Record<string, unknown> = { ...record };
  CS_VIEW_ONLY_FIELDS.forEach(k => delete fields[k]);
  Object.keys(fields).forEach(k => { if (fields[k] === undefined) delete fields[k]; });
  return { ...fields, date, open: isCsOpen(record) };
};

// csHistory → csItems 사업자별 1회 옮기기. 이미 있는 건(다른 창이 먼저 옮기고 고친 것)은 건드리지 않는다
const csItemsReady = new Map<string, Promise<void>>();
const ensureCsItems = (businessId?: string): Promise<void> => {
  const key = getSalesCollectionName(businessId);
  let ready = csItemsReady.get(key);
  if (!ready) {
    ready = (async () => {
      const markerRef = doc(db, 'config', `csItems_v1_${key}`);
      if ((await getDoc(markerRef)).exists()) return;
      await ensureCsSplit(businessId);
      const [oldSnap, newSnap] = await Promise.all([
        getDocs(collection(db, getCsCollectionName(businessId))),
        getDocs(collection(db, getCsItemsCollectionName(businessId))),
      ]);
      const existing = new Set(newSnap.docs.map(d => d.id));
      const items: { date: string; record: CsRecord }[] = [];
      oldSnap.docs.forEach(d => ((d.data().records || []) as CsRecords).forEach(r => {
        if (r?.id && !existing.has(r.id)) items.push({ date: d.id, record: r });
      }));
      for (let i = 0; i < items.length; i += 400) {
        const batch = writeBatch(db);
        items.slice(i, i + 400).forEach(({ date, record }) => batch.set(csItemRef(businessId, record.id), csItemFields(date, record)));
        await batch.commit();
      }
      await setDoc(markerRef, { doneAt: Timestamp.now(), count: items.length });
    })();
    csItemsReady.set(key, ready);
    ready.catch(() => csItemsReady.delete(key));
  }
  return ready;
};

// ----- 뒤에서 도는 저장 추적 -----
// 저장 버튼은 서버 확인을 기다리지 않는다. 대신 아직 서버에 안 간 건 수·실패를 여기서 세서 화면에 보여주고,
// 남은 게 있을 때 창을 닫으려 하면 경고한다(사파리는 메모리 캐시라 닫으면 못 보낸 저장이 사라짐).
export const CS_SYNC_EVENT = 'wing:cs-sync';
export type CsSyncState = { pending: number; failures: { label: string; message: string }[] };
const csSync: CsSyncState = { pending: 0, failures: [] };
export const getCsSyncState = (): CsSyncState => ({ pending: csSync.pending, failures: [...csSync.failures] });
const emitCsSync = () => window.dispatchEvent(new CustomEvent(CS_SYNC_EVENT, { detail: getCsSyncState() }));
export const clearCsSyncFailures = () => { csSync.failures = []; emitCsSync(); };
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', e => {
    if (csSync.pending > 0) { e.preventDefault(); e.returnValue = ''; }
  });
}
export const trackCsSync = <T,>(label: string, work: Promise<T>): Promise<T> => {
  csSync.pending++;
  emitCsSync();
  work.then(
    () => { csSync.pending--; emitCsSync(); },
    (e: any) => {
      csSync.pending--;
      csSync.failures = [...csSync.failures, { label, message: e?.message || String(e) }];
      console.error(`[CS] ${label} 실패:`, e);
      emitCsSync();
    },
  );
  return work;
};

/** CS 한 건 저장. 화면(구독)에는 즉시 반영되고, 서버 저장은 뒤에서 — 반환 약속은 서버 확인 시점 */
export const writeCsItem = (businessId: string | undefined, date: string, record: CsRecord): Promise<void> =>
  trackCsSync(`CS 저장 (${record.recipientName || record.orderNumber || record.id})`,
    ensureCsItems(businessId).then(() => setDoc(csItemRef(businessId, record.id), csItemFields(date, record))));

export const deleteCsItem = (businessId: string | undefined, record: CsRecord): Promise<void> =>
  trackCsSync(`CS 삭제 (${record.recipientName || record.orderNumber || record.id})`,
    ensureCsItems(businessId).then(() => deleteDoc(csItemRef(businessId, record.id))));

/** id로 CS 몇 건을 고친다 (발주서 초기화로 재배송 CS를 대기로 되돌릴 때처럼 기록을 손에 안 들고 있을 때) */
export const updateCsItemsById = (
  businessId: string | undefined,
  ids: string[],
  mutate: (r: CsRecord) => CsRecord,
): Promise<void> =>
  trackCsSync('CS 상태 변경', (async () => {
    await ensureCsItems(businessId);
    await Promise.all(ids.map(async id => {
      const snap = await getDoc(csItemRef(businessId, id));
      if (!snap.exists()) return;
      const { date, open: _open, ...rest } = snap.data() as any;
      await setDoc(snap.ref, csItemFields(date, mutate(rest as CsRecord)));
    }));
  })());

// ----- 미완료·대기 CS 구독 (사업자별 리스너 1개를 여러 화면이 같이 씀) -----
export type OpenCsEntry = CsRecord & { date: string; syncing: boolean };
type OpenCsSub = { listeners: Set<(v: OpenCsEntry[] | null) => void>; last: OpenCsEntry[] | null; unsub: Unsubscribe | null; closeTimer: ReturnType<typeof setTimeout> | null; retryTimer: ReturnType<typeof setTimeout> | null };
const openCsSubs = new Map<string, OpenCsSub>();
/** 콜백은 처음 받기 전엔 null, 그다음부터 목록. syncing=아직 서버에 안 간 건 */
export const subscribeOpenCs = (businessId: string | undefined, callback: (items: OpenCsEntry[] | null) => void): Unsubscribe => {
  const key = getSalesCollectionName(businessId);
  let e = openCsSubs.get(key);
  if (!e) { e = { listeners: new Set(), last: null, unsub: null, closeTimer: null, retryTimer: null }; openCsSubs.set(key, e); }
  const entry = e;
  if (entry.closeTimer) { clearTimeout(entry.closeTimer); entry.closeTimer = null; }
  entry.listeners.add(callback);
  callback(entry.last);
  const open = () => {
    if (entry.unsub || entry.listeners.size === 0) return;
    entry.unsub = () => {}; // 옮기기 기다리는 동안 중복으로 안 열리게
    ensureCsItems(businessId).then(() => {
      if (entry.listeners.size === 0) { entry.unsub = null; return; }
      entry.unsub = onSnapshot(
        query(collection(db, getCsItemsCollectionName(businessId)), where('open', '==', true)),
        { includeMetadataChanges: true },
        snap => {
          clearQuotaCooldown();
          entry.last = snap.docs.map(d => {
            const { open: _open, ...data } = d.data() as any;
            return { ...data, id: d.id, syncing: d.metadata.hasPendingWrites } as OpenCsEntry;
          }).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
          entry.listeners.forEach(l => l(entry.last));
        },
        err => {
          console.error('[Firestore] CS 구독 오류:', err);
          if (isQuotaError(err)) enterQuotaCooldown();
          entry.unsub = null;
          retry();
        },
      );
    }).catch(err => { console.error('[CS] 옮기기 실패:', err); entry.unsub = null; retry(); });
  };
  const retry = () => {
    if (entry.retryTimer) return;
    entry.retryTimer = setTimeout(() => { entry.retryTimer = null; open(); }, isQuotaCooldown() ? Math.max(quotaCooldownRemainingMs() + 1000, 30000) : 5000);
  };
  open();
  return () => {
    entry.listeners.delete(callback);
    if (entry.listeners.size === 0 && !entry.closeTimer) {
      entry.closeTimer = setTimeout(() => {
        entry.unsub?.(); entry.unsub = null;
        if (entry.retryTimer) { clearTimeout(entry.retryTimer); entry.retryTimer = null; }
        entry.closeTimer = null;
      }, 5 * 60 * 1000);
    }
  };
};

export const loadAllSalesHistory = async (businessId?: string, opts?: { fresh?: boolean }): Promise<DailySales[]> => {
  const key = getSalesCollectionName(businessId);
  const cached = salesHistoryCache.get(key);
  if (!opts?.fresh && cached && Date.now() - cached.at < SALES_HISTORY_TTL_MS) {
    return cached.promise;
  }
  const promise = (async () => {
    const q = query(collection(db, key), orderBy('date', 'desc'));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => deserializeDailySales({ ...d.data() }));
  })();
  salesHistoryCache.set(key, { at: Date.now(), promise });
  promise.catch(() => salesHistoryCache.delete(key)); // 실패한 약속은 캐시에 남기지 않음
  return promise;
};

const deserializeDailySales = (data: any): DailySales => {
  if (typeof data.orderRows === 'string') {
    try { data.orderRows = JSON.parse(data.orderRows); } catch { data.orderRows = undefined; }
  }
  if (typeof data.invoiceRows === 'string') {
    try { data.invoiceRows = JSON.parse(data.invoiceRows); } catch { data.invoiceRows = undefined; }
  }
  if (data.companyOrderRows && typeof data.companyOrderRows === 'object') {
    data.companyOrderRows = Object.fromEntries(
      Object.entries(data.companyOrderRows).map(([k, v]) => {
        try { return [k, typeof v === 'string' ? JSON.parse(v) : v]; } catch { return [k, []]; }
      })
    );
  }
  if (data.companyInvoiceRows && typeof data.companyInvoiceRows === 'object') {
    data.companyInvoiceRows = Object.fromEntries(
      Object.entries(data.companyInvoiceRows).map(([k, v]) => {
        try { return [k, typeof v === 'string' ? JSON.parse(v) : v]; } catch { return [k, []]; }
      })
    );
  }
  return data as DailySales;
};

export const loadSalesHistoryByMonth = async (yearMonth: string, businessId?: string): Promise<DailySales[]> => {
  const q = query(
    collection(db, getSalesCollectionName(businessId)),
    where('date', '>=', `${yearMonth}-01`),
    where('date', '<=', `${yearMonth}-31`),
    orderBy('date', 'desc')
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map(d => deserializeDailySales({ ...d.data() }));
};

export const loadDailySales = async (date: string, businessId?: string): Promise<DailySales | undefined> => {
  const docRef = doc(db, getSalesCollectionName(businessId), date);
  const snapshot = await getDoc(docRef);
  if (!snapshot.exists()) return undefined;
  return deserializeDailySales({ ...snapshot.data() });
};

export const upsertDailySales = async (
  dailySales: DailySales,
  businessId?: string
): Promise<void> => {
  // CS는 csHistory에 따로 있다. 옮기기 전에 덮어써서 매출 문서의 CS가 사라지지 않게 먼저 옮긴다
  await ensureCsSplit(businessId);
  const docRef = doc(db, getSalesCollectionName(businessId), dailySales.date);
  // Firestore는 중첩 배열을 지원하지 않으므로 JSON 문자열로 직렬화
  const serialized: any = { ...dailySales };
  delete serialized.csRecords;
  if (serialized.orderRows) serialized.orderRows = JSON.stringify(serialized.orderRows);
  if (serialized.invoiceRows) serialized.invoiceRows = JSON.stringify(serialized.invoiceRows);
  if (serialized.companyOrderRows) {
    serialized.companyOrderRows = Object.fromEntries(
      Object.entries(serialized.companyOrderRows).map(([k, v]) => [k, JSON.stringify(v)])
    );
  }
  if (serialized.companyInvoiceRows) {
    serialized.companyInvoiceRows = Object.fromEntries(
      Object.entries(serialized.companyInvoiceRows).map(([k, v]) => [k, JSON.stringify(v)])
    );
  }
  // Firestore는 undefined 값을 허용하지 않으므로 제거
  Object.keys(serialized).forEach(key => {
    if (serialized[key] === undefined) delete serialized[key];
  });
  // 매출 문서와 주문 검색 색인을 함께 저장
  const batch = writeBatch(db);
  batch.set(docRef, serialized);
  batch.set(doc(db, getOrderSearchCollectionName(businessId), dailySales.date), orderSearchFields(dailySales));
  await batch.commit();
  invalidateSalesHistoryCache(businessId);
};

// 반품기록(CS환불) 저장 — 업무일지 마진에 들어가서 매출 문서에 있다. CS 저장과 따로, 반품을 넣거나 뺄 때만 부른다.
// 같은 날짜에 연달아 눌러도 읽기-수정-쓰기가 서로 덮어쓰지 않도록 날짜별로 순서대로 실행.
const returnWriteChains = new Map<string, Promise<unknown>>();
export const updateReturnRecords = (
  date: string,
  businessId: string | undefined,
  mutateReturns: (records: ReturnRecords) => ReturnRecords,
): Promise<boolean> => {
  const key = `${getSalesCollectionName(businessId)}/${date}`;
  const run = async (): Promise<boolean> => {
    const salesRef = doc(db, getSalesCollectionName(businessId), date);
    const snapshot = await getDoc(salesRef);
    const data = snapshot.exists() ? snapshot.data() : null;
    const current = (data?.returnRecords || []) as ReturnRecords;
    const next = mutateReturns(current);
    if (JSON.stringify(next) === JSON.stringify(current)) return false;
    const returnTotal = next.reduce((s, r) => s + r.totalMargin, 0);
    if (data) {
      await updateDoc(salesRef, {
        returnRecords: next.length > 0 ? next : deleteField(),
        returnTotal: returnTotal || deleteField(),
      });
    } else {
      // 그날 매출 문서가 아직 없으면 빈 문서로 만든다 (deleteField는 새 문서에 못 씀)
      const created: any = { date, records: [], totalAmount: 0, savedAt: new Date().toISOString(), returnRecords: next };
      if (returnTotal) created.returnTotal = returnTotal;
      await setDoc(salesRef, created);
    }
    invalidateSalesHistoryCache(businessId);
    return true;
  };
  const prev = returnWriteChains.get(key) || Promise.resolve();
  const result = prev.catch(() => {}).then(run);
  returnWriteChains.set(key, result);
  result.finally(() => { if (returnWriteChains.get(key) === result) returnWriteChains.delete(key); }).catch(() => {});
  return result;
};

// ===== 주문 검색 색인 =====
// CS 접수·주문자 검색은 발주행·주문번호·수취인·가구매만 필요하다. 매출 문서(송장행·시간대 집계 등 포함)의 1/6 정도라
// orderSearch[_사업자]/{날짜}에 따로 두고 upsertDailySales가 같이 쓴다.
// 색인이 생기기 전 날짜는 처음 볼 때 매출 문서로 만들어 둔다. 매출이 없는 날은 빈 색인(empty)을 남겨 다시 묻지 않는다.
const getOrderSearchCollectionName = (businessId?: string): string =>
  getSalesCollectionName(businessId).replace(/^salesHistory/, 'orderSearch');

const orderSearchFields = (d: DailySales): Record<string, unknown> => {
  const fields: Record<string, unknown> = { date: d.date };
  if (d.companyOrderRows) {
    fields.companyOrderRows = Object.fromEntries(Object.entries(d.companyOrderRows).map(([k, v]) => [k, JSON.stringify(v)]));
  } else if (d.orderRows) {
    fields.orderRows = JSON.stringify(d.orderRows);
  }
  if (d.companyOrderNumbers) fields.companyOrderNumbers = d.companyOrderNumbers;
  if (d.companyRecipientNames) fields.companyRecipientNames = d.companyRecipientNames;
  if (d.fakeOrderRecords?.length) fields.fakeOrderRecords = d.fakeOrderRecords;
  return fields;
};

const loadOrderSearchDoc = async (businessId: string | undefined, date: string, useCache: boolean): Promise<DailySales | null> => {
  const ref = doc(db, getOrderSearchCollectionName(businessId), date);
  let data: any = null;
  if (useCache) {
    try {
      const cached = await getDocFromCache(ref);
      if (cached.exists()) data = cached.data();
    } catch { /* 캐시에 없음 → 서버 */ }
  }
  if (!data) {
    const snap = await getDoc(ref);
    if (snap.exists()) data = snap.data();
  }
  if (data) return data.empty ? null : deserializeDailySales({ ...data });
  const sales = await loadDailySales(date, businessId);
  // 색인 쓰기는 기다리지 않는다 — 검색 결과는 방금 읽은 매출 문서로 바로 보여준다
  setDoc(ref, sales ? orderSearchFields(sales) : { date, empty: true })
    .catch(e => console.warn('[주문검색] 색인 저장 실패:', date, e));
  return sales || null;
};

// 주문자 검색·CS 접수용 최근 N일 색인.
// 예전엔 날짜마다 문서를 하나씩 45번 물었다(사파리는 캐시가 없어 매번 45번 서버 왕복). 이제 날짜 범위 쿼리 한 번이고,
// 화면이 열려 있는 동안은 구독으로 들고 있어서 업체를 바꿔도 다시 안 받는다.
// 색인이 아직 없는 날짜만 처음 한 번 매출 문서로 만들어 둔다(만들면 구독에 저절로 들어옴).
const recentDates = (days: number): string[] => {
  const now = new Date();
  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return dates;
};
const recentSearchQuery = (businessId: string | undefined, since: string) =>
  query(collection(db, getOrderSearchCollectionName(businessId)), where('date', '>=', since));
const readSearchDocs = (snap: any): DailySales[] =>
  snap.docs.filter((d: any) => !d.data().empty).map((d: any) => deserializeDailySales({ ...d.data() }))
    .sort((a: DailySales, b: DailySales) => b.date.localeCompare(a.date));
const backfilledSearch = new Set<string>();
const backfillMissingSearchDocs = (businessId: string | undefined, dates: string[], snap: any): Promise<DailySales[]> => {
  const have = new Set(snap.docs.map((d: any) => d.id));
  const missing = dates.filter(d => !have.has(d));
  if (missing.length === 0) return Promise.resolve([]);
  return Promise.all(missing.map(date => loadOrderSearchDoc(businessId, date, false).catch(() => null)))
    .then(list => list.filter((d): d is DailySales => !!d));
};

type RecentSearchSub = { listeners: Set<(v: DailySales[] | null) => void>; last: DailySales[] | null; unsub: Unsubscribe | null; closeTimer: ReturnType<typeof setTimeout> | null };
const recentSearchSubs = new Map<string, RecentSearchSub>();
const RECENT_SEARCH_DAYS = 45;
/** 최근 45일 발주내역 구독. 처음 받기 전엔 null */
export const subscribeRecentOrderSearch = (businessId: string | undefined, callback: (v: DailySales[] | null) => void): Unsubscribe => {
  const key = getSalesCollectionName(businessId);
  let e = recentSearchSubs.get(key);
  if (!e) { e = { listeners: new Set(), last: null, unsub: null, closeTimer: null }; recentSearchSubs.set(key, e); }
  const entry = e;
  if (entry.closeTimer) { clearTimeout(entry.closeTimer); entry.closeTimer = null; }
  entry.listeners.add(callback);
  callback(entry.last);
  if (!entry.unsub) {
    const dates = recentDates(RECENT_SEARCH_DAYS);
    entry.unsub = onSnapshot(recentSearchQuery(businessId, dates[dates.length - 1]), snap => {
      clearQuotaCooldown();
      entry.last = readSearchDocs(snap);
      entry.listeners.forEach(l => l(entry.last));
      if (!snap.metadata.fromCache && !backfilledSearch.has(key)) {
        backfilledSearch.add(key);
        backfillMissingSearchDocs(businessId, dates, snap).then(extra => {
          // 색인 쓰기가 구독에 들어오기 전에 먼저 보여준다
          if (extra.length === 0 || !entry.last) return;
          const seen = new Set(entry.last.map(d => d.date));
          entry.last = [...entry.last, ...extra.filter(d => !seen.has(d.date))].sort((a, b) => b.date.localeCompare(a.date));
          entry.listeners.forEach(l => l(entry.last));
        });
      }
    }, err => {
      console.error('[Firestore] 최근 발주내역 구독 오류:', err);
      if (isQuotaError(err)) enterQuotaCooldown();
      entry.unsub = null;
    });
  }
  return () => {
    entry.listeners.delete(callback);
    if (entry.listeners.size === 0 && !entry.closeTimer) {
      entry.closeTimer = setTimeout(() => { entry.unsub?.(); entry.unsub = null; entry.closeTimer = null; }, 10 * 60 * 1000);
    }
  };
};

export const loadRecentSalesForSearch = async (businessId: string | undefined, days: number): Promise<DailySales[]> => {
  const live = recentSearchSubs.get(getSalesCollectionName(businessId));
  if (days === RECENT_SEARCH_DAYS && live?.unsub && live.last) return live.last;
  const dates = recentDates(days);
  const snap = await getDocs(recentSearchQuery(businessId, dates[dates.length - 1]));
  const extra = await backfillMissingSearchDocs(businessId, dates, snap);
  return [...readSearchDocs(snap), ...extra].sort((a, b) => b.date.localeCompare(a.date));
};

// 전체 기간 주문 검색 — 처음 1회는 매출 문서 전체로 색인을 다 만들고, 그다음부터는 색인만 읽는다
export const loadAllOrderSearch = async (businessId?: string): Promise<DailySales[]> => {
  const markerRef = doc(db, 'config', `orderSearch_v1_${getSalesCollectionName(businessId)}`);
  if (!(await getDoc(markerRef)).exists()) {
    const history = await loadAllSalesHistory(businessId, { fresh: true });
    for (let i = 0; i < history.length; i += 400) {
      const batch = writeBatch(db);
      history.slice(i, i + 400).forEach(d => batch.set(doc(db, getOrderSearchCollectionName(businessId), d.date), orderSearchFields(d)));
      await batch.commit();
    }
    await setDoc(markerRef, { doneAt: Timestamp.now(), count: history.length });
    return history;
  }
  const snapshot = await getDocs(query(collection(db, getOrderSearchCollectionName(businessId)), orderBy('date', 'desc')));
  return snapshot.docs.filter(d => !d.data().empty).map(d => deserializeDailySales({ ...d.data() }));
};

export const appendInvoiceRows = async (
  date: string,
  newRows: any[][],
  businessId?: string
): Promise<void> => {
  const existing = await loadDailySales(date, businessId);
  const merged = [...(existing?.invoiceRows || []), ...newRows];
  const dailySales: DailySales = existing
    ? { ...existing, invoiceRows: merged, savedAt: new Date().toISOString() }
    : { date, records: [], totalAmount: 0, savedAt: new Date().toISOString(), invoiceRows: merged };
  await upsertDailySales(dailySales, businessId);
};

export const deleteDailySalesFromFirestore = async (
  date: string,
  businessId?: string
): Promise<void> => {
  // CS는 csHistory에 따로 남는다 (매출 기록을 지웠다 다시 저장해도 CS는 그대로)
  await ensureCsSplit(businessId);
  const batch = writeBatch(db);
  batch.delete(doc(db, getSalesCollectionName(businessId), date));
  batch.delete(doc(db, getOrderSearchCollectionName(businessId), date));
  await batch.commit();
  invalidateSalesHistoryCache(businessId);
};

// 특정 날짜 기록에서 한 업체의 데이터만 제거 (매출/마진/입금/발주·송장), 다른 업체는 유지
export const deleteCompanyFromDailySales = async (
  date: string,
  companyName: string,
  businessId?: string
): Promise<void> => {
  const existing = await loadDailySales(date, businessId);
  if (!existing) return;
  const updated: DailySales = {
    ...existing,
    records: (existing.records || []).filter(r => r.company !== companyName),
    marginRecords: (existing.marginRecords || []).filter(r => !r.company || r.company !== companyName),
    depositRecords: (existing.depositRecords || []).filter(d => !d.company || d.company !== companyName),
    fakeOrderRecords: (existing.fakeOrderRecords || []).filter(f => f.companyName !== companyName),
    companyOrderRows: Object.fromEntries(Object.entries(existing.companyOrderRows || {}).filter(([k]) => k !== companyName)),
    companyInvoiceRows: Object.fromEntries(Object.entries(existing.companyInvoiceRows || {}).filter(([k]) => k !== companyName)),
    companyOrderNumbers: Object.fromEntries(Object.entries(existing.companyOrderNumbers || {}).filter(([k]) => k !== companyName)),
    companyBundleNumbers: Object.fromEntries(Object.entries(existing.companyBundleNumbers || {}).filter(([k]) => k !== companyName)),
    companyRecipientNames: Object.fromEntries(Object.entries(existing.companyRecipientNames || {}).filter(([k]) => k !== companyName)),
    companyOrderPricing: Object.fromEntries(Object.entries(existing.companyOrderPricing || {}).filter(([k]) => k !== companyName)),
    companySettlementTexts: Object.fromEntries(Object.entries(existing.companySettlementTexts || {}).filter(([k]) => k !== companyName)),
  };
  updated.totalAmount = (updated.records || []).reduce((s, r) => s + r.totalPrice, 0);
  updated.marginTotal = (updated.marginRecords || []).reduce((s, r) => s + r.totalMargin, 0) || undefined;
  updated.depositTotal = (updated.depositRecords || []).reduce((s, d) => s + d.amount, 0) || undefined;
  if (!Object.keys(updated.companyOrderRows).length) delete updated.companyOrderRows;
  if (!Object.keys(updated.companyInvoiceRows).length) delete updated.companyInvoiceRows;
  if (!Object.keys(updated.companyOrderNumbers).length) delete updated.companyOrderNumbers;
  if (!Object.keys(updated.companyBundleNumbers || {}).length) delete updated.companyBundleNumbers;
  if (!Object.keys(updated.companyRecipientNames || {}).length) delete updated.companyRecipientNames;
  if (!Object.keys(updated.companyOrderPricing).length) delete updated.companyOrderPricing;
  if (!Object.keys(updated.companySettlementTexts || {}).length) delete updated.companySettlementTexts;
  await upsertDailySales(updated, businessId);
};

// ===== Daily Workspace =====

export interface SessionResultData {
  orderRows: any[][];
  invoiceRows: any[][];
  uploadInvoiceRows: any[][];
  header: any[];
  summaryExcel: string;
  depositSummary: string;
  depositSummaryExcel: string;
  totalPrice: number;
  excludedCount: number;
  excludedDetails: any[];
  orderCount: number;
  itemSummary: Record<string, { count: number; totalPrice: number }>;
  registeredProductNames?: Record<string, string>;
  orderItems?: { registeredProductName: string; registeredOptionName: string; matchedProductKey: string; qty: number; recipientName?: string; orderNumber?: string; bundleNumber?: string; orderHour?: number }[];
  includedOrderNumbers?: string[];
  rowOrderNumbers?: string[]; // orderRows와 동일한 순서/길이의 원본 주문번호 목록
  rowBundleNumbers?: string[]; // orderRows와 동일한 순서/길이의 묶음배송번호 목록
  rowRecipientNames?: string[]; // orderRows와 동일한 순서/길이의 수취인 이름 목록
  rowPricing?: { supplyPrice: number; sellingPrice: number; margin: number }[]; // orderRows와 동일한 순서/길이의 공급가/판매가/마진 목록
  sampleOrderCounts?: Record<string, number>; // 샘플 수동발주 수량 (productKey별) — 매출현황 마진에서 뺌
  unmatchedOrders?: { companyName: string; recipientName: string; productName: string; phone: string; orderNumber: string }[];
  timeLabel?: string; // 업로드 파일명에서 추출한 시간 라벨(예: "8시") — 공통 업로드 패널 회차 배지 표시용
  // CS 재배송으로 덧붙인 행 기록(csRecordId별). 중첩 배열이라 JSON 문자열로 저장한다.
  reshipEntries?: string;
}

/** 발주서 미리보기 작업 하나. name=보여줄 줄 이름(받는분 등), at=한 시각. 되돌리기용으로 old(고치기 전 값)·del은 지운 줄 통째로 기억 */
export type PreviewEdit =
  | { t: 'del'; k: string; name?: string; at?: number; row?: string[]; pos?: number; ord?: string; bundle?: string; recipient?: string; pricing?: { supplyPrice: number; sellingPrice: number; margin: number } | null }
  | { t: 'add'; k: string; at?: number }
  | { t: 'set'; k: string; ci: number; v: string; old?: string; name?: string; at?: number };

export interface DailyWorkspaceData {
  fakeOrderInput: string;
  manualTransfers: any[];
  expenses?: any[];
  sessionWorkflows: Record<string, { order: boolean; deposit: boolean; invoice: boolean }>;
  sessionAdjustments: Record<string, any[]>;
  sessionMemos?: Record<string, string>;
  sessionSummary?: Record<string, { orderCount: number }>;
  summaryOverrides?: Record<string, Record<string, { count: number; totalPrice: number }>>;
  /** 발주서 미리보기에서 지운 줄 (세션별) — 발주서를 다시 만들어도 다시 빼려고 저장 */
  previewRemovedRows?: Record<string, { ord: string; sig: string }[]>;
  /** 발주서 미리보기에서 한 작업 순서대로 (세션별) — 발주서를 다시 만들어도 그대로 다시 적용 */
  previewEdits?: Record<string, PreviewEdit[]>;
  companySessionRounds?: Record<string, { id: string; round: number }[]>;
  updatedAt?: any;
}

const getTodayDocId = () => new Date().toLocaleDateString('en-CA');

// ===== Session Results (세션별 문서 분리 — Firestore 1 MiB/문서 한도 회피) =====
//
// 예전 구조: 하루치 문서 1개(`{collName}/{today}`)에 { [sessionId]: data } 를 merge 로 계속 쌓음.
//            통합송장변환처럼 업체·송장이 많으면 이 문서 하나가 1 MiB 를 넘어 setDoc 이 거부됨.
// 현재 구조: `{collName}/{today}/entries/{sessionId}` 하위 컬렉션에 세션마다 문서 1개.
//            (예전 하루 문서에 남아있는 데이터는 load 시 fallback 으로 함께 읽어 마이그레이션)

const getSessionsCollectionName = (businessId?: string): string =>
  (!businessId || businessId === '안군농원') ? 'dailyWorkspaceSessions' : `dailyWorkspaceSessions_${businessId}`;

const SESSION_ENTRIES_SUBCOLLECTION = 'entries';

const getSessionEntriesRef = (businessId?: string) =>
  collection(db, getSessionsCollectionName(businessId), getTodayDocId(), SESSION_ENTRIES_SUBCOLLECTION);

const getSessionEntryRef = (sessionId: string, businessId?: string) =>
  doc(db, getSessionsCollectionName(businessId), getTodayDocId(), SESSION_ENTRIES_SUBCOLLECTION, sessionId);

export const loadSessionResults = async (businessId?: string): Promise<Record<string, SessionResultData> | null> => {
  try {
    const result: Record<string, SessionResultData> = {};
    // 예전 하루 문서(fallback): 아직 하위 컬렉션으로 옮겨지지 않은 세션 데이터
    try {
      const legacySnap = await getDoc(doc(db, getSessionsCollectionName(businessId), getTodayDocId()));
      if (legacySnap.exists()) {
        for (const [sid, data] of Object.entries(legacySnap.data() || {})) {
          if (sid === 'updatedAt') continue;
          result[sid] = data as SessionResultData;
        }
      }
    } catch { /* 예전 문서가 없거나 접근 불가면 무시 */ }
    // 현재 구조: 세션별 문서 (있으면 예전 값을 덮어씀)
    const entriesSnap = await getDocs(getSessionEntriesRef(businessId));
    entriesSnap.forEach(d => { result[d.id] = d.data() as SessionResultData; });
    return Object.keys(result).length > 0 ? result : null;
  } catch (e) {
    if (isQuotaError(e)) enterQuotaCooldown();
    return null;
  }
};

export const subscribeSessionResults = (
  callback: (results: Record<string, SessionResultData> | null) => void,
  businessId?: string
): Unsubscribe => {
  return onSnapshot(getSessionEntriesRef(businessId), (snapshot) => {
    if (snapshot.empty) { callback(null); return; }
    const result: Record<string, SessionResultData> = {};
    snapshot.forEach(d => { result[d.id] = d.data() as SessionResultData; });
    callback(result);
  }, (error) => {
    console.error('[Firestore] SessionResults 구독 오류:', error);
    callback(null);
  });
};

export const saveSessionResult = async (
  sessionId: string,
  data: SessionResultData,
  businessId?: string
): Promise<void> => {
  // merge:true — 별도로 저장된 timeLabel 등 이 data 에 없는 필드를 보존 (예전 하루 문서 구조와 동일 동작)
  await setDoc(getSessionEntryRef(sessionId, businessId), data, { merge: true });
};

// 세션 결과 전체(orderRows 등)를 다시 쓰지 않고 timeLabel 필드만 부분 갱신 (merge:true라 나머지 필드는 그대로 유지됨)
export const saveSessionTimeLabel = async (
  sessionId: string,
  timeLabel: string,
  businessId?: string
): Promise<void> => {
  await setDoc(getSessionEntryRef(sessionId, businessId), { timeLabel }, { merge: true });
};

export const deleteSessionResult = async (
  sessionId: string,
  businessId?: string
): Promise<void> => {
  await deleteDoc(getSessionEntryRef(sessionId, businessId));
  // 예전 하루 문서에 남아있을 수 있는 동일 세션 필드도 제거
  try {
    await setDoc(
      doc(db, getSessionsCollectionName(businessId), getTodayDocId()),
      { [sessionId]: deleteField() },
      { merge: true }
    );
  } catch { /* 예전 문서가 없으면 무시 */ }
};

export const clearSessionResults = async (businessId?: string): Promise<void> => {
  const entriesSnap = await getDocs(getSessionEntriesRef(businessId));
  await Promise.all(entriesSnap.docs.map(d => deleteDoc(d.ref)));
  // 예전 하루 문서도 함께 삭제
  try {
    await deleteDoc(doc(db, getSessionsCollectionName(businessId), getTodayDocId()));
  } catch { /* 없으면 무시 */ }
};

export const subscribeDailyWorkspace = (
  callback: (workspace: DailyWorkspaceData | null) => void,
  businessId?: string
): Unsubscribe => {
  const docRef = doc(db, getWorkspaceCollectionName(businessId), getTodayDocId());
  return onSnapshot(docRef, (snapshot) => {
    callback(snapshot.exists() ? snapshot.data() as DailyWorkspaceData : null);
  }, (error) => {
    console.error('[Firestore] DailyWorkspace 구독 오류:', error);
    callback(null);
  });
};

export const updateDailyWorkspaceField = async (
  field: string,
  value: any,
  businessId?: string
): Promise<void> => {
  const docRef = doc(db, getWorkspaceCollectionName(businessId), getTodayDocId());
  await setDoc(docRef, {
    [field]: value,
    updatedAt: Timestamp.now(),
  }, { merge: true });
};

// 세션별 중첩 필드를 점 표기법(dot-notation)으로 원자적 업데이트
// spread 방식 대신 이걸 써야 동시 쓰기 시 다른 세션 데이터를 덮어씌우는 race condition이 없음
export const updateDailyWorkspaceSessionField = async (
  dotPath: string,  // e.g. 'sessionAdjustments.리앤유-1-xxx'
  value: any,
  businessId?: string
): Promise<void> => {
  const docRef = doc(db, getWorkspaceCollectionName(businessId), getTodayDocId());
  try {
    await updateDoc(docRef, { [dotPath]: value, updatedAt: Timestamp.now() });
  } catch (e: any) {
    // 오늘 발주 화면을 아직 안 열어 워크스페이스 문서가 없으면 updateDoc이 "No document to update"로
    // 실패한다(통합CS현황에서 대기 CS를 바로 확정하며 정산요약 추가/차감을 쓸 때 등).
    // 이 경우 dot-path를 중첩 객체로 펴서 setDoc(merge)로 문서를 만든다.
    const notFound = e?.code === 'not-found' || String(e?.message || '').includes('No document to update');
    if (!notFound) throw e;
    const keys = dotPath.split('.');
    let nested: any = value;
    for (let i = keys.length - 1; i >= 0; i--) nested = { [keys[i]]: nested };
    await setDoc(docRef, { ...nested, updatedAt: Timestamp.now() }, { merge: true });
  }
};

export const getDailyWorkspace = async (businessId?: string): Promise<DailyWorkspaceData | null> => {
  const docRef = doc(db, getWorkspaceCollectionName(businessId), getTodayDocId());
  const snapshot = await getDoc(docRef);
  return snapshot.exists() ? snapshot.data() as DailyWorkspaceData : null;
};

// ===== 예수금(예치금) 원장 =====
// 문서 1개(사업자별)에 { [업체명]: { [YYYY-MM-DD]: 그 날짜 기준 남은 예치금 } }.
// 정산요약을 "기록"할 때마다 그날 잔액 스냅샷을 남기고, 발주 화면·업체별정산에서 이 문서만 읽는다.
// (salesHistory 문서는 발주행 등으로 크기 때문에 잔액 조회용으로는 가벼운 이 문서를 쓴다)
export type DepositLedger = Record<string, Record<string, number>>;

const getDepositLedgerRef = (businessId?: string) =>
  doc(db, 'depositLedgers', getDepositLedgerDocId(businessId));

export const loadDepositLedger = async (businessId?: string): Promise<DepositLedger> => {
  try {
    const snap = await getDoc(getDepositLedgerRef(businessId));
    return snap.exists() ? (snap.data() as DepositLedger) : {};
  } catch {
    return {};
  }
};

export const subscribeDepositLedger = (
  callback: (ledger: DepositLedger) => void,
  businessId?: string
): Unsubscribe => {
  return onSnapshot(getDepositLedgerRef(businessId), (snap) => {
    callback(snap.exists() ? (snap.data() as DepositLedger) : {});
  }, (error) => {
    console.error('[Firestore] DepositLedger 구독 오류:', error);
    callback({});
  });
};

export const setDepositLedgerBalance = async (
  company: string,
  date: string,
  balance: number,
  businessId?: string
): Promise<void> => {
  await setDoc(getDepositLedgerRef(businessId), { [company]: { [date]: balance } }, { merge: true });
};

export const removeDepositLedgerBalance = async (
  company: string,
  date: string,
  businessId?: string
): Promise<void> => {
  await setDoc(getDepositLedgerRef(businessId), { [company]: { [date]: deleteField() } }, { merge: true });
};

// ===== 예수금(예치금) 입금내역 =====
// pricingConfig(자주 덮어써지고 여러 화면이 동시에 쓰는 큰 문서)와 분리해서 전용 문서에 저장한다.
// 문서 1개(사업자별)에 { [업체명]: CompanyDeposit[] }. setDoc merge라 다른 업체 내역을 건드리지 않는다.
export type CompanyDepositsDoc = Record<string, CompanyDeposit[]>;

const getCompanyDepositsRef = (businessId?: string) =>
  doc(db, 'companyDeposits', getDepositLedgerDocId(businessId));

export const loadCompanyDeposits = async (businessId?: string): Promise<CompanyDepositsDoc> => {
  try {
    const snap = await getDoc(getCompanyDepositsRef(businessId));
    return snap.exists() ? (snap.data() as CompanyDepositsDoc) : {};
  } catch {
    return {};
  }
};

export const subscribeCompanyDeposits = (
  callback: (deposits: CompanyDepositsDoc) => void,
  businessId?: string
): Unsubscribe => {
  return onSnapshot(getCompanyDepositsRef(businessId), (snap) => {
    callback(snap.exists() ? (snap.data() as CompanyDepositsDoc) : {});
  }, (error) => {
    console.error('[Firestore] CompanyDeposits 구독 오류:', error);
    callback({});
  });
};

export const setCompanyDeposits = async (
  company: string,
  deposits: CompanyDeposit[],
  businessId?: string
): Promise<void> => {
  // memo가 undefined면 Firestore 저장 전에 제거 (ignoreUndefinedProperties가 있어도 명시적으로)
  const clean = deposits.map(d => {
    const o: CompanyDeposit = { id: d.id, date: d.date, amount: Number(d.amount) || 0 };
    if (d.memo && d.memo.trim()) o.memo = d.memo.trim();
    return o;
  });
  await setDoc(getCompanyDepositsRef(businessId), { [company]: clean }, { merge: true });
};

// ===== 배달완료 → 주문번호 매핑 (쿠팡 정산 대조 1단계) =====
// 쿠팡 배달완료 파일(Delivery 시트: B열 묶음배송번호, C열 주문번호)을 올려서
// { [묶음배송번호]: 주문번호 } 표를 사업자별로 누적 저장한다.
// 매출현황 발주내역은 예전 기록에 묶음배송번호만 있어서, 이 표로 실제 주문번호를 채운다.
//
// 한 문서에 수천 개 map 키를 몰아넣으면 쓰기가 매우 느려지므로(묶음배송번호 뒷2자리로)
// 샤드 문서 100개로 쪼갠다. 각 샤드 쓰기는 수십~수백 쌍이라 빠르고, setDoc merge로
// nested map 키가 병합되어 재업로드 시 기존 쌍은 유지된다.
export type DeliveryOrderMap = Record<string, string>;

const getLegacyDeliveryMapRef = (businessId?: string) =>
  doc(db, 'deliveryOrderMaps', getDepositLedgerDocId(businessId));

const getDeliveryShardsCol = (businessId?: string) =>
  collection(db, 'deliveryOrderMaps', getDepositLedgerDocId(businessId), 'shards');

const deliveryShardId = (bundle: string): string => {
  const d = String(bundle).replace(/[^0-9]/g, '');
  return 's' + (d.length >= 2 ? d.slice(-2) : d.padStart(2, '0'));
};

const readDeliveryShards = (snap: any): DeliveryOrderMap => {
  const map: DeliveryOrderMap = {};
  snap.forEach((d: any) => Object.assign(map, (d.data() as any).pairs || {}));
  return map;
};

export const loadDeliveryOrderMap = async (businessId?: string): Promise<DeliveryOrderMap> => {
  try {
    const [shardSnap, legacySnap] = await Promise.all([
      getDocs(getDeliveryShardsCol(businessId)),
      getDoc(getLegacyDeliveryMapRef(businessId)).catch(() => null),
    ]);
    const legacy = legacySnap && legacySnap.exists() ? ((legacySnap.data() as any).pairs || {}) : {};
    return { ...legacy, ...readDeliveryShards(shardSnap) };
  } catch {
    return {};
  }
};

const _subscribeDeliveryShards = makeSharedCollectionSub<DeliveryOrderMap>(
  (key) => getDeliveryShardsCol(key || undefined),
  readDeliveryShards,
  () => ({}),
  'DeliveryOrderMap',
);
const _deliveryLegacyCache = new Map<string, DeliveryOrderMap>();

export const subscribeDeliveryOrderMap = (
  callback: (map: DeliveryOrderMap) => void,
  businessId?: string
): Unsubscribe => {
  const key = businessId || '';
  if (!_deliveryLegacyCache.has(key)) {
    _deliveryLegacyCache.set(key, {}); // 중복 fetch 방지 플래그 겸용
    getDoc(getLegacyDeliveryMapRef(businessId))
      .then(s => { if (s.exists()) _deliveryLegacyCache.set(key, (s.data() as any).pairs || {}); })
      .catch(() => {});
  }
  return _subscribeDeliveryShards((shards) => {
    const legacy = _deliveryLegacyCache.get(key) || {};
    callback({ ...legacy, ...shards });
  }, key);
};

/** 묶음배송번호→주문번호 쌍을 샤드별로 병합 저장. 반환: 이번에 새로 추가/변경된 쌍 수 */
export const mergeDeliveryOrderMap = async (
  pairs: DeliveryOrderMap,
  businessId?: string
): Promise<number> => {
  const existing = await loadDeliveryOrderMap(businessId);
  const byShard: Record<string, DeliveryOrderMap> = {};
  let delta = 0;
  for (const [bundle, order] of Object.entries(pairs)) {
    if (!bundle || !order || existing[bundle] === order) continue;
    const sid = deliveryShardId(bundle);
    (byShard[sid] ||= {})[bundle] = order;
    delta++;
  }
  if (delta === 0) return 0;
  const col = getDeliveryShardsCol(businessId);
  const entries = Object.entries(byShard);
  // 샤드는 최대 100개(뒷2자리)라 한 배치(500 op)에 다 들어간다
  for (let i = 0; i < entries.length; i += 450) {
    const batch = writeBatch(db);
    for (const [sid, m] of entries.slice(i, i + 450)) {
      batch.set(doc(col, sid), { pairs: m }, { merge: true });
    }
    await batch.commit();
  }
  return delta;
};

export const clearDeliveryOrderMap = async (businessId?: string): Promise<void> => {
  const snap = await getDocs(getDeliveryShardsCol(businessId));
  await Promise.all([
    ...snap.docs.map(d => deleteDoc(d.ref)),
    deleteDoc(getLegacyDeliveryMapRef(businessId)).catch(() => {}),
  ]);
};

// ===== 쿠팡 정산완료 → 정산금액 매핑 (쿠팡 정산 대조 2단계) =====
// 쿠팡 정산완료 파일(Order Detail Report: A열 주문번호, R열 정산금액)을 올려서
// { [주문번호]: 정산금액 합계 } 표를 전역(사업자 무관)으로 누적 저장한다.
// 주문번호는 쿠팡 전역 고유라 안군/조에/한나 구분 없이 각 사업자 발주내역이 자기 주문번호로 조회한다.
// 한 파일에 같은 주문번호가 여러 줄(상품 + 배송료 등) → 파일 파싱 시 R열을 합산한 값을 넘긴다.
// deliveryOrderMap과 동일하게 주문번호 뒷2자리로 샤드 100개 분산.
export type SettlementMap = Record<string, number>;

const getSettlementShardsCol = () =>
  collection(db, 'settlementMaps', 'global', 'shards');

const settlementShardId = (orderNo: string): string => {
  const d = String(orderNo).replace(/[^0-9]/g, '');
  return 's' + (d.length >= 2 ? d.slice(-2) : d.padStart(2, '0'));
};

const readSettlementShards = (snap: any): SettlementMap => {
  const map: SettlementMap = {};
  snap.forEach((d: any) => Object.assign(map, (d.data() as any).amounts || {}));
  return map;
};

export const loadSettlementMap = async (): Promise<SettlementMap> => {
  try {
    return readSettlementShards(await getDocs(getSettlementShardsCol()));
  } catch {
    return {};
  }
};

export const subscribeSettlementMap = makeSharedCollectionSub<SettlementMap>(
  () => getSettlementShardsCol(),
  readSettlementShards,
  () => ({}),
  'SettlementMap',
);

// 업로드 1회분의 되돌리기 정보. 이 업로드로 실제 바뀐 주문의 "이전 값"만 담는다.
// (원래 없던 주문은 null → 되돌릴 때 그 키를 지운다)
const getSettlementUploadsCol = () =>
  collection(db, 'settlementMaps', 'global', 'uploads');
const SETTLEMENT_UPLOAD_KEEP = 5; // 최근 5회분만 보관

export interface SettlementUploadRecord {
  id: string;
  at: number;
  fileNames: string[];
  orderCount: number;
  prev: Record<string, number | null>;
}

/** 주문번호→정산금액(합계) 병합 저장. 같은 주문번호 재업로드 시 최신 값으로 덮어쓴다.
 *  되돌리기용으로 바뀐 주문의 이전 값을 uploads 문서에 함께 남긴다. */
export const mergeSettlementMap = async (
  amounts: SettlementMap,
  fileNames: string[] = [],
): Promise<{ changed: number; uploadId: string | null }> => {
  const existing = await loadSettlementMap();
  const byShard: Record<string, SettlementMap> = {};
  const prev: Record<string, number | null> = {};
  let delta = 0;
  for (const [ord, amt] of Object.entries(amounts)) {
    if (!ord || existing[ord] === amt) continue;
    (byShard[settlementShardId(ord)] ||= {})[ord] = amt;
    prev[ord] = existing[ord] ?? null;
    delta++;
  }
  if (delta === 0) return { changed: 0, uploadId: null };
  const col = getSettlementShardsCol();
  const entries = Object.entries(byShard);
  for (let i = 0; i < entries.length; i += 450) {
    const batch = writeBatch(db);
    for (const [sid, m] of entries.slice(i, i + 450)) batch.set(doc(col, sid), { amounts: m }, { merge: true });
    await batch.commit();
  }
  const uploadId = String(Date.now());
  try {
    await setDoc(doc(getSettlementUploadsCol(), uploadId), { at: Date.now(), fileNames, orderCount: delta, prev });
    await pruneSettlementUploads();
  } catch (e) {
    // 되돌리기 기록 실패해도 정산 반영 자체는 성공 — 업로드를 실패로 만들지 않는다
    console.error('[정산완료] 되돌리기 기록 저장 실패:', e);
    return { changed: delta, uploadId: null };
  }
  return { changed: delta, uploadId };
};

/** 최근 업로드 기록 목록 (최신순) */
export const loadSettlementUploads = async (): Promise<SettlementUploadRecord[]> => {
  try {
    const snap = await getDocs(getSettlementUploadsCol());
    return snap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }) as SettlementUploadRecord)
      .sort((a, b) => (b.at || 0) - (a.at || 0));
  } catch {
    return [];
  }
};

const pruneSettlementUploads = async (): Promise<void> => {
  const list = await loadSettlementUploads();
  for (const rec of list.slice(SETTLEMENT_UPLOAD_KEEP)) {
    await deleteDoc(doc(getSettlementUploadsCol(), rec.id));
  }
};

/** 업로드 1회분 삭제(되돌리기). 그 업로드로 바뀐 주문만 이전 값으로 복원(원래 없던 건 삭제).
 *  최신 업로드가 아니어도 안전하다 — 같은 주문을 나중 업로드가 또 건드렸다면 지금 값은
 *  그 나중 업로드 것이므로 건드리지 않고, 대신 그 업로드의 "이전 값"을 이번에 지우는 쪽 값으로
 *  이어붙여서(prev 체인 보정) 나중에 그걸 되돌려도 값이 어긋나지 않게 한다.
 *  반환: { restored: 실제 되돌린 주문 수, rechained: 나중 업로드로 넘긴 주문 수 } */
export const undoSettlementUpload = async (uploadId: string): Promise<{ restored: number; rechained: number }> => {
  const snapshot = await getDoc(doc(getSettlementUploadsCol(), uploadId));
  if (!snapshot.exists()) return { restored: 0, rechained: 0 };
  const target = { id: uploadId, ...(snapshot.data() as any) } as SettlementUploadRecord;
  const prev = (target.prev || {}) as Record<string, number | null>;
  // 이 업로드보다 나중에 올라온 기록들 (오래된 것부터)
  const later = (await loadSettlementUploads())
    .filter(r => r.id !== uploadId && (r.at || 0) > (target.at || 0))
    .sort((a, b) => (a.at || 0) - (b.at || 0));

  const byShard: Record<string, Record<string, any>> = {};
  const rechain: Record<string, Record<string, number | null>> = {};
  let restored = 0;
  let rechained = 0;
  for (const [ord, value] of Object.entries(prev)) {
    const owner = later.find(r => r.prev && Object.prototype.hasOwnProperty.call(r.prev, ord));
    if (owner) {
      // 지금 값의 주인은 나중 업로드 → 값은 그대로 두고 그쪽 prev만 이번 이전 값으로 교체
      (rechain[owner.id] ||= {})[ord] = value;
      rechained++;
    } else {
      (byShard[settlementShardId(ord)] ||= {})[ord] = value == null ? deleteField() : value;
      restored++;
    }
  }

  const col = getSettlementShardsCol();
  const entries = Object.entries(byShard);
  for (let i = 0; i < entries.length; i += 450) {
    const batch = writeBatch(db);
    for (const [sid, m] of entries.slice(i, i + 450)) batch.set(doc(col, sid), { amounts: m }, { merge: true });
    await batch.commit();
  }
  for (const [id, patch] of Object.entries(rechain)) {
    const owner = later.find(r => r.id === id)!;
    await setDoc(doc(getSettlementUploadsCol(), id), { prev: { ...owner.prev, ...patch } }, { merge: true });
  }
  await deleteDoc(doc(getSettlementUploadsCol(), uploadId));
  return { restored, rechained };
};

export const clearSettlementMap = async (): Promise<void> => {
  const snap = await getDocs(getSettlementShardsCol());
  for (let i = 0; i < snap.docs.length; i += 450) {
    const batch = writeBatch(db);
    snap.docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  // 전부 지웠으면 되돌릴 대상도 없다
  const ups = await getDocs(getSettlementUploadsCol());
  for (let i = 0; i < ups.docs.length; i += 450) {
    const batch = writeBatch(db);
    ups.docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
};

// ===== Quick Recipients (빠른 수령자 관리) =====

export interface QuickRecipientData {
  name: string;
  phone: string;
  address: string;
}

export const loadQuickRecipients = async (businessId?: string): Promise<QuickRecipientData[]> => {
  try {
    const docRef = doc(db, 'config', getQuickRecipientsDocId(businessId));
    const snapshot = await getDoc(docRef);
    return snapshot.exists() ? (snapshot.data().recipients || []) : [];
  } catch (e) {
    if (isQuotaError(e)) enterQuotaCooldown();
    return [];
  }
};

export const saveQuickRecipients = async (recipients: QuickRecipientData[], businessId?: string): Promise<void> => {
  const docRef = doc(db, 'config', getQuickRecipientsDocId(businessId));
  await setDoc(docRef, { recipients, updatedAt: Timestamp.now() });
};

// ===== Regular Customers (단골 리스트, 사업자 공통) =====

/** 단골이 다른 사업자에서 주문하면, 그 주문을 빼고 지정한 사업자·업체 품목으로 대신 보낸다 */
export interface RegularRedirect {
  businessId: string;      // 대신 보낼 사업자 (예: 안군농원)
  companyName: string;     // 그 사업자의 업체 (예: 나리찬)
  productKey?: string;     // 비우면 주문 상품의 무게(3kg 등)로 그 업체 품목을 자동으로 맞춤
  productName?: string;
  qty: number;             // 품목을 정해 둔 경우: 주문 1개당 보낼 수량
  keyword?: string;        // 주문 상품명에 이 말이 있을 때만 (비우면 그 단골 주문 전부)
}

export interface RegularCustomer {
  id: string;
  name: string;
  address: string;
  phone?: string;
  memo?: string;
  redirect?: RegularRedirect;
}

export const subscribeRegularCustomers = (
  callback: (customers: RegularCustomer[]) => void
): Unsubscribe => {
  const docRef = doc(db, 'config', 'regularCustomers');
  return onSnapshot(docRef, (snapshot) => {
    callback(snapshot.exists() ? (snapshot.data().customers || []) : []);
  }, (error) => {
    console.error('[Firestore] RegularCustomers 구독 오류:', error);
    if (isQuotaError(error)) enterQuotaCooldown();
  });
};

export const saveRegularCustomers = async (customers: RegularCustomer[]): Promise<void> => {
  const docRef = doc(db, 'config', 'regularCustomers');
  await setDoc(docRef, { customers, updatedAt: Timestamp.now() });
};

// ===== Pending Manual Orders (날짜 무관, 삭제 전까지 유지) =====

export const subscribeManualOrders = (
  callback: (orders: any[]) => void,
  businessId?: string
): Unsubscribe => {
  const docRef = doc(db, 'config', getManualOrdersDocId(businessId));
  return onSnapshot(docRef, (snapshot) => {
    callback(snapshot.exists() ? (snapshot.data().orders || []) : []);
  }, (error) => {
    console.error('[Firestore] ManualOrders 구독 오류:', error);
    callback([]);
  });
};

export const loadManualOrders = async (businessId?: string): Promise<any[]> => {
  try {
    const docRef = doc(db, 'config', getManualOrdersDocId(businessId));
    const snapshot = await getDoc(docRef);
    return snapshot.exists() ? (snapshot.data().orders || []) : [];
  } catch (e) {
    if (isQuotaError(e)) enterQuotaCooldown();
    return [];
  }
};

export const saveManualOrders = async (orders: any[], businessId?: string): Promise<void> => {
  const docRef = doc(db, 'config', getManualOrdersDocId(businessId));
  await setDoc(docRef, { orders, updatedAt: Timestamp.now() });
};

/**
 * 통합 수동발주 창용: 대기 목록을 서버에서 읽고 → 고치고 → 쓰는 것을 한 번에(트랜잭션) 한다.
 * 화면에 들고 있던 옛 목록으로 덮어쓰지 않으니, 다른 창에서 그사이 넣은 건이 지워지지 않는다. 바뀐 건은 건별 기록에도 남긴다.
 */
const editManualOrdersTx = async (
  businessId: string | undefined,
  edit: (orders: any[]) => any[],
  removedReason = ''
): Promise<void> => {
  const ref = doc(db, 'config', getManualOrdersDocId(businessId));
  const [prev, next] = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const existing: any[] = snap.exists() ? (snap.data().orders || []) : [];
    const updated = edit(existing);
    tx.set(ref, { orders: updated, updatedAt: Timestamp.now() });
    return [existing, updated] as const;
  });
  logManualOrderChanges(prev, next, businessId, removedReason);
};

export const addManualOrdersTx = (businessId: string | undefined, orders: any[]) =>
  editManualOrdersTx(businessId, existing => [...existing, ...orders.filter(o => !existing.some(e => e.id === o.id))]);

export const removeManualOrderTx = (businessId: string | undefined, id: string) =>
  editManualOrdersTx(businessId, existing => existing.filter(o => o.id !== id), '직접 지움');

/** 여러 건을 한 번에 지운다 (발주서에 들어간 건 정리 등) */
export const removeManualOrdersTx = (businessId: string | undefined, ids: string[], reason: string) => {
  const drop = new Set(ids);
  return editManualOrdersTx(businessId, existing => existing.filter(o => !drop.has(o.id)), reason);
};

export const updateManualOrderTx = (businessId: string | undefined, id: string, patch: Record<string, any>) =>
  editManualOrdersTx(businessId, existing => existing.map(o => (o.id === id ? { ...o, ...patch } : o)));

/**
 * 단골 대신 보내기: 다른 사업자의 수동발주에 주문을 넣는다. 한 번 넣은 주문(redirectKey)은
 * config/regularRedirectsDone에 적어 두어, 그쪽에서 발주 후 지워도 다시 들어가지 않는다.
 * 돌려준 값 = 새로 넣은 건수.
 */
export const appendRedirectedManualOrders = async (
  targetBusinessId: string,
  orders: (Record<string, any> & { id: string; redirectKey: string })[]
): Promise<number> => {
  if (orders.length === 0) return 0;
  const ordersRef = doc(db, 'config', getManualOrdersDocId(targetBusinessId));
  const doneRef = doc(db, 'config', 'regularRedirectsDone');
  return runTransaction(db, async (tx) => {
    const [ordersSnap, doneSnap] = await Promise.all([tx.get(ordersRef), tx.get(doneRef)]);
    const existing: any[] = ordersSnap.exists() ? (ordersSnap.data().orders || []) : [];
    const done: Record<string, string> = doneSnap.exists() ? (doneSnap.data().keys || {}) : {};
    const fresh = orders.filter(o => !done[o.redirectKey] && !existing.some(e => e.id === o.id));
    if (fresh.length === 0) return [] as typeof fresh;
    const now = new Date().toISOString();
    const nextDone = { ...done };
    fresh.forEach(o => { nextDone[o.redirectKey] = now; });
    // 오래된 기록(60일 지남)은 정리
    const cutoff = Date.now() - 60 * 86400000;
    Object.keys(nextDone).forEach(k => { if (Date.parse(nextDone[k]) < cutoff) delete nextDone[k]; });
    tx.set(ordersRef, { orders: [...existing, ...fresh], updatedAt: Timestamp.now() });
    tx.set(doneRef, { keys: nextDone, updatedAt: Timestamp.now() });
    return fresh;
  }).then(fresh => {
    if (fresh.length) logManualOrderChanges([], fresh, targetBusinessId, '');
    return fresh.length;
  });
};

// ===== 수동발주 등록 기록 (지워도 남는 기록) =====
// 대기 목록(pendingManualOrders)은 발주 뒤 지우고, 목록 전체를 한 문서에 덮어써서 무엇이 언제 빠졌는지 남지 않았다.
// 그래서 건마다 문서 하나(manualOrderLog[_사업자]/{주문 id})로 등록·수정·빠짐을 따로 적는다. 목록이 덮어써져도 이 기록은 그대로 있다.

export interface ManualOrderLogEntry {
  id: string;
  companyName: string;
  recipientName: string;
  phone: string;
  address: string;
  productName: string;
  qty: number;
  memo?: string;
  isSample?: boolean;
  redirectFrom?: string;
  csRecordId?: string;
  regularCustomerId?: string;
  createdAt: number;
  updatedAt: number;
  /** 대기 목록에서 빠진 때. 없으면 아직 대기 중 */
  removedAt?: number;
  /** 빠진 까닭: 직접 지움 / 대신 보내기로 옮김 / 목록에서 빠짐(직접 지우지 않았는데 사라짐) */
  removedReason?: string;
}

const getManualOrderLogCollectionName = (businessId?: string): string =>
  (!businessId || businessId === '안군농원') ? 'manualOrderLog' : `manualOrderLog_${businessId}`;

const logFields = (o: any) => {
  const f: Record<string, unknown> = {
    companyName: o.companyName || '', recipientName: o.recipientName || '', phone: o.phone || '',
    address: o.address || '', productName: o.productName || '', qty: Number(o.qty) || 0,
    memo: o.memo || '', isSample: !!o.isSample,
  };
  if (o.redirectFrom) f.redirectFrom = o.redirectFrom;
  if (o.csRecordId) f.csRecordId = o.csRecordId;
  if (o.regularCustomerId) f.regularCustomerId = o.regularCustomerId;
  return f;
};

/**
 * 대기 목록이 prev → next로 바뀐 것을 건별 기록에 적는다. 새로 생긴 건은 등록, 내용이 바뀐 건은 수정,
 * 없어진 건은 빠진 때와 까닭(removedReason, 비우면 '목록에서 빠짐')을 남긴다. 저장은 기다리지 않는다.
 */
export const logManualOrderChanges = (prev: any[], next: any[], businessId: string | undefined, removedReason: string): void => {
  const col = getManualOrderLogCollectionName(businessId);
  const prevById = new Map(prev.filter(o => o?.id).map(o => [o.id, o]));
  const nextById = new Map(next.filter(o => o?.id).map(o => [o.id, o]));
  const now = Date.now();
  const batch = writeBatch(db);
  let n = 0;
  nextById.forEach((o, id) => {
    const before = prevById.get(id);
    if (!before) {
      batch.set(doc(db, col, id), { ...logFields(o), createdAt: now, updatedAt: now, removedAt: deleteField(), removedReason: deleteField() }, { merge: true });
      n++;
    } else if (JSON.stringify(logFields(before)) !== JSON.stringify(logFields(o))) {
      batch.set(doc(db, col, id), { ...logFields(o), updatedAt: now }, { merge: true });
      n++;
    }
  });
  prevById.forEach((o, id) => {
    if (nextById.has(id)) return;
    batch.set(doc(db, col, id), { ...logFields(o), updatedAt: now, removedAt: now, removedReason: removedReason || '목록에서 빠짐' }, { merge: true });
    n++;
  });
  if (n === 0) return;
  batch.commit().catch(e => console.error('[Firestore] 수동발주 기록 저장 실패:', e));
};

/** 이 시각 이후 등록된 수동발주 기록 (발주전확인용, 한 번 읽기) */
export const loadManualOrderLogSince = async (businessId: string | undefined, sinceMs: number): Promise<ManualOrderLogEntry[]> => {
  const snap = await getDocs(query(collection(db, getManualOrderLogCollectionName(businessId)), where('createdAt', '>=', sinceMs)));
  return snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<ManualOrderLogEntry, 'id'>) }));
};

// ===== 수동입금 등록 기록 (지워도 남는 기록) =====
// 수동입금(manualTransfers)도 하루 작업공간 문서에 배열 통째로 덮어써서, 다른 창의 옛 목록이 덮으면 소리 없이 빠졌다.
// 건마다 문서 하나(manualTransferLog[_사업자]/{입금 id})로 등록·빠짐을 남겨 발주전확인이 빠진 건을 찾는다.
export interface ManualTransferLogEntry {
  id: string;
  label: string;
  bankName: string;
  accountNumber: string;
  amount: number;
  companyName?: string;
  /** 넣은 작업공간 날짜 (YYYY-MM-DD) */
  workspaceDate: string;
  createdAt: number;
  updatedAt: number;
  removedAt?: number;
  removedReason?: string;
}

const getManualTransferLogCollectionName = (businessId?: string): string =>
  (!businessId || businessId === '안군농원') ? 'manualTransferLog' : `manualTransferLog_${businessId}`;

const transferLogFields = (t: any) => {
  const f: Record<string, unknown> = {
    label: t.label || '', bankName: t.bankName || '', accountNumber: t.accountNumber || '', amount: Number(t.amount) || 0,
  };
  if (t.companyName) f.companyName = t.companyName;
  return f;
};

/** 수동입금 목록이 prev → next로 바뀐 것을 건별 기록에 적는다 (logManualOrderChanges와 같은 방식) */
export const logManualTransferChanges = (prev: any[], next: any[], businessId: string | undefined, removedReason: string): void => {
  const col = getManualTransferLogCollectionName(businessId);
  const prevById = new Map(prev.filter(t => t?.id).map(t => [t.id, t]));
  const nextById = new Map(next.filter(t => t?.id).map(t => [t.id, t]));
  const now = Date.now();
  const batch = writeBatch(db);
  let n = 0;
  nextById.forEach((t, id) => {
    const before = prevById.get(id);
    if (!before) {
      batch.set(doc(db, col, id), { ...transferLogFields(t), workspaceDate: getTodayDocId(), createdAt: now, updatedAt: now, removedAt: deleteField(), removedReason: deleteField() }, { merge: true });
      n++;
    } else if (JSON.stringify(transferLogFields(before)) !== JSON.stringify(transferLogFields(t))) {
      batch.set(doc(db, col, id), { ...transferLogFields(t), updatedAt: now }, { merge: true });
      n++;
    }
  });
  prevById.forEach((t, id) => {
    if (nextById.has(id)) return;
    batch.set(doc(db, col, id), { ...transferLogFields(t), updatedAt: now, removedAt: now, removedReason: removedReason || '목록에서 빠짐' }, { merge: true });
    n++;
  });
  if (n === 0) return;
  batch.commit().catch(e => console.error('[Firestore] 수동입금 기록 저장 실패:', e));
};

export const loadManualTransferLogSince = async (businessId: string | undefined, sinceMs: number): Promise<ManualTransferLogEntry[]> => {
  const snap = await getDocs(query(collection(db, getManualTransferLogCollectionName(businessId)), where('createdAt', '>=', sinceMs)));
  return snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<ManualTransferLogEntry, 'id'>) }));
};

/** 그날 접수한 CS (발주전확인용, 한 번 읽기) */
export const loadCsItemsByDate = async (businessId: string | undefined, date: string): Promise<OpenCsEntry[]> => {
  await ensureCsItems(businessId);
  const snap = await getDocs(query(collection(db, getCsItemsCollectionName(businessId)), where('date', '==', date)));
  return snap.docs.map(d => {
    const { open: _open, ...data } = d.data() as any;
    return { ...data, id: d.id, syncing: false } as OpenCsEntry;
  });
};

/** 오늘 날짜 문서 id (YYYY-MM-DD) — 작업공간·발주서 결과가 쓰는 날짜 */
export const todayDocId = (): string => getTodayDocId();

/** 최근 45일 발주내역을 한 번만 받아 온다 (구독을 같이 쓰고 첫 값이 오면 끊음) */
export const loadRecentOrderSearchOnce = (businessId: string | undefined): Promise<DailySales[]> =>
  new Promise(resolve => {
    let done = false;
    let unsub: Unsubscribe | null = null;
    const finish = (v: DailySales[]) => { if (done) return; done = true; resolve(v); setTimeout(() => unsub?.(), 0); };
    unsub = subscribeRecentOrderSearch(businessId, v => { if (v !== null) finish(v); });
    setTimeout(() => finish([]), 20000); // 못 받으면 빈 목록으로 (확인 창이 멈추지 않게)
  });

/** 최근 수동발주 등록 기록 (최근 등록 순, 500건까지) */
export const subscribeManualOrderLog = (
  businessId: string | undefined,
  callback: (entries: ManualOrderLogEntry[] | null) => void
): Unsubscribe => {
  const q = query(collection(db, getManualOrderLogCollectionName(businessId)), orderBy('createdAt', 'desc'), limit(500));
  return onSnapshot(q, snap => {
    callback(snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<ManualOrderLogEntry, 'id'>) })));
  }, err => {
    console.error('[Firestore] 수동발주 기록 구독 오류:', err);
    callback(null);
  });
};

// ===== Company Order (업체 순서) =====

export const loadCompanyOrder = async (businessId?: string): Promise<string[]> => {
  try {
    const docRef = doc(db, 'config', getCompanyOrderDocId(businessId));
    const snapshot = await getDoc(docRef);
    return snapshot.exists() ? (snapshot.data().order || []) : [];
  } catch {
    return [];
  }
};

export const saveCompanyOrder = async (order: string[], businessId?: string): Promise<void> => {
  const docRef = doc(db, 'config', getCompanyOrderDocId(businessId));
  await setDoc(docRef, { order, updatedAt: Timestamp.now() }, { merge: true });
};

export const loadDividerColors = async (businessId?: string): Promise<Record<string, string>> => {
  try {
    const docRef = doc(db, 'config', getCompanyOrderDocId(businessId));
    const snapshot = await getDoc(docRef);
    return snapshot.exists() ? (snapshot.data().dividerColors || {}) : {};
  } catch {
    return {};
  }
};

export const saveDividerColors = async (colors: Record<string, string>, businessId?: string): Promise<void> => {
  const docRef = doc(db, 'config', getCompanyOrderDocId(businessId));
  await setDoc(docRef, { dividerColors: colors }, { merge: true });
};

// ===== Courier Templates (택배 양식 관리) =====

export interface FakeCourierSettings {
  name: string;
  unitPrice: number;
  bankName: string;
  accountNumber: string;
  activeTemplateId?: string; // 오늘 사용한 택배대행 양식 id — 지정 시 입금목록/물류비가 해당 양식의 이름·단가·계좌를 사용 (미지정 시 위 기본값)
}

export const DEFAULT_FAKE_COURIER_SETTINGS: FakeCourierSettings = {
  name: '택배대행',
  unitPrice: 2270,
  bankName: '카카오뱅크',
  accountNumber: '3333-18-8744855',
};

export const loadCourierTemplates = async (): Promise<{ templates: CourierTemplate[]; fakeCourierSettings: FakeCourierSettings }> => {
  try {
    const docRef = doc(db, 'config', getCourierTemplatesDocId());
    const snapshot = await getDoc(docRef);
    if (snapshot.exists()) {
      const data = snapshot.data();
      return {
        templates: data.templates || [],
        fakeCourierSettings: data.fakeCourierSettings
          ? { ...DEFAULT_FAKE_COURIER_SETTINGS, ...data.fakeCourierSettings }
          : DEFAULT_FAKE_COURIER_SETTINGS,
      };
    }
  } catch {}
  return { templates: [], fakeCourierSettings: DEFAULT_FAKE_COURIER_SETTINGS };
};

export const subscribeCourierTemplates = (
  cb: (data: { templates: CourierTemplate[]; fakeCourierSettings: FakeCourierSettings }) => void
) => {
  const docRef = doc(db, 'config', getCourierTemplatesDocId());
  return onSnapshot(docRef, (snapshot) => {
    if (snapshot.exists()) {
      const data = snapshot.data();
      cb({
        templates: data.templates || [],
        fakeCourierSettings: data.fakeCourierSettings
          ? { ...DEFAULT_FAKE_COURIER_SETTINGS, ...data.fakeCourierSettings }
          : DEFAULT_FAKE_COURIER_SETTINGS,
      });
    } else {
      cb({ templates: [], fakeCourierSettings: DEFAULT_FAKE_COURIER_SETTINGS });
    }
  });
};

export const saveCourierTemplates = async (templates: CourierTemplate[]): Promise<void> => {
  const docRef = doc(db, 'config', getCourierTemplatesDocId());
  await setDoc(docRef, { templates, updatedAt: Timestamp.now() }, { merge: true });
};

export const saveFakeCourierSettings = async (settings: FakeCourierSettings): Promise<void> => {
  const docRef = doc(db, 'config', getCourierTemplatesDocId());
  await setDoc(docRef, { fakeCourierSettings: settings, updatedAt: Timestamp.now() }, { merge: true });
};

// ===== Platform Configs (멀티 플랫폼 설정) =====

export const loadPlatformConfigs = async (
  businessId?: string
): Promise<PlatformConfigs | null> => {
  try {
    const docRef = doc(db, 'config', getPlatformConfigsDocId(businessId));
    const snapshot = await getDoc(docRef);
    return snapshot.exists() ? (snapshot.data().data as PlatformConfigs) : null;
  } catch (e) {
    if (isQuotaError(e)) enterQuotaCooldown();
    return null;
  }
};

export const subscribePlatformConfigs = (
  callback: (configs: PlatformConfigs | null) => void,
  businessId?: string
): Unsubscribe => {
  const docRef = doc(db, 'config', getPlatformConfigsDocId(businessId));
  return onSnapshot(docRef, (snapshot) => {
    callback(snapshot.exists() ? (snapshot.data().data as PlatformConfigs) : null);
  }, (error) => {
    console.error('[Firestore] PlatformConfigs 구독 오류:', error);
    callback(null);
  });
};

export const savePlatformConfigs = async (
  configs: PlatformConfigs,
  businessId?: string
): Promise<void> => {
  const docRef = doc(db, 'config', getPlatformConfigsDocId(businessId));
  await setDoc(docRef, {
    data: configs,
    updatedAt: Timestamp.now(),
  });
};


// ===== Todos =====

export const subscribeTodos = (
  callback: (todos: TodoItem[] | null) => void,
  businessId?: string
): Unsubscribe => {
  const docRef = doc(db, 'config', getTodosDocId(businessId));
  return onSnapshot(docRef, (snapshot) => {
    callback(snapshot.exists() ? (snapshot.data().todos as TodoItem[]) : null);
  }, (error) => {
    console.error('[Firestore] Todos 구독 오류:', error);
    callback(null);
  });
};

export const saveTodos = async (
  todos: TodoItem[],
  businessId?: string
): Promise<void> => {
  const docRef = doc(db, 'config', getTodosDocId(businessId));
  await setDoc(docRef, {
    todos,
    updatedAt: Timestamp.now(),
  });
};

// ===== Dynamic Businesses (동적 사업자 관리) =====

export interface DynamicBusinessEntry extends BusinessInfo {
  id: string;
  createdAt: any; // Timestamp
}

export const subscribeDynamicBusinesses = (
  callback: (businesses: DynamicBusinessEntry[]) => void
): Unsubscribe => {
  const docRef = doc(db, 'config', 'dynamicBusinesses');
  return onSnapshot(docRef, (snapshot) => {
    if (snapshot.exists()) {
      callback((snapshot.data().businesses || []) as DynamicBusinessEntry[]);
    } else {
      callback([]);
    }
  }, (error) => {
    console.error('[Firestore] DynamicBusinesses 구독 오류:', error);
    callback([]);
  });
};

export const saveDynamicBusinesses = async (
  businesses: DynamicBusinessEntry[]
): Promise<void> => {
  const docRef = doc(db, 'config', 'dynamicBusinesses');
  await setDoc(docRef, {
    businesses,
    updatedAt: Timestamp.now(),
  });
};

export const loadDynamicBusinesses = async (): Promise<DynamicBusinessEntry[]> => {
  try {
    const docRef = doc(db, 'config', 'dynamicBusinesses');
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('firestore-timeout')), 8000)
    );
    const snapshot = await Promise.race([getDoc(docRef), timeout]);
    return snapshot.exists() ? ((snapshot.data().businesses || []) as DynamicBusinessEntry[]) : [];
  } catch (e) {
    if (isQuotaError(e)) enterQuotaCooldown();
    console.warn('[Firestore] loadDynamicBusinesses 실패/타임아웃, 시딩 없이 종료');
    throw e; // 빈 배열 반환 대신 throw → 시딩 코드가 Firestore를 덮어쓰는 것을 방지
  }
};

// ===== Shared Supplier Library =====

export const subscribeSharedSuppliers = (
  callback: (config: PricingConfig | null) => void
): Unsubscribe => {
  const docRef = doc(db, 'config', 'supplierLibrary');
  return onSnapshot(docRef, (snapshot) => {
    callback(snapshot.exists() ? (snapshot.data().data as PricingConfig) : null);
  }, (error) => {
    console.error('[Firestore] SharedSuppliers 구독 오류:', error);
    callback(null);
  });
};

export const saveSharedSuppliers = async (config: PricingConfig): Promise<void> => {
  const docRef = doc(db, 'config', 'supplierLibrary');
  await setDoc(docRef, { data: config, updatedAt: Timestamp.now() });
};

// ===== Urgent Notice (긴급공지) =====

export const subscribeUrgentNotice = (
  callback: (text: string) => void
): Unsubscribe => {
  const docRef = doc(db, 'config', 'urgentNotice');
  return onSnapshot(docRef, (snapshot) => {
    callback(snapshot.exists() ? (snapshot.data().text as string) || '' : '');
  }, (error) => {
    console.error('[Firestore] UrgentNotice 구독 오류:', error);
  });
};

// ===== 미션허브 연동 (가구매 미션허브가 config/missionHubFeed에 올림) =====
// fakeLines: "사업자_이름_주문번호" 줄 목록, depositText: 일괄 입금목록 붙여넣기용 TSV
// memos: 사업자별 구매 탭 상단 메모 (내용 있는 것만, 윙에서 확인완료 누른 건 confirmedAt 있음)
// checkedAt: 미션허브가 마지막으로 확인한 시각 (미션허브가 열려 있으면 5분마다 갱신)
export type MissionHubItem = { bizId: string; id: string };
export type MissionHubMemo = { bizId: string; bizName: string; memo: string; updatedAt: number; confirmedAt?: number };
export type MissionHubFeed = { fakeLines: string; depositText: string; fakeItems: MissionHubItem[]; depositItems: MissionHubItem[]; memos: MissionHubMemo[]; checkedAt: number };
const toMissionHubFeed = (data: any): MissionHubFeed => ({
      fakeLines: (data.fakeLines as string) || '',
      depositText: (data.depositText as string) || '',
      fakeItems: (data.fakeItems as MissionHubItem[]) || [],
      depositItems: (data.depositItems as MissionHubItem[]) || [],
      memos: (data.memos as MissionHubMemo[]) || [],
      checkedAt: (data.checkedAt as number) || (data.updatedAt as number) || 0,
});
export const subscribeMissionHubFeed = (
  callback: (feed: MissionHubFeed) => void
): Unsubscribe => {
  const docRef = doc(db, 'config', 'missionHubFeed');
  return onSnapshot(docRef, (snapshot) => {
    if (!snapshot.exists()) return;
    callback(toMissionHubFeed(snapshot.data()));
  }, (error) => {
    console.error('[Firestore] MissionHubFeed 구독 오류:', error);
  });
};
// 캐시 말고 서버에서 바로 읽기 — 탭이 멈춰 있다가 다시 열렸을 때 최신 내용 확인용
export const fetchMissionHubFeedFromServer = async (): Promise<MissionHubFeed | null> => {
  const snapshot = await getDocFromServer(doc(db, 'config', 'missionHubFeed'));
  return snapshot.exists() ? toMissionHubFeed(snapshot.data()) : null;
};

// ===== 미션클리어 요청 (미션허브가 status 'pending'을 받아 예약완료·입금완료 처리 후 'done'으로 바꿈) =====
export type MissionClearRequest = {
  status: 'pending' | 'done' | 'error';
  clickedAt: number;
  fakeItems: MissionHubItem[];
  depositItems: MissionHubItem[];
  reservedCount?: number;
  depositedCount?: number;
  skippedCount?: number;
  error?: string;
};
export const requestMissionClear = async (fakeItems: MissionHubItem[], depositItems: MissionHubItem[], clickedAt: number): Promise<string> => {
  const docRef = doc(collection(db, 'missionHubClearRequests'));
  await setDoc(docRef, { status: 'pending', clickedAt, fakeItems, depositItems });
  return docRef.id;
};
export const subscribeMissionClearRequest = (
  id: string,
  callback: (req: MissionClearRequest | null) => void
): Unsubscribe => {
  return onSnapshot(doc(db, 'missionHubClearRequests', id), (snapshot) => {
    callback(snapshot.exists() ? (snapshot.data() as MissionClearRequest) : null);
  }, (error) => {
    console.error('[Firestore] MissionClearRequest 구독 오류:', error);
  });
};

// ===== 가구매 주문번호 고침 요청 (미매칭 줄을 후보 주문으로 고칠 때 — 미션허브가 'pending'을 받아 그 항목 주문번호를 바꾸고 'done') =====
export type MissionOrderFixRequest = {
  status: 'pending' | 'done' | 'error';
  bizId: string;
  id: string;
  oldOrderNumber: string;
  newOrderNumber: string;
  requestedAt: number;
  error?: string;
};
export const requestMissionOrderFix = async (item: MissionHubItem, oldOrderNumber: string, newOrderNumber: string): Promise<string> => {
  const docRef = doc(collection(db, 'missionHubOrderFixes'));
  await setDoc(docRef, { status: 'pending', bizId: item.bizId, id: item.id, oldOrderNumber, newOrderNumber, requestedAt: Date.now() });
  return docRef.id;
};
export const subscribeMissionOrderFix = (
  id: string,
  callback: (req: MissionOrderFixRequest | null) => void
): Unsubscribe => {
  return onSnapshot(doc(db, 'missionHubOrderFixes', id), (snapshot) => {
    callback(snapshot.exists() ? (snapshot.data() as MissionOrderFixRequest) : null);
  }, (error) => {
    console.error('[Firestore] MissionOrderFix 구독 오류:', error);
  });
};

// ===== 미션허브 메모 확인완료·삭제 요청 (미션허브가 'pending'을 받아 그 메모를 확인완료로 표시하거나 지우고 'done') =====
// 메모 내용이 요청 때와 같을 때만 처리 — 그새 미션허브에서 고쳤으면 안 건드림
export type MissionMemoAction = 'confirm' | 'delete';
export type MissionMemoRequest = {
  status: 'pending' | 'done' | 'error';
  action: MissionMemoAction;
  bizId: string;
  memo: string;
  clickedAt: number;
  error?: string;
};
export const requestMissionMemoAction = async (bizId: string, memo: string, action: MissionMemoAction): Promise<string> => {
  const docRef = doc(collection(db, 'missionHubMemoRequests'));
  await setDoc(docRef, { status: 'pending', action, bizId, memo, clickedAt: Date.now() });
  return docRef.id;
};
export const subscribeMissionMemoRequest = (
  id: string,
  callback: (req: MissionMemoRequest | null) => void
): Unsubscribe => {
  return onSnapshot(doc(db, 'missionHubMemoRequests', id), (snapshot) => {
    callback(snapshot.exists() ? (snapshot.data() as MissionMemoRequest) : null);
  }, (error) => {
    console.error('[Firestore] MissionMemoRequest 구독 오류:', error);
  });
};

// 아직 미션허브가 처리 안 한 메모 요청 — 윙_발주에서 누르자마자 확인완료·삭제된 것으로 보이게
export type PendingMissionMemoRequest = MissionMemoRequest & { id: string };
export const subscribePendingMissionMemoRequests = (
  callback: (reqs: PendingMissionMemoRequest[]) => void
): Unsubscribe => {
  return onSnapshot(query(collection(db, 'missionHubMemoRequests'), where('status', '==', 'pending')), (snapshot) => {
    callback(snapshot.docs.map(d => ({ ...(d.data() as MissionMemoRequest), id: d.id })));
  }, (error) => {
    console.error('[Firestore] 대기 중 메모 요청 구독 오류:', error);
  });
};

export const saveUrgentNotice = async (text: string): Promise<void> => {
  const docRef = doc(db, 'config', 'urgentNotice');
  await setDoc(docRef, { text, updatedAt: Timestamp.now() });
};

// ===== Company Memos (업체별 메모 한 줄) =====
// 업체별로 한 줄 메모를 남겨두는 기능. 발주 차수/초기화/날짜 변경과 무관하게 계속 남아 있어야
// 하므로 세션이 아니라 config 문서(config/companyMemos)에 업체명 기준으로 저장한다.
// 삭제는 사용자가 명시적으로 지울 때만 일어난다(빈 문자열 저장이 아니라 키 자체를 제거).

export const subscribeCompanyMemos = (
  callback: (memos: Record<string, string>) => void
): Unsubscribe => {
  const docRef = doc(db, 'config', 'companyMemos');
  return onSnapshot(docRef, (snapshot) => {
    callback(snapshot.exists() ? ((snapshot.data().memos as Record<string, string>) || {}) : {});
  }, (error) => {
    console.error('[Firestore] CompanyMemos 구독 오류:', error);
  });
};

// 한 업체의 메모만 갱신 — 다른 컴퓨터가 동시에 수정한 다른 업체 메모를 덮어쓰지 않도록 merge 저장
export const saveCompanyMemo = async (companyName: string, text: string): Promise<void> => {
  const docRef = doc(db, 'config', 'companyMemos');
  await setDoc(docRef, { memos: { [companyName]: text }, updatedAt: Timestamp.now() }, { merge: true });
};

export const deleteCompanyMemo = async (companyName: string): Promise<void> => {
  const docRef = doc(db, 'config', 'companyMemos');
  await setDoc(docRef, { memos: { [companyName]: deleteField() }, updatedAt: Timestamp.now() }, { merge: true });
};

// ===== Trading Companies (거래 업체 + 오늘 발주 없음 알림) =====
// 지금 거래 중인 업체를 등록해 두면 주문서 패널이 그날 발주서가 없는 업체를 보여준다.
// 업체는 사업자 구분 없이 이름 기준. 알림 표시는 작업날짜별로 남긴다.
// names: true=거래 중, false=직접 뺀 업체(발주서가 와도 다시 자동 등록하지 않음)

export interface TradingCompaniesData {
  names: Record<string, boolean>;
  notified: Record<string, Record<string, boolean>>; // 작업날짜 → 업체명
  loaded?: boolean;
}

export const subscribeTradingCompanies = (
  callback: (data: TradingCompaniesData) => void
): Unsubscribe => {
  const docRef = doc(db, 'config', 'tradingCompanies');
  return onSnapshot(docRef, (snapshot) => {
    const data = snapshot.data();
    callback({ names: data?.names || {}, notified: data?.notified || {}, loaded: true });
  }, (error) => {
    console.error('[Firestore] TradingCompanies 구독 오류:', error);
  });
};

export const saveTradingCompany = async (companyName: string, on: boolean): Promise<void> => {
  const docRef = doc(db, 'config', 'tradingCompanies');
  await setDoc(docRef, { names: { [companyName]: on }, updatedAt: Timestamp.now() }, { merge: true });
};

export const saveNoOrderNotified = async (date: string, companyName: string, on: boolean): Promise<void> => {
  const docRef = doc(db, 'config', 'tradingCompanies');
  await setDoc(docRef, { notified: { [date]: { [companyName]: on ? true : deleteField() } }, updatedAt: Timestamp.now() }, { merge: true });
};

export const loadTodos = async (businessId?: string): Promise<TodoItem[] | null> => {
  try {
    const docRef = doc(db, 'config', getTodosDocId(businessId));
    const snapshot = await getDoc(docRef);
    return snapshot.exists() ? (snapshot.data().todos as TodoItem[]) : null;
  } catch (e) {
    if (isQuotaError(e)) enterQuotaCooldown();
    return null;
  }
};
