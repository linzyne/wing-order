import { useState, useEffect, useCallback, useRef } from 'react';
import { Timestamp } from 'firebase/firestore';
import { BUSINESS_INFO, registerDynamicBusiness, unregisterDynamicBusiness } from '../types';
import type { HardcodedBusinessId } from '../types';
import {
  loadDynamicBusinesses,
  saveDynamicBusinesses,
  savePricingConfigToFirestore,
} from '../services/firestoreService';
import type { DynamicBusinessEntry } from '../services/firestoreService';
import type { PricingConfig } from '../types';

const BUSINESSES_BACKUP_KEY = 'dynamicBusinesses_backup';

const saveBusinessesBackup = (businesses: DynamicBusinessEntry[]) => {
  try {
    localStorage.setItem(BUSINESSES_BACKUP_KEY, JSON.stringify(businesses));
  } catch {}
};

const loadBusinessesBackup = (): DynamicBusinessEntry[] | null => {
  try {
    const raw = localStorage.getItem(BUSINESSES_BACKUP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};

export interface BusinessEntry {
  id: string;
  displayName: string;
  shortName: string;
  senderName: string;
  phone: string;
  address: string;
  themeColor: string;
  buttonColor: string;
  isDynamic: boolean;
  bank?: string;
}

// 하드코딩 사업자를 BusinessEntry 형태로 변환
const HARDCODED_ENTRIES: BusinessEntry[] = (Object.keys(BUSINESS_INFO) as HardcodedBusinessId[]).map(id => ({
  id,
  displayName: BUSINESS_INFO[id].displayName,
  shortName: BUSINESS_INFO[id].shortName,
  senderName: BUSINESS_INFO[id].senderName,
  phone: BUSINESS_INFO[id].phone,
  address: BUSINESS_INFO[id].address,
  themeColor: id === '조에' ? '#f472b6' : '#09090b',
  buttonColor: id === '조에' ? '#f472b6' : '#f43f5e',
  isDynamic: false,
}));

export const useBusinessList = () => {
  const [dynamicBusinesses, setDynamicBusinesses] = useState<DynamicBusinessEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // ref로 현재 등록된 ID를 추적 (stale closure 방지)
  const registeredIdsRef = useRef<string[]>([]);
  // 최신 dynamicBusinesses를 ref로도 유지 (addBusiness/removeBusiness 경쟁 조건 방지)
  const dynamicBusinessesRef = useRef<DynamicBusinessEntry[]>([]);

  useEffect(() => {
    loadDynamicBusinesses().then(async (businesses) => {
      // 사업자가 1개 미만이면 Firestore 로드 실패로 간주 → 시딩 금지
      // (정상적으로는 최소 '안군농원', '조에' 2개 이상 존재)
      if (businesses.length === 0) {
        const backup = loadBusinessesBackup();
        if (backup && backup.length > 0) {
          console.warn('[BusinessList] Firestore 빈 결과 → 로컬 백업으로 복원');
          businesses = backup;
        } else {
          console.warn('[BusinessList] Firestore 빈 결과, 백업 없음 → 시딩 없이 종료');
          setIsLoading(false);
          return;
        }
      }

      // 하드코딩 사업자가 Firestore에 없으면 앞에 시딩
      const hardcodedIds: HardcodedBusinessId[] = ['안군농원', '조에'];
      const toSeed: DynamicBusinessEntry[] = [];
      for (const hId of hardcodedIds) {
        if (!businesses.find(b => b.id === hId)) {
          const info = BUSINESS_INFO[hId];
          toSeed.push({
            id: hId,
            displayName: info.displayName,
            shortName: info.shortName,
            senderName: info.senderName,
            phone: info.phone,
            address: info.address,
            themeColor: hId === '조에' ? '#f472b6' : '#09090b',
            buttonColor: hId === '조에' ? '#f472b6' : '#f43f5e',
            createdAt: Timestamp.now(),
          });
        }
      }
      const allEntries = [...toSeed, ...businesses];
      if (toSeed.length > 0) await saveDynamicBusinesses(allEntries);
      saveBusinessesBackup(allEntries);

      registeredIdsRef.current.forEach(id => unregisterDynamicBusiness(id));
      allEntries.forEach((b: DynamicBusinessEntry) => registerDynamicBusiness(b.id, {
        displayName: b.displayName,
        shortName: b.shortName,
        senderName: b.senderName,
        phone: b.phone,
        address: b.address,
        themeColor: b.themeColor,
        buttonColor: b.buttonColor,
      }));
      registeredIdsRef.current = allEntries.map(b => b.id);
      dynamicBusinessesRef.current = allEntries;
      setDynamicBusinesses(allEntries);
      setIsLoading(false);
    }).catch(() => {
      setIsLoading(false);
    });
    return () => {
      registeredIdsRef.current.forEach(id => unregisterDynamicBusiness(id));
      registeredIdsRef.current = [];
    };
  }, []);

  const dynamicIds = new Set(dynamicBusinesses.map(b => b.id));
  const allBusinesses: BusinessEntry[] = [
    ...HARDCODED_ENTRIES.filter(h => !dynamicIds.has(h.id)),
    ...dynamicBusinesses.map(b => ({
      id: b.id,
      displayName: b.displayName,
      shortName: b.shortName,
      senderName: b.senderName,
      phone: b.phone,
      address: b.address,
      themeColor: b.themeColor || '#09090b',
      buttonColor: b.buttonColor || '#8b5cf6',
      isDynamic: true,
      bank: b.bank,
    })),
  ];

  const addBusiness = useCallback(async (
    entry: Omit<DynamicBusinessEntry, 'createdAt'>,
    initialConfig?: PricingConfig
  ) => {
    const newEntry: DynamicBusinessEntry = { ...entry, createdAt: Timestamp.now() };
    const updated = [...dynamicBusinessesRef.current, newEntry];
    await saveDynamicBusinesses(updated);
    registerDynamicBusiness(newEntry.id, {
      displayName: newEntry.displayName, shortName: newEntry.shortName,
      senderName: newEntry.senderName, phone: newEntry.phone,
      address: newEntry.address, themeColor: newEntry.themeColor, buttonColor: newEntry.buttonColor,
    });
    registeredIdsRef.current = [...registeredIdsRef.current, newEntry.id];
    dynamicBusinessesRef.current = updated;
    setDynamicBusinesses(updated);
    if (initialConfig && Object.keys(initialConfig).length > 0) {
      await savePricingConfigToFirestore(initialConfig, entry.id);
    }
  }, []);

  const removeBusiness = useCallback(async (businessId: string) => {
    const updated = dynamicBusinessesRef.current.filter(b => b.id !== businessId);
    await saveDynamicBusinesses(updated);
    unregisterDynamicBusiness(businessId);
    registeredIdsRef.current = registeredIdsRef.current.filter(id => id !== businessId);
    dynamicBusinessesRef.current = updated;
    setDynamicBusinesses(updated);
  }, []);

  const updateBusiness = useCallback(async (
    businessId: string,
    updates: Partial<Omit<DynamicBusinessEntry, 'id' | 'createdAt'>>
  ) => {
    const updated = dynamicBusinessesRef.current.map(b =>
      b.id === businessId ? { ...b, ...updates } : b
    );
    await saveDynamicBusinesses(updated);
    const entry = updated.find(b => b.id === businessId);
    if (entry) {
      registerDynamicBusiness(businessId, {
        displayName: entry.displayName, shortName: entry.shortName,
        senderName: entry.senderName, phone: entry.phone,
        address: entry.address, themeColor: entry.themeColor, buttonColor: entry.buttonColor,
      });
    }
    dynamicBusinessesRef.current = updated;
    setDynamicBusinesses(updated);
  }, []);

  return {
    businesses: allBusinesses,
    dynamicBusinesses: dynamicBusinesses.map(b => ({
      ...b,
      isDynamic: true as const,
    })),
    isLoading,
    addBusiness,
    removeBusiness,
    updateBusiness,
  };
};
