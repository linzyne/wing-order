import { useState, useEffect, useCallback, useRef } from 'react';
import { Timestamp } from 'firebase/firestore';
import { BUSINESS_INFO, registerDynamicBusiness, unregisterDynamicBusiness } from '../types';
import type { HardcodedBusinessId } from '../types';
import {
  subscribeDynamicBusinesses,
  saveDynamicBusinesses,
  savePricingConfigToFirestore,
} from '../services/firestoreService';
import type { DynamicBusinessEntry } from '../services/firestoreService';
import type { PricingConfig } from '../types';

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
}

// 하드코딩 사업자를 BusinessEntry 형태로 변환
const HARDCODED_ENTRIES: BusinessEntry[] = (Object.keys(BUSINESS_INFO) as HardcodedBusinessId[]).map(id => ({
  id,
  displayName: BUSINESS_INFO[id].displayName,
  shortName: BUSINESS_INFO[id].shortName,
  senderName: BUSINESS_INFO[id].senderName,
  phone: BUSINESS_INFO[id].phone,
  address: BUSINESS_INFO[id].address,
  themeColor: id === '조에' ? '#140a10' : '#09090b',
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
    const unsubscribe = subscribeDynamicBusinesses((businesses) => {
      // 런타임 레지스트리 갱신: ref를 통해 이전 등록 해제 (stale closure 방지)
      registeredIdsRef.current.forEach(id => unregisterDynamicBusiness(id));
      // 새로 등록
      businesses.forEach((b: DynamicBusinessEntry) => registerDynamicBusiness(b.id, {
        displayName: b.displayName,
        shortName: b.shortName,
        senderName: b.senderName,
        phone: b.phone,
        address: b.address,
        themeColor: b.themeColor,
        buttonColor: b.buttonColor,
      }));
      registeredIdsRef.current = businesses.map(b => b.id);
      dynamicBusinessesRef.current = businesses;
      setDynamicBusinesses(businesses);
      setIsLoading(false);
    });
    return () => {
      unsubscribe();
      // cleanup: ref 기반으로 레지스트리에서 해제
      registeredIdsRef.current.forEach(id => unregisterDynamicBusiness(id));
      registeredIdsRef.current = [];
    };
  }, []);

  const allBusinesses: BusinessEntry[] = [
    ...HARDCODED_ENTRIES,
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
    })),
  ];

  const addBusiness = useCallback(async (
    entry: Omit<DynamicBusinessEntry, 'createdAt'>,
    initialConfig?: PricingConfig
  ) => {
    const newEntry: DynamicBusinessEntry = {
      ...entry,
      createdAt: Timestamp.now(),
    };
    // ref를 통해 최신 목록 사용 (경쟁 조건 방지)
    const updated = [...dynamicBusinessesRef.current, newEntry];
    await saveDynamicBusinesses(updated);

    // 초기 PricingConfig가 있으면 Firestore에 저장
    if (initialConfig && Object.keys(initialConfig).length > 0) {
      await savePricingConfigToFirestore(initialConfig, entry.id);
    }
  }, []);

  const removeBusiness = useCallback(async (businessId: string) => {
    // ref를 통해 최신 목록 사용 (경쟁 조건 방지)
    const updated = dynamicBusinessesRef.current.filter(b => b.id !== businessId);
    await saveDynamicBusinesses(updated);
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
  };
};
