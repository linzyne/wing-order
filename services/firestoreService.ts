import { db } from '../firebase';
import {
  doc, setDoc, updateDoc, getDoc, deleteDoc,
  collection, query, orderBy, where, getDocs,
  onSnapshot, getDocFromServer, getDocFromCache, Timestamp, deleteField, writeBatch,
  type Unsubscribe
} from 'firebase/firestore';
import { isCsFullyCompleted } from '../types';
import type { PricingConfig, DailySales, PlatformConfigs, TodoItem, BusinessInfo, CourierTemplate, CompanyDeposit } from '../types';

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

// ===== Sales History =====

// loadAllSalesHistory는 사업자별 매출 문서 전체(수십~수백 건)를 매번 읽는다.
// 통합CS현황 / 주문서업로드 대기CS / 주문자검색 패널이 마운트·이벤트마다 사업자별로 호출해
// Firestore 읽기가 폭증하던 것을 짧은 TTL 인메모리 캐시로 억제한다.
// 쓰기(upsert/delete)가 나가면 해당 사업자 캐시를 즉시 무효화하므로 최신성은 유지된다.
const SALES_HISTORY_TTL_MS = 90 * 1000;
const salesHistoryCache = new Map<string, { at: number; promise: Promise<DailySales[]> }>();
const invalidateSalesHistoryCache = (businessId?: string): void => {
  salesHistoryCache.delete(getSalesCollectionName(businessId));
  csHistoryCache.delete(getSalesCollectionName(businessId));
};

// ===== CS 전용 저장소 =====
// CS 기록은 매출 문서(발주·송장 행 등 수십KB)와 따로 csHistory[_사업자]/{날짜} 작은 문서에 둔다.
// 예전엔 CS 몇 줄을 보려고 매출 문서를 통째로 받아서 대기·접수 목록과 저장이 느렸다.
// 문서: { date, records: CsRecord[], hasOpen } — hasOpen은 미완료·대기 CS가 하나라도 있으면 true
type CsRecords = NonNullable<DailySales['csRecords']>;
type ReturnRecords = NonNullable<DailySales['returnRecords']>;
const csHistoryCache = new Map<string, { at: number; promise: Promise<DailySales[]> }>();
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

