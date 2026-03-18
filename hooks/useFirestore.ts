import { useState, useEffect, useCallback, useRef } from 'react';
import type { PricingConfig } from '../types';
import {
  subscribePricingConfig,
  savePricingConfigToFirestore,
  subscribeDailyWorkspace,
  updateDailyWorkspaceField,
  type DailyWorkspaceData,
} from '../services/firestoreService';
import { DEFAULT_PRICING_CONFIG, DEFAULT_PRICING_CONFIG_조에 } from '../pricing';

// ===== Pricing Config Hook =====
export const usePricingConfig = (businessId?: string) => {
  const defaultConfig = (!businessId || businessId === '안군농원') ? DEFAULT_PRICING_CONFIG : DEFAULT_PRICING_CONFIG_조에;
  const [config, setConfig] = useState<PricingConfig>(defaultConfig);
  const [isLoading, setIsLoading] = useState(true);
  const [configSource, setConfigSource] = useState<'loading' | 'firestore' | 'default'>('loading');
  const savingUntil = useRef(0);

  useEffect(() => {
    setIsLoading(true);
    const unsubscribe = subscribePricingConfig((firestoreConfig, connected) => {
      if (firestoreConfig) {
        // 저장 중일 때는 구독 업데이트를 무시 (로컬 변경이 덮어쓰이는 것 방지)
        if (Date.now() < savingUntil.current) {
          return;
        }
        console.log('[Config] Firestore에서 로드 완료, 업체 수:', Object.keys(firestoreConfig).length);
        setConfig(firestoreConfig);
        setConfigSource('firestore');
      } else if (connected) {
        // 문서가 존재하지 않음 → 기본값으로 초기화 (안전)
        console.warn('[Config] Firestore 문서 없음 → 기본값으로 초기화');
        savePricingConfigToFirestore(defaultConfig, businessId).catch(e =>
          console.error('[Config] 기본값 저장 실패:', e)
        );
        setConfig(defaultConfig);
        setConfigSource('default');
      } else {
        // 연결 오류 → 기본값 표시하되 Firestore 덮어쓰기 금지
        console.error('[Config] Firestore 연결 오류 → 기본값 표시 (덮어쓰기 안함)');
        setConfig(defaultConfig);
        setConfigSource('default');
      }
      setIsLoading(false);
    }, businessId);
    return unsubscribe;
  }, [businessId]);

  const saveConfig = useCallback(async (newConfig: PricingConfig) => {
    // 저장 완료 후 2초간 구독 업데이트 차단 (stale snapshot 방지)
    savingUntil.current = Date.now() + 2000;
    setConfig(newConfig);
    try {
      await savePricingConfigToFirestore(newConfig, businessId);
    } catch (e) {
      console.error('[Config] Firestore 저장 실패:', e);
      savingUntil.current = 0; // 실패 시 즉시 구독 복원
    }
  }, [businessId]);

  return { config, saveConfig, isLoading, configSource };
};

// ===== Daily Workspace Hook =====
export const useDailyWorkspace = (businessId?: string) => {
  const [workspace, setWorkspace] = useState<DailyWorkspaceData | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeDailyWorkspace((data) => {
      setWorkspace(data);
      setIsReady(true);
    }, businessId);
    return unsubscribe;
  }, [businessId]);

  const updateField = useCallback(async (field: string, value: any) => {
    await updateDailyWorkspaceField(field, value, businessId);
  }, [businessId]);

  return { workspace, updateField, isReady };
};
