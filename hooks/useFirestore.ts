import { useState, useEffect, useCallback, useRef } from 'react';
import type { PricingConfig, PlatformConfigs, TodoItem, CourierTemplate } from '../types';
import {
  subscribePricingConfig,
  savePricingConfigToFirestore,
  subscribeDailyWorkspace,
  updateDailyWorkspaceField,
  subscribePlatformConfigs,
  savePlatformConfigs,
  subscribeTodos,
  saveTodos as saveTodosToFirestore,
  subscribeCourierTemplates,
  saveCourierTemplates as saveCourierTemplatesToFirestore,
  type DailyWorkspaceData,
} from '../services/firestoreService';
import { DEFAULT_PRICING_CONFIG, DEFAULT_PRICING_CONFIG_조에 } from '../pricing';

// ===== Pricing Config Hook =====
export const usePricingConfig = (businessId?: string) => {
  const defaultConfig = (!businessId || businessId === '안군농원')
    ? DEFAULT_PRICING_CONFIG
    : businessId === '조에'
      ? DEFAULT_PRICING_CONFIG_조에
      : {}; // 동적 사업자는 빈 config로 시작
  const [config, setConfig] = useState<PricingConfig>(defaultConfig);
  const [isLoading, setIsLoading] = useState(true);
  const [configSource, setConfigSource] = useState<'loading' | 'firestore' | 'default'>('loading');
  // 저장 진행 중 카운터 + 저장 완료 후 유예 타이머 (구독 덮어쓰기 방지)
  const pendingSaves = useRef(0);
  const saveGraceUntil = useRef(0);

  useEffect(() => {
    setIsLoading(true);
    const unsubscribe = subscribePricingConfig((firestoreConfig, connected) => {
      if (firestoreConfig) {
        // 저장 중이거나 유예 기간이면 구독 업데이트 무시 (로컬 변경이 덮어쓰이는 것 방지)
        if (pendingSaves.current > 0 || Date.now() < saveGraceUntil.current) {
          return;
        }
        console.log('[Config] Firestore에서 로드 완료, 업체 수:', Object.keys(firestoreConfig).length);
        setConfig(firestoreConfig);
        setConfigSource('firestore');
      } else if (connected) {
        // 저장 중이면 기본값 초기화도 차단 (저장 직후 snapshot 지연 시 안전)
        if (pendingSaves.current > 0) return;
        // 문서가 존재하지 않음 → 기본값으로 초기화 (안전)
        console.warn('[Config] Firestore 문서 없음 → 기본값으로 초기화');
        savePricingConfigToFirestore(defaultConfig, businessId).catch(e =>
          console.error('[Config] 기본값 저장 실패:', e)
        );
        setConfig(defaultConfig);
        setConfigSource('default');
      } else {
        // 연결 오류 → 저장 중이면 로컬 상태 유지, 아니면 기본값 표시
        if (pendingSaves.current > 0) return;
        console.error('[Config] Firestore 연결 오류 → 기본값 표시 (덮어쓰기 안함)');
        setConfig(defaultConfig);
        setConfigSource('default');
      }
      setIsLoading(false);
    }, businessId);
    return unsubscribe;
  }, [businessId]);

  const saveConfig = useCallback(async (newConfig: PricingConfig) => {
    pendingSaves.current++;
    setConfig(newConfig);
    try {
      await savePricingConfigToFirestore(newConfig, businessId);
      // 저장 완료 후 1초간 유예 (서버 확인 snapshot이 도착할 때까지)
      saveGraceUntil.current = Date.now() + 1000;
    } catch (e) {
      console.error('[Config] Firestore 저장 실패:', e);
    } finally {
      pendingSaves.current--;
    }
  }, [businessId]);

  return { config, saveConfig, isLoading, configSource };
};

// ===== Platform Configs Hook =====
export const usePlatformConfigs = (businessId?: string) => {
  const [platformConfigs, setPlatformConfigs] = useState<PlatformConfigs>({});
  const pendingSaves = useRef(0);
  const saveGraceUntil = useRef(0);

  useEffect(() => {
    const unsubscribe = subscribePlatformConfigs((configs) => {
      if (pendingSaves.current > 0 || Date.now() < saveGraceUntil.current) return;
      setPlatformConfigs(configs || {});
    }, businessId);
    return unsubscribe;
  }, [businessId]);

  const savePlatformConfig = useCallback(async (newConfigs: PlatformConfigs) => {
    pendingSaves.current++;
    setPlatformConfigs(newConfigs);
    try {
      await savePlatformConfigs(newConfigs, businessId);
      saveGraceUntil.current = Date.now() + 1000;
    } catch (e) {
      console.error('[Config] PlatformConfigs 저장 실패:', e);
    } finally {
      pendingSaves.current--;
    }
  }, [businessId]);

  return { platformConfigs, savePlatformConfig };
};

// ===== Courier Templates Hook =====
export const useCourierTemplates = (businessId?: string) => {
  const [courierTemplates, setCourierTemplates] = useState<CourierTemplate[]>([]);
  const pendingSaves = useRef(0);
  const saveGraceUntil = useRef(0);

  useEffect(() => {
    const unsubscribe = subscribeCourierTemplates((templates) => {
      if (pendingSaves.current > 0 || Date.now() < saveGraceUntil.current) return;
      setCourierTemplates(templates);
    }, businessId);
    return unsubscribe;
  }, [businessId]);

  const saveTemplates = useCallback(async (newTemplates: CourierTemplate[]) => {
    pendingSaves.current++;
    setCourierTemplates(newTemplates);
    try {
      await saveCourierTemplatesToFirestore(newTemplates, businessId);
      saveGraceUntil.current = Date.now() + 1000;
    } catch (e) {
      console.error('[Config] CourierTemplates 저장 실패:', e);
    } finally {
      pendingSaves.current--;
    }
  }, [businessId]);

  return { courierTemplates, saveTemplates };
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
