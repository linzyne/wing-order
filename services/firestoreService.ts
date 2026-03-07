import { db } from '../firebase';
import {
  doc, setDoc, getDoc, deleteDoc,
  collection, query, orderBy, getDocs,
  onSnapshot, Timestamp,
  type Unsubscribe
} from 'firebase/firestore';
import type { PricingConfig, DailySales } from '../types';

// ===== Pricing Config =====

export const subscribePricingConfig = (
  callback: (config: PricingConfig | null) => void
): Unsubscribe => {
  const docRef = doc(db, 'config', 'pricingConfig');
  return onSnapshot(docRef, (snapshot) => {
    if (snapshot.exists()) {
      callback(snapshot.data().data as PricingConfig);
    } else {
      callback(null);
    }
  }, (error) => {
    console.error('[Firestore] PricingConfig 구독 오류:', error);
    callback(null);
  });
};

export const savePricingConfigToFirestore = async (
  config: PricingConfig
): Promise<void> => {
  const docRef = doc(db, 'config', 'pricingConfig');
  await setDoc(docRef, {
    data: config,
    updatedAt: Timestamp.now(),
  });
};

// ===== Sales History =====

export const loadAllSalesHistory = async (): Promise<DailySales[]> => {
  const q = query(
    collection(db, 'salesHistory'),
    orderBy('date', 'desc')
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map(d => d.data() as DailySales);
};

export const upsertDailySales = async (
  dailySales: DailySales
): Promise<void> => {
  const docRef = doc(db, 'salesHistory', dailySales.date);
  await setDoc(docRef, dailySales);
};

export const deleteDailySalesFromFirestore = async (
  date: string
): Promise<void> => {
  const docRef = doc(db, 'salesHistory', date);
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
}

export interface DailyWorkspaceData {
  fakeOrderInput: string;
  manualTransfers: any[];
  sessionWorkflows: Record<string, { order: boolean; deposit: boolean; invoice: boolean }>;
  sessionAdjustments: Record<string, any[]>;
  sessionResults?: Record<string, SessionResultData>;
  updatedAt?: any;
}

const getTodayDocId = () => new Date().toISOString().slice(0, 10);

export const subscribeDailyWorkspace = (
  callback: (workspace: DailyWorkspaceData | null) => void
): Unsubscribe => {
  const docRef = doc(db, 'dailyWorkspace', getTodayDocId());
  return onSnapshot(docRef, (snapshot) => {
    callback(snapshot.exists() ? snapshot.data() as DailyWorkspaceData : null);
  }, (error) => {
    console.error('[Firestore] DailyWorkspace 구독 오류:', error);
    callback(null);
  });
};

export const updateDailyWorkspaceField = async (
  field: string,
  value: any
): Promise<void> => {
  const docRef = doc(db, 'dailyWorkspace', getTodayDocId());
  await setDoc(docRef, {
    [field]: value,
    updatedAt: Timestamp.now(),
  }, { merge: true });
};

export const getDailyWorkspace = async (): Promise<DailyWorkspaceData | null> => {
  const docRef = doc(db, 'dailyWorkspace', getTodayDocId());
  const snapshot = await getDoc(docRef);
  return snapshot.exists() ? snapshot.data() as DailyWorkspaceData : null;
};

// ===== Pending Manual Orders (날짜 무관, 삭제 전까지 유지) =====

export const subscribeManualOrders = (
  callback: (orders: any[]) => void
): Unsubscribe => {
  const docRef = doc(db, 'config', 'pendingManualOrders');
  return onSnapshot(docRef, (snapshot) => {
    callback(snapshot.exists() ? (snapshot.data().orders || []) : []);
  }, (error) => {
    console.error('[Firestore] ManualOrders 구독 오류:', error);
    callback([]);
  });
};

export const saveManualOrders = async (orders: any[]): Promise<void> => {
  const docRef = doc(db, 'config', 'pendingManualOrders');
  await setDoc(docRef, { orders, updatedAt: Timestamp.now() });
};
