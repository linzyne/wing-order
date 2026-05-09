import { useState, useEffect, useCallback, useRef } from 'react';
import { FieldValue } from 'firebase/firestore';
import type { PricingConfig, PlatformConfigs, TodoItem, CourierTemplate } from '../types';
import {
  loadPricingConfig,
  savePricingConfigToFirestore,
  getDailyWorkspace,
  updateDailyWorkspaceField,
  updateDailyWorkspaceSessionField,
  loadPlatformConfigs,
  savePlatformConfigs,
  loadTodos,
  saveTodos as saveTodosToFirestore,
  loadCourierTemplates,
  saveCourierTemplates as saveCourierTemplatesToFirestore,
  saveFakeCourierSettings as saveFakeCourierSettingsToFirestore,
  type DailyWorkspaceData,
  type FakeCourierSettings,
  DEFAULT_FAKE_COURIER_SETTINGS,
} from '../services/firestoreService';
import { DEFAULT_PRICING_CONFIG, DEFAULT_PRICING_CONFIG_조에 } from '../pricing';

// ===== Pricing Config Hook =====
export const usePricingConfig = (businessId?: string) => {
  const defaultConfig = (!businessId || businessId === '안군농원')
    ? DEFAULT_PRICING_CONFIG
    : businessId === '조에'
      ? DEFAULT_PRICING_CONFIG_조에
      : {};
  const [config, setConfig] = useState<PricingConfig>(defaultConfig);
  const [isLoading, setIsLoading] = useState(true);
  const [configSource, setConfigSource] = useState<'loading' | 'firestore' | 'default'>('loading');

  useEffect(() => {
    setIsLoading(true);
    loadPricingConfig(businessId).then(({ config: firestoreConfig, exists }) => {
      if (firestoreConfig) {
        setConfig(firestoreConfig);
        setConfigSource('firestore');
      } else if (!exists) {
        savePricingConfigToFirestore(defaultConfig, businessId).catch(e =>
          console.error('[Config] 기본값 저장 실패:', e)
        );
        setConfig(defaultConfig);
        setConfigSource('default');
      } else {
        setConfig(defaultConfig);
        setConfigSource('default');
      }
      setIsLoading(false);
    });
  }, [businessId]);

  const saveConfig = useCallback(async (newConfig: PricingConfig) => {
    setConfig(newConfig);
    try {
      await savePricingConfigToFirestore(newConfig, businessId);
    } catch (e) {
      console.error('[Config] Firestore 저장 실패:', e);
    }
  }, [businessId]);

  return { config, saveConfig, isLoading, configSource };
};

// ===== Platform Configs Hook =====
export const usePlatformConfigs = (businessId?: string) => {
  const [platformConfigs, setPlatformConfigs] = useState<PlatformConfigs>({});

  useEffect(() => {
    loadPlatformConfigs(businessId).then(configs => {
      setPlatformConfigs(configs || {});
    });
  }, [businessId]);

  const savePlatformConfig = useCallback(async (newConfigs: PlatformConfigs) => {
    setPlatformConfigs(newConfigs);
    try {
      await savePlatformConfigs(newConfigs, businessId);
    } catch (e) {
      console.error('[Config] PlatformConfigs 저장 실패:', e);
    }
  }, [businessId]);

  return { platformConfigs, savePlatformConfig };
};

// ===== Courier Templates Hook =====
export const useCourierTemplates = (businessId?: string) => {
  const [courierTemplates, setCourierTemplates] = useState<CourierTemplate[]>([]);
  const [fakeCourierSettings, setFakeCourierSettings] = useState<FakeCourierSettings>(DEFAULT_FAKE_COURIER_SETTINGS);

  useEffect(() => {
    setCourierTemplates([]);
    setFakeCourierSettings(DEFAULT_FAKE_COURIER_SETTINGS);
    loadCourierTemplates(businessId).then(({ templates, fakeCourierSettings: settings }) => {
      setCourierTemplates(templates);
      setFakeCourierSettings(settings);
    });
  }, [businessId]);

  const saveTemplates = useCallback(async (newTemplates: CourierTemplate[]) => {
    setCourierTemplates(newTemplates);
    try {
      await saveCourierTemplatesToFirestore(newTemplates, businessId);
    } catch (e) {
      console.error('[Config] CourierTemplates 저장 실패:', e);
    }
  }, [businessId]);

  const saveFakeCourierSettings = useCallback(async (newSettings: FakeCourierSettings) => {
    setFakeCourierSettings(newSettings);
    try {
      await saveFakeCourierSettingsToFirestore(newSettings, businessId);
    } catch (e) {
      console.error('[Config] FakeCourierSettings 저장 실패:', e);
    }
  }, [businessId]);

  return { courierTemplates, saveTemplates, fakeCourierSettings, saveFakeCourierSettings };
};

// ===== Daily Workspace Hook =====
export const useDailyWorkspace = (businessId?: string) => {
  const [workspace, setWorkspace] = useState<DailyWorkspaceData | null>(null);
  const [isReady, setIsReady] = useState(false);
  const currentBusinessIdRef = useRef(businessId);

  useEffect(() => {
    currentBusinessIdRef.current = businessId;
    setWorkspace(null);
    setIsReady(false);
    getDailyWorkspace(businessId).then(data => {
      if (currentBusinessIdRef.current !== businessId) return;
      setWorkspace(data);
      setIsReady(true);
    });
  }, [businessId]);

  const updateField = useCallback(async (field: string, value: any) => {
    setWorkspace(prev => prev ? { ...prev, [field]: value } : { [field]: value } as DailyWorkspaceData);
    await updateDailyWorkspaceField(field, value, businessId);
  }, [businessId]);

  const updateSessionField = useCallback(async (dotPath: string, value: any) => {
    const dotIdx = dotPath.indexOf('.');
    if (dotIdx !== -1) {
      const topKey = dotPath.slice(0, dotIdx);
      const subKey = dotPath.slice(dotIdx + 1);
      setWorkspace(prev => {
        if (!prev) return prev;
        const top: Record<string, any> = { ...((prev as any)[topKey] || {}) };
        if (value instanceof FieldValue) {
          delete top[subKey];
        } else {
          top[subKey] = value;
        }
        return { ...prev, [topKey]: top };
      });
    }
    await updateDailyWorkspaceSessionField(dotPath, value, businessId);
  }, [businessId]);

  return { workspace, setWorkspace, updateField, updateSessionField, isReady };
};

// ===== Todos Hook =====
export const useTodos = (businessId?: string) => {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // localStorage에서 기존 데이터 마이그레이션 (한 번만)
  useEffect(() => {
    const saved = localStorage.getItem('todos');
    if (saved) {
      try {
        const localTodos = JSON.parse(saved);
        if (Array.isArray(localTodos) && localTodos.length > 0) {
          saveTodosToFirestore(localTodos, businessId);
          localStorage.removeItem('todos');
        }
      } catch {}
    }
  }, [businessId]);

  useEffect(() => {
    setIsLoading(true);
    loadTodos(businessId).then(firestoreTodos => {
      setTodos(firestoreTodos || []);
      setIsLoading(false);
    });
  }, [businessId]);

  const saveTodos = useCallback(async (newTodos: TodoItem[]) => {
    setTodos(newTodos);
    try {
      await saveTodosToFirestore(newTodos, businessId);
    } catch (error) {
      console.error('[Todos] Firestore 저장 실패:', error);
    }
  }, [businessId]);

  return { todos, saveTodos, isLoading };
};

