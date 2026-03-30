import { db } from '../firebase';
import {
  doc, setDoc, getDoc, deleteDoc,
  collection, query, orderBy, getDocs,
  onSnapshot, Timestamp,
  type Unsubscribe
} from 'firebase/firestore';
import type { PricingConfig, DailySales, PlatformConfigs, TodoItem } from '../types';

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

const getCompanyOrderDocId = (businessId?: string): string =>
  (!businessId || businessId === '안군농원') ? 'companyOrder' : `companyOrder_${businessId}`;

// 플랫폼 감지 설정(헤더 매칭 등)은 사업자 공통이므로 항상 같은 문서 사용
const getPlatformConfigsDocId = (_businessId?: string): string => 'platformConfigs';

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
  return snapshot.docs.map(d => {
    const data = d.data() as any;
    // Firestore에 JSON 문자열로 저장된 중첩 배열을 역직렬화
    if (typeof data.orderRows === 'string') {
      try { data.orderRows = JSON.parse(data.orderRows); } catch { data.orderRows = undefined; }
    }
    if (typeof data.invoiceRows === 'string') {
      try { data.invoiceRows = JSON.parse(data.invoiceRows); } catch { data.invoiceRows = undefined; }
    }
    return data as DailySales;
  });
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
  await setDoc(docRef, serialized);
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
  unmatchedOrders?: { companyName: string; recipientName: string; productName: string; phone: string; orderNumber: string }[];
}

export interface DailyWorkspaceData {
  fakeOrderInput: string;
  manualTransfers: any[];
  expenses?: any[];
  sessionWorkflows: Record<string, { order: boolean; deposit: boolean; invoice: boolean }>;
  sessionAdjustments: Record<string, any[]>;
  sessionResults?: Record<string, SessionResultData>;
  updatedAt?: any;
}

const getTodayDocId = () => new Date().toISOString().slice(0, 10);

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

export const getDailyWorkspace = async (businessId?: string): Promise<DailyWorkspaceData | null> => {
  const docRef = doc(db, getWorkspaceCollectionName(businessId), getTodayDocId());
  const snapshot = await getDoc(docRef);
  return snapshot.exists() ? snapshot.data() as DailyWorkspaceData : null;
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

export const saveManualOrders = async (orders: any[], businessId?: string): Promise<void> => {
  const docRef = doc(db, 'config', getManualOrdersDocId(businessId));
  await setDoc(docRef, { orders, updatedAt: Timestamp.now() });
};

// ===== Company Order (업체 순서) =====

export const subscribeCompanyOrder = (
  callback: (order: string[]) => void,
  businessId?: string
): Unsubscribe => {
  const docRef = doc(db, 'config', getCompanyOrderDocId(businessId));
  return onSnapshot(docRef, (snapshot) => {
    callback(snapshot.exists() ? (snapshot.data().order || []) : []);
  }, (error) => {
    console.error('[Firestore] CompanyOrder 구독 오류:', error);
    callback([]);
  });
};

export const saveCompanyOrder = async (order: string[], businessId?: string): Promise<void> => {
  const docRef = doc(db, 'config', getCompanyOrderDocId(businessId));
  await setDoc(docRef, { order, updatedAt: Timestamp.now() });
};

// ===== Platform Configs (멀티 플랫폼 설정) =====

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
