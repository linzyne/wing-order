import { db } from '../firebase';
import {
  doc, setDoc, updateDoc, getDoc, deleteDoc,
  collection, query, orderBy, where, getDocs,
  onSnapshot, Timestamp, deleteField,
  type Unsubscribe
} from 'firebase/firestore';
import type { PricingConfig, DailySales, PlatformConfigs, TodoItem, BusinessInfo, CourierTemplate } from '../types';

// ===== Firestore 한도 초과 감지 =====

const isQuotaError = (e: any): boolean => {
  const msg = String(e?.code || e?.message || '');
  return msg.includes('quota-exceeded') || msg.includes('RESOURCE_EXHAUSTED');
};

export const notifyQuotaExceeded = () =>
  window.dispatchEvent(new CustomEvent('firestore-quota-exceeded'));

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

const getCourierTemplatesDocId = (businessId?: string): string =>
  (!businessId || businessId === '안군농원') ? 'courierTemplates' : `courierTemplates_${businessId}`;

const getTodosDocId = (businessId?: string): string =>
  (!businessId || businessId === '안군농원') ? 'todos' : `todos_${businessId}`;

// ===== Pricing Config =====

export const subscribePricingConfig = (
  callback: (config: PricingConfig | null, connected: boolean) => void,
  businessId?: string
): Unsubscribe => {
  const docRef = doc(db, 'config', getConfigDocId(businessId));
  return onSnapshot(docRef, (snapshot) => {
    if (snapshot.exists()) {
      callback(snapshot.data().data as PricingConfig, true);
    } else {
      callback(null, true); // 문서 없음 (초기화 필요)
    }
  }, (error) => {
    console.error('[Firestore] PricingConfig 구독 오류:', error);
    callback(null, false); // 에러 - 덮어쓰기 금지
  });
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
  orderItems?: { registeredProductName: string; registeredOptionName: string; matchedProductKey: string; qty: number }[];
  includedOrderNumbers?: string[];
  unmatchedOrders?: { companyName: string; recipientName: string; productName: string; phone: string; orderNumber: string }[];
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
  updatedAt?: any;
}

const getTodayDocId = () => new Date().toLocaleDateString('en-CA');

// ===== Session Results (별도 문서 — 대용량 데이터 분리) =====

const getSessionsCollectionName = (businessId?: string): string =>
  (!businessId || businessId === '안군농원') ? 'dailyWorkspaceSessions' : `dailyWorkspaceSessions_${businessId}`;

export const loadSessionResults = async (businessId?: string): Promise<Record<string, SessionResultData> | null> => {
  try {
    const docRef = doc(db, getSessionsCollectionName(businessId), getTodayDocId());
    const snapshot = await getDoc(docRef);
    return snapshot.exists() ? (snapshot.data() as Record<string, SessionResultData>) : null;
  } catch (e) {
    if (isQuotaError(e)) notifyQuotaExceeded();
    return null;
  }
};

export const subscribeSessionResults = (
  callback: (results: Record<string, SessionResultData> | null) => void,
  businessId?: string
): Unsubscribe => {
  const docRef = doc(db, getSessionsCollectionName(businessId), getTodayDocId());
  return onSnapshot(docRef, (snapshot) => {
    callback(snapshot.exists() ? (snapshot.data() as Record<string, SessionResultData>) : null);
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
  const docRef = doc(db, getSessionsCollectionName(businessId), getTodayDocId());
  await setDoc(docRef, { [sessionId]: data }, { merge: true });
};

export const deleteSessionResult = async (
  sessionId: string,
  businessId?: string
): Promise<void> => {
  const docRef = doc(db, getSessionsCollectionName(businessId), getTodayDocId());
  await setDoc(docRef, { [sessionId]: deleteField() }, { merge: true });
};

export const clearSessionResults = async (businessId?: string): Promise<void> => {
  const docRef = doc(db, getSessionsCollectionName(businessId), getTodayDocId());
  await deleteDoc(docRef);
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
}

export const DEFAULT_FAKE_COURIER_SETTINGS: FakeCourierSettings = {
  name: '택배대행',
  unitPrice: 2270,
  bankName: '카카오뱅크',
  accountNumber: '3333-18-8744855',
};

export const loadCourierTemplates = async (
  businessId?: string
): Promise<{ templates: CourierTemplate[]; fakeCourierSettings: FakeCourierSettings }> => {
  try {
    const docRef = doc(db, 'config', getCourierTemplatesDocId(businessId));
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

export const saveCourierTemplates = async (templates: CourierTemplate[], businessId?: string): Promise<void> => {
  const docRef = doc(db, 'config', getCourierTemplatesDocId(businessId));
  await setDoc(docRef, { templates, updatedAt: Timestamp.now() }, { merge: true });
};

export const saveFakeCourierSettings = async (settings: FakeCourierSettings, businessId?: string): Promise<void> => {
  const docRef = doc(db, 'config', getCourierTemplatesDocId(businessId));
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
    const snapshot = await getDoc(docRef);
    return snapshot.exists() ? ((snapshot.data().businesses || []) as DynamicBusinessEntry[]) : [];
  } catch (e) {
    if (isQuotaError(e)) notifyQuotaExceeded();
    return [];
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
