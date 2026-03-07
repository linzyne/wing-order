import { useState, useEffect, useCallback, useRef } from 'react';
import type { PricingConfig } from '../types';
import {
  subscribePricingConfig,
  savePricingConfigToFirestore,
  subscribeDailyWorkspace,
  updateDailyWorkspaceField,
  type DailyWorkspaceData,
} from '../services/firestoreService';
import { DEFAULT_PRICING_CONFIG } from '../pricing';

// ===== Pricing Config Hook =====
export const usePricingConfig = () => {
  const [config, setConfig] = useState<PricingConfig>(DEFAULT_PRICING_CONFIG);
  const [isLoading, setIsLoading] = useState(true);
  const [configSource, setConfigSource] = useState<'loading' | 'firestore' | 'default'>('loading');

  useEffect(() => {
    const unsubscribe = subscribePricingConfig((firestoreConfig) => {
      if (firestoreConfig) {
        console.log('[Config] Firestore에서 로드 완료, 업체 수:', Object.keys(firestoreConfig).length);
        setConfig(firestoreConfig);
        setConfigSource('firestore');
      } else {
        console.warn('[Config] Firestore 데이터 없음 → 기본값 사용');
        savePricingConfigToFirestore(DEFAULT_PRICING_CONFIG);
        setConfig(DEFAULT_PRICING_CONFIG);
        setConfigSource('default');
      }
      setIsLoading(false);
    });
    return unsubscribe;
  }, []);

  const saveConfig = useCallback(async (newConfig: PricingConfig) => {
    setConfig(newConfig);
    await savePricingConfigToFirestore(newConfig);
  }, []);

  return { config, saveConfig, isLoading, configSource };
};

// ===== Daily Workspace Hook =====
export const useDailyWorkspace = () => {
  const [workspace, setWorkspace] = useState<DailyWorkspaceData | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeDailyWorkspace((data) => {
      setWorkspace(data);
      setIsReady(true);
    });
    return unsubscribe;
  }, []);

  const updateField = useCallback(async (field: string, value: any) => {
    await updateDailyWorkspaceField(field, value);
  }, []);

  return { workspace, updateField, isReady };
};
