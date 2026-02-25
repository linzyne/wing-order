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

  useEffect(() => {
    const unsubscribe = subscribePricingConfig((firestoreConfig) => {
      if (firestoreConfig) {
        setConfig(firestoreConfig);
      } else {
        // Firestore에 데이터가 없으면 기본값으로 초기화
        savePricingConfigToFirestore(DEFAULT_PRICING_CONFIG);
        setConfig(DEFAULT_PRICING_CONFIG);
      }
      setIsLoading(false);
    });
    return unsubscribe;
  }, []);

  const saveConfig = useCallback(async (newConfig: PricingConfig) => {
    setConfig(newConfig);
    await savePricingConfigToFirestore(newConfig);
  }, []);

  return { config, saveConfig, isLoading };
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