// 미완료(접수 중) 또는 대기저장 CS가 하나라도 있는 날짜만 { date, csRecords }로 반환한다
export const loadOpenCsHistory = async (businessId?: string): Promise<DailySales[]> => {
  const key = getSalesCollectionName(businessId);
  const cached = csHistoryCache.get(key);
  if (cached && Date.now() - cached.at < SALES_HISTORY_TTL_MS) return cached.promise;
  const promise = (async () => {
    await ensureCsSplit(businessId);
    const snapshot = await getDocs(query(collection(db, getCsCollectionName(businessId)), where('hasOpen', '==', true)));
    return snapshot.docs
      .map(d => ({ date: d.id, csRecords: (d.data().records || []) as CsRecords } as DailySales))
      .sort((a, b) => b.date.localeCompare(a.date));
  })();
  csHistoryCache.set(key, { at: Date.now(), promise });
  promise.catch(() => csHistoryCache.delete(key));
  return promise;
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

// CS·반품기록 저장 — CS는 csHistory 작은 문서만 고쳐 쓴다. 반품기록은 업무일지 마진에 들어가서 매출 문서에 있으므로
// mutateReturns를 줄 때(반품을 넣거나 뺄 때)만 매출 문서를 읽고 고친다.
// 같은 날짜에 연달아 눌러도 읽기-수정-쓰기가 서로 덮어쓰지 않도록 날짜별로 순서대로 실행.
const csWriteChains = new Map<string, Promise<unknown>>();
export const saveCsAndReturns = (
  date: string,
  businessId: string | undefined,
  mutateCs: ((records: CsRecords) => CsRecords | null) | null,
  mutateReturns?: ((records: ReturnRecords) => ReturnRecords) | null
): Promise<boolean> => {
  const key = `${getSalesCollectionName(businessId)}/${date}`;
  const run = async (): Promise<boolean> => {
    await ensureCsSplit(businessId);
    const batch = writeBatch(db);
    let changed = false;
    if (mutateCs) {
      const csRef = doc(db, getCsCollectionName(businessId), date);
      const snapshot = await getDoc(csRef);
      const next = mutateCs(snapshot.exists() ? (snapshot.data().records || []) as CsRecords : []);
      if (!next) return false;
      if (next.length > 0) { batch.set(csRef, csDocFields(date, next)); changed = true; }
      else if (snapshot.exists()) { batch.delete(csRef); changed = true; }
    }
    if (mutateReturns) {
      const salesRef = doc(db, getSalesCollectionName(businessId), date);
      const snapshot = await getDoc(salesRef);
      const data = snapshot.exists() ? snapshot.data() : null;
      const current = (data?.returnRecords || []) as ReturnRecords;
      const next = mutateReturns(current);
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        const returnTotal = next.reduce((s, r) => s + r.totalMargin, 0);
        if (data) {
          batch.update(salesRef, {
            returnRecords: next.length > 0 ? next : deleteField(),
            returnTotal: returnTotal || deleteField(),
          });
        } else {
          // 그날 매출 문서가 아직 없으면 빈 문서로 만든다 (deleteField는 새 문서에 못 씀)
          const created: any = { date, records: [], totalAmount: 0, savedAt: new Date().toISOString(), returnRecords: next };
          if (returnTotal) created.returnTotal = returnTotal;
          batch.set(salesRef, created);
        }
        changed = true;
      }
    }
    if (changed) {
      await batch.commit();
      invalidateSalesHistoryCache(businessId);
    }
    return true;
  };
  const prev = csWriteChains.get(key) || Promise.resolve();
  const result = prev.catch(() => {}).then(run);
  csWriteChains.set(key, result);
  result.finally(() => { if (csWriteChains.get(key) === result) csWriteChains.delete(key); }).catch(() => {});
  return result;
};

// CS 기록만 고쳐 쓰기 (상태 변경 등). 그날 CS가 없으면 false
export const updateCsRecords = (
  date: string,
  businessId: string | undefined,
  mutate: (records: CsRecords) => CsRecords | null
): Promise<boolean> => saveCsAndReturns(date, businessId, records => (records.length > 0 ? mutate(records) : null));

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
  await setDoc(ref, sales ? orderSearchFields(sales) : { date, empty: true });
  return sales || null;
};

// 주문자 검색·CS 접수용 — 최근 며칠 색인만 날짜 키로 바로 읽는다.
// 이틀 넘게 지난 날짜의 발주행은 바뀌지 않으므로 브라우저 캐시에 있으면 서버에 안 묻는다.
export const loadRecentSalesForSearch = async (businessId: string | undefined, days: number): Promise<DailySales[]> => {
  const now = new Date();
  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  const docs = await Promise.all(dates.map((date, i) => loadOrderSearchDoc(businessId, date, i >= 2)));
  return docs.filter((d): d is DailySales => !!d);
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
  unmatchedOrders?: { companyName: string; recipientName: string; productName: string; phone: string; orderNumber: string }[];
  timeLabel?: string; // 업로드 파일명에서 추출한 시간 라벨(예: "8시") — 공통 업로드 패널 회차 배지 표시용
  // CS 재배송으로 덧붙인 행 기록(csRecordId별). 중첩 배열이라 JSON 문자열로 저장한다.
  reshipEntries?: string;
}

export interface DailyWorkspaceData {
  fakeOrderInput: string;
  manualTransfers: any[];
  expenses?: any[];
  sessionWorkflows: Record<string, { order: boolean; deposit: boolean; invoice: boolean }>;
  sessionAdjustments: Record<string, any[]>;
  sessionMemos?: Record<string, string>;
  sessionSummary?: Record<string, { orderCount: number }>;
  summaryOverrides?: Record<string, Record<string, { count: number; totalPrice: number }>>;
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

export interface RegularCustomer {
  id: string;
  name: string;
  address: string;
  phone?: string;
  memo?: string;
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
