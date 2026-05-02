import { useState, useEffect, useCallback, useRef } from 'react';
import type { PricingConfig, PlatformConfigs, TodoItem, CourierTemplate } from '../types';
import {
  loadPricingConfig,
  savePricingConfigToFirestore,
  subscribeDailyWorkspace,
  updateDailyWorkspaceField,
  loadPlatformConfigs,
  savePlatformConfigs,
  subscribeTodos,
  saveTodos as saveTodosToFirestore,
  loadCourierTemplates,
  saveCourierTemplates as saveCourierTemplatesToFirestore,
  saveFakeCourierSettings as saveFakeCourierSettingsToFirestore,
  subscribeSessionResults,
  type DailyWorkspaceData,
  type SessionResultData,
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
  // businessId를 ref로 추적하여 stale subscription 콜백 방지
  const currentBusinessIdRef = useRef(businessId);

  useEffect(() => {
    // businessId 변경 시 이전 데이터 즉시 클리어 (교차 오염 방지)
    currentBusinessIdRef.current = businessId;
    setWorkspace(null);
    setIsReady(false);
    const unsubscribe = subscribeDailyWorkspace((data) => {
      // businessId가 변경된 후 도착한 stale snapshot 무시
      if (currentBusinessIdRef.current !== businessId) return;
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

// ===== Session Results Hook (별도 문서 구독) =====
export const useSessionResults = (businessId?: string) => {
  const [sessionResults, setSessionResults] = useState<Record<string, SessionResultData> | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeSessionResults((results) => {
      setSessionResults(results);
    }, businessId);
    return unsubscribe;
  }, [businessId]);

  return sessionResults;
};

// ===== Todos Hook =====
export const useTodos = (businessId?: string) => {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const pendingSaves = useRef(0);
  const saveGraceUntil = useRef(0);

  // localStorage에서 기존 데이터 마이그레이션 (한 번만)
  useEffect(() => {
    const migrateFromLocalStorage = async () => {
      const saved = localStorage.getItem('todos');
      if (saved) {
        try {
          const localTodos = JSON.parse(saved);
          if (Array.isArray(localTodos) && localTodos.length > 0) {
            console.log('[Todos] localStorage → Firestore 마이그레이션:', localTodos.length, '개');
            await saveTodosToFirestore(localTodos, businessId);
            localStorage.removeItem('todos'); // 마이그레이션 후 삭제
          }
        } catch (error) {
          console.error('[Todos] 마이그레이션 실패:', error);
        }
      }
    };
    migrateFromLocalStorage();
  }, [businessId]);

  useEffect(() => {
    const unsubscribe = subscribeTodos((firestoreTodos) => {
      if (pendingSaves.current > 0 || Date.now() < saveGraceUntil.current) return;

      if (firestoreTodos) {
        setTodos(firestoreTodos);
      } else {
        // 문서가 없으면 빈 배열로 초기화
        setTodos([]);
      }
      setIsLoading(false);
    }, businessId);

    return unsubscribe;
  }, [businessId]);

  const saveTodos = useCallback(async (newTodos: TodoItem[]) => {
    pendingSaves.current++;
    setTodos(newTodos);
    try {
      await saveTodosToFirestore(newTodos, businessId);
      saveGraceUntil.current = Date.now() + 1000;
    } catch (error) {
      console.error('[Todos] Firestore 저장 실패:', error);
    } finally {
      pendingSaves.current--;
    }
  }, [businessId]);

  return { todos, saveTodos, isLoading };
};

// ===== All Business Workspaces Hook (하드코딩 + 동적 사업자 동시 구독) =====
const HARDCODED_BUSINESS_IDS: string[] = ['안군농원', '조에'];

export const useAllBusinessWorkspaces = (dynamicBusinessIds: string[] = []) => {
  const [workspaces, setWorkspaces] = useState<Record<string, DailyWorkspaceData | null>>({
    '안군농원': null,
    '조에': null,
  });
  const [isReady, setIsReady] = useState(false);

  // 동적 ID를 JSON으로 직렬화하여 의존성 안정화
  const dynamicIdsKey = JSON.stringify(dynamicBusinessIds);

  useEffect(() => {
    const allIds = [...HARDCODED_BUSINESS_IDS, ...dynamicBusinessIds];
    setIsReady(false);

    // 삭제된 사업자의 stale 키 정리: 현재 구독 대상에 없는 키 제거
    setWorkspaces((prev) => {
      const cleaned: Record<string, DailyWorkspaceData | null> = {};
      for (const id of allIds) cleaned[id] = prev[id] ?? null;
      return cleaned;
    });

    const allIdsSet = new Set(allIds);
    const receivedCount = new Set<string>();
    const unsubscribes = allIds.map((bid) =>
      subscribeDailyWorkspace((data) => {
        // 이미 구독 해제된(삭제된) 사업자의 stale 콜백 무시
        if (!allIdsSet.has(bid)) return;
        setWorkspaces((prev) => ({ ...prev, [bid]: data }));
        receivedCount.add(bid);
        if (receivedCount.size >= allIds.length) setIsReady(true);
      }, bid)
    );

    return () => unsubscribes.forEach((unsub) => unsub());
  }, [dynamicIdsKey]);

  return { workspaces, isReady };
};
