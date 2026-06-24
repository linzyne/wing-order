import { useState, useEffect, useCallback, useRef } from 'react';
import { FieldValue } from 'firebase/firestore';
import type { PricingConfig, PlatformConfigs, TodoItem, CourierTemplate } from '../types';
import {
  subscribePricingConfig,
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
  subscribeSharedSuppliers,
  saveSharedSuppliers,
  type DailyWorkspaceData,
  type FakeCourierSettings,
  DEFAULT_FAKE_COURIER_SETTINGS,
} from '../services/firestoreService';
import { DEFAULT_PRICING_CONFIG, DEFAULT_PRICING_CONFIG_조에 } from '../pricing';

// ===== Pricing Config Hook =====
const getPricingBackupKey = (businessId?: string) =>
  `pricingConfig_backup_${businessId || '안군농원'}`;

const savePricingBackup = (config: PricingConfig, businessId?: string) => {
  try {
    localStorage.setItem(getPricingBackupKey(businessId), JSON.stringify({
      data: config,
      savedAt: new Date().toISOString(),
    }));
  } catch {}
};

export const loadPricingBackup = (businessId?: string): { data: PricingConfig; savedAt: string } | null => {
  try {
    const raw = localStorage.getItem(getPricingBackupKey(businessId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
};

export const usePricingConfig = (businessId?: string) => {
  const defaultConfig = (!businessId || businessId === '안군농원')
    ? DEFAULT_PRICING_CONFIG
    : businessId === '조에'
      ? DEFAULT_PRICING_CONFIG_조에
      : {};
  const [config, setConfig] = useState<PricingConfig>(defaultConfig);
  const [isLoading, setIsLoading] = useState(true);
  const [configSource, setConfigSource] = useState<'loading' | 'firestore' | 'default'>('loading');
  const pendingSaves = useRef(0);
  const saveGraceUntil = useRef(0);
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    hasLoadedRef.current = false;
    setIsLoading(true);
    const unsubscribe = subscribePricingConfig((firestoreConfig, connected) => {
      if (firestoreConfig) {
        if (pendingSaves.current > 0 || Date.now() < saveGraceUntil.current) {
          // 저장 중이거나 grace 기간이라 반영은 건너뛰되, 이미 로드된 적 있으면 로딩 상태는 해제
          if (hasLoadedRef.current) setIsLoading(false);
          return;
        }
        hasLoadedRef.current = true;
        setConfig(firestoreConfig);
        setConfigSource('firestore');
        savePricingBackup(firestoreConfig, businessId);
      } else {
        if (pendingSaves.current > 0) return;
        if (hasLoadedRef.current) { setIsLoading(false); return; }
        // 연결 오류(connected=false)이고 아직 한 번도 로드 안 됐으면 → 로딩 스피너 유지
        // (2초 후 재구독이 올 때까지 빈 config로 UI 활성화하지 않음)
        if (!connected) return;
        setConfig(defaultConfig);
        setConfigSource('default');
      }
      setIsLoading(false);
    }, businessId);
    return unsubscribe;
  }, [businessId]);

  const saveConfig = useCallback(async (newConfig: PricingConfig) => {
    // Firestore에서 실제 데이터를 한 번도 받지 못한 상태에서는 절대 저장 금지
    // (초기 로드 실패 시 defaultConfig로 덮어쓰는 사고 방지)
    if (!hasLoadedRef.current) {
      console.warn('[Config] 저장 차단: Firestore 데이터 미로드 상태');
      return;
    }
    pendingSaves.current++;
    setConfig(newConfig);
    try {
      await savePricingConfigToFirestore(newConfig, businessId);
      hasLoadedRef.current = true;
      saveGraceUntil.current = Date.now() + 3000;
      savePricingBackup(newConfig, businessId);
    } catch (e) {
      console.error('[Config] Firestore 저장 실패:', e);
      saveGraceUntil.current = Date.now() + 10000;
    } finally {
      pendingSaves.current--;
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
export const useCourierTemplates = () => {
  const [courierTemplates, setCourierTemplates] = useState<CourierTemplate[]>([]);
  const [fakeCourierSettings, setFakeCourierSettings] = useState<FakeCourierSettings>(DEFAULT_FAKE_COURIER_SETTINGS);

  useEffect(() => {
    loadCourierTemplates().then(({ templates, fakeCourierSettings: settings }) => {
      setCourierTemplates(templates);
      setFakeCourierSettings(settings);
    });
  }, []);

  const saveTemplates = useCallback(async (newTemplates: CourierTemplate[]) => {
    setCourierTemplates(newTemplates);
    try {
      await saveCourierTemplatesToFirestore(newTemplates);
    } catch (e) {
      console.error('[Config] CourierTemplates 저장 실패:', e);
    }
  }, []);

  const saveFakeCourierSettings = useCallback(async (newSettings: FakeCourierSettings) => {
    setFakeCourierSettings(newSettings);
    try {
      await saveFakeCourierSettingsToFirestore(newSettings);
    } catch (e) {
      console.error('[Config] FakeCourierSettings 저장 실패:', e);
    }
  }, []);

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

// ===== Shared Supplier Library Hook =====
export const useSharedSuppliers = () => {
  const [config, setConfig] = useState<PricingConfig>({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = subscribeSharedSuppliers((cfg) => {
      setConfig(cfg || {});
      setIsLoading(false);
    });
    return unsubscribe;
  }, []);

  const saveConfig = useCallback(async (newConfig: PricingConfig) => {
    setConfig(newConfig);
    try {
      await saveSharedSuppliers(newConfig);
    } catch (e) {
      console.error('[SharedSuppliers] Firestore 저장 실패:', e);
    }
  }, []);

  return { config, saveConfig, isLoading };
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

