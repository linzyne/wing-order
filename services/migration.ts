import { doc, getDoc, setDoc, Timestamp, runTransaction } from 'firebase/firestore';
import { db } from '../firebase';
import type { PricingConfig, DailySales } from '../types';
import { DEFAULT_PRICING_CONFIG, DEFAULT_PRICING_CONFIG_조에 } from '../pricing';

const MIGRATION_FLAG = 'firestore_migration_done';

// 사업자별 Firestore 경로 (firestoreService.ts와 동일 로직)
const getConfigDocId = (businessId?: string): string =>
  (!businessId || businessId === '안군농원') ? 'pricingConfig' : `pricingConfig_${businessId}`;

export const migrateLocalStorageToFirestore = async (): Promise<boolean> => {
  if (localStorage.getItem(MIGRATION_FLAG) === 'true') return false;

  let migrated = false;

  // 1. pricingConfig 마이그레이션
  const pricingStr = localStorage.getItem('pricingConfig');
  if (pricingStr) {
    try {
      const config = JSON.parse(pricingStr) as PricingConfig;
      const docRef = doc(db, 'config', 'pricingConfig');
      const existing = await getDoc(docRef);
      if (!existing.exists()) {
        await setDoc(docRef, { data: config, updatedAt: Timestamp.now() });
        migrated = true;
        console.log('[Migration] pricingConfig 마이그레이션 완료');
      }
    } catch (e) {
      console.error('[Migration] pricingConfig 실패:', e);
    }
  }

  // 2. salesHistory 마이그레이션
  const salesStr = localStorage.getItem('salesHistory');
  if (salesStr) {
    try {
      const history = JSON.parse(salesStr) as DailySales[];
      for (const daily of history) {
        const docRef = doc(db, 'salesHistory', daily.date);
        const existing = await getDoc(docRef);
        if (!existing.exists()) {
          await setDoc(docRef, daily);
        }
      }
      migrated = true;
      console.log(`[Migration] ${history.length}개 매출 기록 마이그레이션 완료`);
    } catch (e) {
      console.error('[Migration] salesHistory 실패:', e);
    }
  }

  // 3. 당일 작업 데이터 마이그레이션
  const today = new Date().toISOString().slice(0, 10);
  const fakeOrderInput = localStorage.getItem('fakeOrderInput') || '';
  const manualTransfersStr = localStorage.getItem('manualTransfers');
  const manualTransfersDate = localStorage.getItem('manualTransfersDate');

  if (fakeOrderInput || (manualTransfersStr && manualTransfersDate === today)) {
    try {
      const docRef = doc(db, 'dailyWorkspace', today);
      const existing = await getDoc(docRef);
      if (!existing.exists()) {
        await setDoc(docRef, {
          fakeOrderInput,
          manualTransfers: manualTransfersStr ? JSON.parse(manualTransfersStr) : [],
          sessionWorkflows: {},
          sessionAdjustments: {},
          updatedAt: Timestamp.now(),
        });
        migrated = true;
        console.log('[Migration] 당일 작업 데이터 마이그레이션 완료');
      }
    } catch (e) {
      console.error('[Migration] dailyWorkspace 실패:', e);
    }
  }

  localStorage.setItem(MIGRATION_FLAG, 'true');
  return migrated;
};

// 코드의 sellingPrice/margin을 Firestore에 자동 병합 (트랜잭션으로 안전하게)
export const syncPricingFields = async (businessId?: string): Promise<boolean> => {
  const defaultConfig = (!businessId || businessId === '안군농원') ? DEFAULT_PRICING_CONFIG : DEFAULT_PRICING_CONFIG_조에;
  try {
    const docRef = doc(db, 'config', getConfigDocId(businessId));
    return await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(docRef);
      if (!snapshot.exists()) return false;

      const firestoreConfig = snapshot.data().data as PricingConfig;
      let updated = false;

      for (const [companyName, defaultCompany] of Object.entries(defaultConfig)) {
        if (!firestoreConfig[companyName]) continue;

        for (const [productKey, defaultProduct] of Object.entries(defaultCompany.products)) {
          const fsProduct = firestoreConfig[companyName].products[productKey];
          if (!fsProduct) continue;

          if (defaultProduct.sellingPrice != null && fsProduct.sellingPrice === undefined) {
            fsProduct.sellingPrice = defaultProduct.sellingPrice;
            updated = true;
          }
          if (defaultProduct.margin != null && fsProduct.margin === undefined) {
            fsProduct.margin = defaultProduct.margin;
            updated = true;
          }
        }
      }

      if (updated) {
        transaction.set(docRef, { data: firestoreConfig, updatedAt: Timestamp.now() });
        console.log('[Sync] sellingPrice/margin Firestore 동기화 완료');
      }
      return updated;
    });
  } catch (e) {
    console.error('[Sync] sellingPrice/margin 동기화 실패:', e);
    return false;
  }
};
