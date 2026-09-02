import { db } from '../firebase';
import {
  doc, setDoc, updateDoc, getDoc, deleteDoc,
  collection, query, orderBy, where, getDocs,
  onSnapshot, Timestamp, deleteField, writeBatch,
  type Unsubscribe
} from 'firebase/firestore';
import type { PricingConfig, DailySales, PlatformConfigs, TodoItem, BusinessInfo, CourierTemplate, CompanyDeposit } from '../types';

// ===== Firestore 한도 초과 감지 =====

const isQuotaError = (e: any): boolean => {
  const msg = String(e?.code || e?.message || '');
  return msg.includes('quota-exceeded') || msg.includes('RESOURCE_EXHAUSTED');
};

export const notifyQuotaExceeded = () =>
  window.dispatchEvent(new CustomEvent('firestore-quota-exceeded'));

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

  const subscribe = () => {
    currentUnsub = onSnapshot(docRef, (snapshot) => {
      if (!active) return;
      if (snapshot.exists()) {
        callback(snapshot.data().data as PricingConfig, true);
      } else {
        callback(null, true);
      }
    }, (error) => {
      if (!active) return;
      console.error('[Firestore] PricingConfig 구독 오류:', error);
      callback(null, false);
      // 구독이 종료됐으므로 2초 후 재구독 (failed-precondition 등 일시적 오류 복구)
      retryTimer = setTimeout(() => {
        if (active) subscribe();
      }, 2000);
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
    if (isQuotaError(e)) notifyQuotaExceeded();
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

export const loadAllSalesHistory = async (businessId?: string): Promise<DailySales[]> => {
  const q = query(
    collection(db, getSalesCollectionName(businessId)),
    orderBy('date', 'desc')
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map(d => deserializeDailySales({ ...d.data() }));
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
  const docRef = doc(db, getSalesCollectionName(businessId), dailySales.date);
  // Firestore는 중첩 배열을 지원하지 않으므로 JSON 문자열로 직렬화
  const serialized: any = { ...dailySales };
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
  await setDoc(docRef, serialized);
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
  const docRef = doc(db, getSalesCollectionName(businessId), date);
  await deleteDoc(docRef);
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
  orderItems?: { registeredProductName: string; registeredOptionName: string; matchedProductKey: string; qty: number; recipientName?: string; orderNumber?: string; bundleNumber?: string }[];
  includedOrderNumbers?: string[];
  rowOrderNumbers?: string[]; // orderRows와 동일한 순서/길이의 원본 주문번호 목록
  rowBundleNumbers?: string[]; // orderRows와 동일한 순서/길이의 묶음배송번호 목록
  rowRecipientNames?: string[]; // orderRows와 동일한 순서/길이의 수취인 이름 목록
  rowPricing?: { supplyPrice: number; sellingPrice: number; margin: number }[]; // orderRows와 동일한 순서/길이의 공급가/판매가/마진 목록
  unmatchedOrders?: { companyName: string; recipientName: string; productName: string; phone: string; orderNumber: string }[];
  timeLabel?: string; // 업로드 파일명에서 추출한 시간 라벨(예: "8시") — 공통 업로드 패널 회차 배지 표시용
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
    if (isQuotaError(e)) notifyQuotaExceeded();
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
  await updateDoc(docRef, { [dotPath]: value, updatedAt: Timestamp.now() });
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

export const subscribeDeliveryOrderMap = (
  callback: (map: DeliveryOrderMap) => void,
  businessId?: string
): Unsubscribe => {
  let legacy: DeliveryOrderMap = {};
  getDoc(getLegacyDeliveryMapRef(businessId))
    .then(s => { if (s.exists()) { legacy = (s.data() as any).pairs || {}; } })
    .catch(() => {});
  return onSnapshot(getDeliveryShardsCol(businessId), (snap) => {
    callback({ ...legacy, ...readDeliveryShards(snap) });
  }, (error) => {
    console.error('[Firestore] DeliveryOrderMap 구독 오류:', error);
    callback({});
  });
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

export const subscribeSettlementMap = (callback: (map: SettlementMap) => void): Unsubscribe => {
  return onSnapshot(getSettlementShardsCol(), (snap) => {
    callback(readSettlementShards(snap));
  }, (error) => {
    console.error('[Firestore] SettlementMap 구독 오류:', error);
    callback({});
  });
};

/** 주문번호→정산금액(합계) 병합 저장. 같은 주문번호 재업로드 시 최신 값으로 덮어쓴다. 반환: 추가/변경된 주문 수 */
export const mergeSettlementMap = async (amounts: SettlementMap): Promise<number> => {
  const existing = await loadSettlementMap();
  const byShard: Record<string, SettlementMap> = {};
  let delta = 0;
  for (const [ord, amt] of Object.entries(amounts)) {
    if (!ord || existing[ord] === amt) continue;
    (byShard[settlementShardId(ord)] ||= {})[ord] = amt;
    delta++;
  }
  if (delta === 0) return 0;
  const col = getSettlementShardsCol();
  const entries = Object.entries(byShard);
  for (let i = 0; i < entries.length; i += 450) {
    const batch = writeBatch(db);
    for (const [sid, m] of entries.slice(i, i + 450)) batch.set(doc(col, sid), { amounts: m }, { merge: true });
    await batch.commit();
  }
  return delta;
};

export const clearSettlementMap = async (): Promise<void> => {
  const snap = await getDocs(getSettlementShardsCol());
  for (let i = 0; i < snap.docs.length; i += 450) {
    const batch = writeBatch(db);
    snap.docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
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
    if (isQuotaError(e)) notifyQuotaExceeded();
    return [];
  }
};

export const saveQuickRecipients = async (recipients: QuickRecipientData[], businessId?: string): Promise<void> => {
  const docRef = doc(db, 'config', getQuickRecipientsDocId(businessId));
  await setDoc(docRef, { recipients, updatedAt: Timestamp.now() });
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
    if (isQuotaError(e)) notifyQuotaExceeded();
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
    if (isQuotaError(e)) notifyQuotaExceeded();
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
    if (isQuotaError(e)) notifyQuotaExceeded();
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

export const saveUrgentNotice = async (text: string): Promise<void> => {
  const docRef = doc(db, 'config', 'urgentNotice');
  await setDoc(docRef, { text, updatedAt: Timestamp.now() });
};

export const loadTodos = async (businessId?: string): Promise<TodoItem[] | null> => {
  try {
    const docRef = doc(db, 'config', getTodosDocId(businessId));
    const snapshot = await getDoc(docRef);
    return snapshot.exists() ? (snapshot.data().todos as TodoItem[]) : null;
  } catch (e) {
    if (isQuotaError(e)) notifyQuotaExceeded();
    return null;
  }
};
