
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import CompanyWorkstationRow from './CompanyWorkstationRow';
import FileUpload from './FileUpload';
import type { PricingConfig, ManualOrder, ExcludedOrder, MarginRecord, SalesRecord, DailySales, ExpenseRecord, PlatformConfigs, PlatformConfig } from '../types';
import { BUSINESS_INFO } from '../types';
import { BuildingStorefrontIcon, ArrowDownTrayIcon, TrashIcon, PlusCircleIcon, BoltIcon, ClipboardDocumentCheckIcon, ArrowPathIcon, ChevronDownIcon, ChevronUpIcon, CheckIcon, PhoneIcon, DocumentCheckIcon, ChartBarIcon } from './icons';
import { getKeywordsForCompany, getHeaderForCompany } from '../hooks/useConsolidatedOrderConverter';
import { useDailyWorkspace } from '../hooks/useFirestore';
import { subscribeManualOrders, saveManualOrders, upsertDailySales, subscribeCompanyOrder, saveCompanyOrder } from '../services/firestoreService';
import { useAIManualOrder } from '../hooks/useAIManualOrder';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent,
} from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

declare var XLSX: any;

const DEFAULT_PREFERRED_ORDER = ['연두', '웰그린', '고랭지김치', '제이제이', '팜플로우', '꽃게', '신선마켓', '답도', '귤_초록', '홍게', '황금향', '귤', '홍게2'];

const QUICK_RECIPIENTS = [
    { name: '김지아', phone: '01094496343', address: '인천시 연수수 해송로30번길 19, 306-802' },
    { name: '김성아', phone: '01050447749', address: '인천시 연수구 송도국제대로261, 214-4105' }
];

interface ManualTransfer {
    id: string; label: string; bankName: string; accountNumber: string; amount: number; isAdjustment?: boolean; companyName?: string;
}

interface SessionData {
    id: string;
    companyName: string;
    round: number;
}

interface CompanySelectorProps { pricingConfig: PricingConfig; onConfigChange: (newConfig: PricingConfig) => void; businessId?: string; platformConfigs?: PlatformConfigs; }

// 드래그 가능한 행 컴포넌트
import { DragHandleContext } from './DragHandleContext';

const SortableCompanyRow: React.FC<{
    id: string;
    children: React.ReactNode;
}> = ({ id, children }) => {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id });

    const style = {
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition,
        opacity: isDragging ? 0.5 : 1,
    };

    return (
        <DragHandleContext.Provider value={{ attributes, listeners }}>
            <tbody ref={setNodeRef} style={style} className="divide-y divide-zinc-900">
                {children}
            </tbody>
        </DragHandleContext.Provider>
    );
};

const CompanySelector: React.FC<CompanySelectorProps> = ({ pricingConfig, onConfigChange, businessId, platformConfigs = {} }) => {
    const { workspace, updateField, isReady } = useDailyWorkspace(businessId);

    // 워크스테이션 수동 초기화 함수
    const handleResetWorkstations = useCallback(() => {
        if (!window.confirm('워크스테이션 데이터(처리결과/진행상황/조정내역)를 초기화할까요?')) return;
        Promise.all([
            updateField('sessionResults', {}),
            updateField('sessionWorkflows', {}),
            updateField('sessionAdjustments', {}),
        ]);
    }, [updateField]);

    const [companySessions, setCompanySessions] = useState<Record<string, SessionData[]>>(() => {
        const initial: Record<string, SessionData[]> = {};
        Object.keys(pricingConfig).forEach(name => {
            initial[name] = [{ id: `${name}-1`, companyName: name, round: 1 }];
        });
        return initial;
    });

    const [vendorFiles, setVendorFiles] = useState<Record<string, File>>({});
    const [totalsMap, setTotalsMap] = useState<Record<string, number>>({});
    const [excludedCountsMap, setExcludedCountsMap] = useState<Record<string, number>>({});
    const [allExcludedDetails, setAllExcludedDetails] = useState<Record<string, ExcludedOrder[]>>({});
    const [allOrderRows, setAllOrderRows] = useState<Record<string, any[][]>>({});
    const [allInvoiceRows, setAllInvoiceRows] = useState<Record<string, any[][]>>({});
    const [allUploadInvoiceRows, setAllUploadInvoiceRows] = useState<Record<string, any[][]>>({});
    const [allHeaders, setAllHeaders] = useState<Record<string, any[]>>({});
    const [allSummaries, setAllSummaries] = useState<Record<string, string>>({});
    const [allItemSummaries, setAllItemSummaries] = useState<Record<string, Record<string, { count: number; totalPrice: number }>>>({});

    // 워크스테이션 수동 초기화 함수
    const handleResetWorkstations = useCallback(() => {
        if (!window.confirm('워크스테이션 데이터(처리결과/진행상황/조정내역)를 초기화할까요?')) return;
        Promise.all([
            updateField('sessionResults', {}),
            updateField('sessionWorkflows', {}),
            updateField('sessionAdjustments', {}),
        ]);
        setTotalsMap({});
        setExcludedCountsMap({});
        setAllExcludedDetails({});
        setAllOrderRows({});
        setAllInvoiceRows({});
        setAllUploadInvoiceRows({});
        setAllHeaders({});
        setAllSummaries({});
        setAllItemSummaries({});
    }, [updateField]);

    const [masterOrderFile, setMasterOrderFile] = useState<File | null>(null);
    const [masterOrderData, setMasterOrderData] = useState<any[][] | null>(null);
    const [detectedCompanies, setDetectedCompanies] = useState<Set<string>>(new Set());
    const [batchFiles, setBatchFiles] = useState<Record<string, File>>({});
    const [batchExpectedCounts, setBatchExpectedCounts] = useState<Record<string, number>>({});
    const batchFileInputRef = useRef<HTMLInputElement>(null);
    // 멀티 플랫폼: 업로드된 플랫폼 목록 + 건수
    const [uploadedPlatforms, setUploadedPlatforms] = useState<{ name: string; count: number }[]>([]);
    // 행별 출처 플랫폼 (인덱스 = masterOrderData 행 인덱스, 값 = 플랫폼 이름 또는 null=쿠팡)
    const [rowPlatformSources, setRowPlatformSources] = useState<(string | null)[]>([]);

    const [isBulkMode, setIsBulkMode] = useState(false);
    const [bulkText, setBulkText] = useState('');

    const [manualOrders, setManualOrders] = useState<ManualOrder[]>([]);
    const lastWrittenManualOrdersRef = useRef('[]');

    // 업체 순서 관리
    const [companyOrder, setCompanyOrder] = useState<string[]>([]);
    const lastWrittenCompanyOrderRef = useRef('[]');

    // 업체 순서 Firestore 구독
    useEffect(() => {
        const unsubscribe = subscribeCompanyOrder((order) => {
            const str = JSON.stringify(order);
            if (str !== lastWrittenCompanyOrderRef.current) {
                setCompanyOrder(order);
                lastWrittenCompanyOrderRef.current = str;
            }
        }, businessId);
        return unsubscribe;
    }, [businessId]);

    // 업체 순서 변경 → Firestore에 저장
    const isInitialCompanyOrderLoad = useRef(true);
    useEffect(() => {
        if (isInitialCompanyOrderLoad.current) {
            isInitialCompanyOrderLoad.current = false;
            // 초기 로드 시 Firestore에 저장된 순서가 없으면 기본 순서 사용
            if (companyOrder.length === 0) {
                const companies = Object.keys(pricingConfig);
                const ordered = companies.sort((a, b) => {
                    const indexA = DEFAULT_PREFERRED_ORDER.indexOf(a);
                    const indexB = DEFAULT_PREFERRED_ORDER.indexOf(b);
                    if (indexA !== -1 && indexB !== -1) return indexA - indexB;
                    if (indexA !== -1) return -1;
                    if (indexB !== -1) return 1;
                    return a.localeCompare(b);
                });
                setCompanyOrder(ordered);
                saveCompanyOrder(ordered, businessId).catch(e => console.error('[Firestore] 업체 순서 저장 실패:', e));
            }
            return;
        }
        const currentStr = JSON.stringify(companyOrder);
        if (currentStr === lastWrittenCompanyOrderRef.current) return;
        lastWrittenCompanyOrderRef.current = currentStr;
        saveCompanyOrder(companyOrder, businessId).catch(e => console.error('[Firestore] 업체 순서 저장 실패:', e));
    }, [companyOrder, pricingConfig, businessId]);

    // 수동발주 Firestore 영구 저장 - 구독
    useEffect(() => {
        const unsubscribe = subscribeManualOrders((orders) => {
            const str = JSON.stringify(orders);
            if (str !== lastWrittenManualOrdersRef.current) {
                setManualOrders(orders as ManualOrder[]);
                lastWrittenManualOrdersRef.current = str;
            }
        }, businessId);
        return unsubscribe;
    }, [businessId]);

    // 수동발주 변경 → Firestore에 저장
    const isInitialManualOrdersLoad = useRef(true);
    useEffect(() => {
        if (isInitialManualOrdersLoad.current) { isInitialManualOrdersLoad.current = false; return; }
        const currentStr = JSON.stringify(manualOrders);
        if (currentStr === lastWrittenManualOrdersRef.current) return;
        lastWrittenManualOrdersRef.current = currentStr;
        saveManualOrders(manualOrders, businessId).catch(e => console.error('[Firestore] 수동발주 저장 실패:', e));
    }, [manualOrders]);

    const [manualInput, setManualInput] = useState({
        companyName: '', recipientName: '', phone: '', address: '', productName: '', qty: '1'
    });

    const [isAIMode, setIsAIMode] = useState(false);
    const [aiInput, setAiInput] = useState('');
    const { parsedOrders, isLoading: aiLoading, error: aiError, parseNaturalLanguage, clearParsedOrders, updateParsedOrder, removeParsedOrder } = useAIManualOrder(pricingConfig, QUICK_RECIPIENTS);

    const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => {
        const initialIds = new Set<string>();
        Object.keys(pricingConfig).forEach(name => initialIds.add(`${name}-1`));
        return initialIds;
    });

    const [fakeOrderInput, setFakeOrderInput] = useState('');
    const [showFakeOrderInput, setShowFakeOrderInput] = useState(false);
    const [showFakeDetail, setShowFakeDetail] = useState(false);

    const [lotteFile, setLotteFile] = useState<File | null>(null);
    const [lotteResult, setLotteResult] = useState<{ matched: number; total: number; notFound: string[] } | null>(null);
    const [lotteMatchedRows, setLotteMatchedRows] = useState<any[][] | null>(null);

    const [agentFile, setAgentFile] = useState<File | null>(null);
    const [agentResult, setAgentResult] = useState<{ matched: number; total: number; notFound: string[] } | null>(null);
    const [agentMatchedRows, setAgentMatchedRows] = useState<any[][] | null>(null);

    const [manualTransfers, setManualTransfers] = useState<ManualTransfer[]>([]);

    const [newTransfer, setNewTransfer] = useState({ label: '', bankName: '', accountNumber: '', amount: '' });

    // 드래그앤드롭 센서 설정
    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    // 업체 순서 정렬 함수
    const sortCompanies = useCallback((companies: string[]) => {
        if (companyOrder.length === 0) return companies;
        return companies.sort((a, b) => {
            const indexA = companyOrder.indexOf(a);
            const indexB = companyOrder.indexOf(b);
            if (indexA !== -1 && indexB !== -1) return indexA - indexB;
            if (indexA !== -1) return -1;
            if (indexB !== -1) return 1;
            return a.localeCompare(b);
        });
    }, [companyOrder]);

    // 드래그 종료 핸들러
    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;

        if (!over || active.id === over.id) return;

        setCompanyOrder((items) => {
            const oldIndex = items.indexOf(active.id as string);
            const newIndex = items.indexOf(over.id as string);

            return arrayMove(items, oldIndex, newIndex);
        });
    };

    // 비용(지출내역) 관리
    const EXPENSE_CATEGORIES = ['임대료', '통신비', '소모품비', '물류비', '마케팅', '식비', '기타', '이자'];
    const [expenses, setExpenses] = useState<ExpenseRecord[]>([]);
    const [newExpense, setNewExpense] = useState({ category: '물류비', amount: '', description: '' });

    // Firestore 동기화 - 값 비교로 에코 방지
    const lastWrittenFakeRef = useRef('');
    const lastWrittenTransfersRef = useRef('[]');
    const lastWrittenExpensesRef = useRef('[]');
    // 저장 중 구독 업데이트 차단 (stale snapshot이 로컬 변경을 덮어쓰는 것 방지)
    const savingFieldsUntil = useRef<Record<string, number>>({});
    // isReady를 ref로 관리하여 save effect의 dependency에서 제외 (race condition 방지)
    const isReadyRef = useRef(false);
    useEffect(() => { isReadyRef.current = isReady; }, [isReady]);

    useEffect(() => {
        if (!workspace) return;
        const now = Date.now();
        if (workspace.fakeOrderInput !== undefined && workspace.fakeOrderInput !== lastWrittenFakeRef.current) {
            if (now >= (savingFieldsUntil.current['fakeOrderInput'] || 0)) {
                setFakeOrderInput(workspace.fakeOrderInput);
                lastWrittenFakeRef.current = workspace.fakeOrderInput;
            }
        }
        if (workspace.manualTransfers !== undefined) {
            if (now >= (savingFieldsUntil.current['manualTransfers'] || 0)) {
                const wsStr = JSON.stringify(workspace.manualTransfers);
                if (wsStr !== lastWrittenTransfersRef.current) {
                    setManualTransfers(workspace.manualTransfers);
                    lastWrittenTransfersRef.current = wsStr;
                }
            }
        }
        if (workspace.expenses !== undefined) {
            if (now >= (savingFieldsUntil.current['expenses'] || 0)) {
                const wsStr = JSON.stringify(workspace.expenses);
                if (wsStr !== lastWrittenExpensesRef.current) {
                    setExpenses(workspace.expenses);
                    lastWrittenExpensesRef.current = wsStr;
                }
            }
        }
    }, [workspace]);

    // fakeOrderInput 변경 → Firestore에 debounce로 저장
    const fakeOrderDebounceRef = useRef<ReturnType<typeof setTimeout>>();
    useEffect(() => {
        if (!isReadyRef.current) return;
        if (fakeOrderInput === lastWrittenFakeRef.current) return;
        if (fakeOrderDebounceRef.current) clearTimeout(fakeOrderDebounceRef.current);
        fakeOrderDebounceRef.current = setTimeout(() => {
            savingFieldsUntil.current['fakeOrderInput'] = Date.now() + 30000;
            lastWrittenFakeRef.current = fakeOrderInput;
            updateField('fakeOrderInput', fakeOrderInput)
                .then(() => { setTimeout(() => { savingFieldsUntil.current['fakeOrderInput'] = 0; }, 1500); })
                .catch(e => { savingFieldsUntil.current['fakeOrderInput'] = 0; console.error('[Firestore] fakeOrderInput 저장 실패:', e); });
        }, 300);
        return () => { if (fakeOrderDebounceRef.current) clearTimeout(fakeOrderDebounceRef.current); };
    }, [fakeOrderInput, updateField]);

    // manualTransfers 변경 → Firestore에 저장
    useEffect(() => {
        if (!isReadyRef.current) return;
        const currentStr = JSON.stringify(manualTransfers);
        if (currentStr === lastWrittenTransfersRef.current) return;
        savingFieldsUntil.current['manualTransfers'] = Date.now() + 30000;
        lastWrittenTransfersRef.current = currentStr;
        updateField('manualTransfers', manualTransfers)
            .then(() => { setTimeout(() => { savingFieldsUntil.current['manualTransfers'] = 0; }, 1500); })
            .catch(e => { savingFieldsUntil.current['manualTransfers'] = 0; console.error('[Firestore] manualTransfers 저장 실패:', e); });
    }, [manualTransfers, updateField]);

    // expenses 변경 → Firestore에 저장
    useEffect(() => {
        if (!isReadyRef.current) return;
        const currentStr = JSON.stringify(expenses);
        if (currentStr === lastWrittenExpensesRef.current) return;
        savingFieldsUntil.current['expenses'] = Date.now() + 30000;
        lastWrittenExpensesRef.current = currentStr;
        updateField('expenses', expenses)
            .then(() => { setTimeout(() => { savingFieldsUntil.current['expenses'] = 0; }, 1500); })
            .catch(e => { savingFieldsUntil.current['expenses'] = 0; console.error('[Firestore] expenses 저장 실패:', e); });
    }, [expenses, updateField]);

    // 가구매 명단 분석 (입력된 번호 vs 실제 발견된 번호)
    const fakeOrderAnalysis = useMemo(() => {
        const inputNumbers = new Set<string>();
        const nameMap: Record<string, string> = {}; // 주문번호 -> 이름
        fakeOrderInput.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;
            const matches = trimmed.match(/[A-Za-z0-9-]{5,}/g);
            if (matches) {
                // 주문번호가 아닌 부분을 이름으로 추출
                let namepart = trimmed;
                matches.forEach(m => { namepart = namepart.replace(m, ''); });
                const name = namepart.trim();
                matches.forEach(m => {
                    inputNumbers.add(m.trim());
                    if (name) nameMap[m.trim()] = name;
                });
            }
        });

        // 제외된 주문 정보 수집 (업체별로 제외된 주문들)
        const foundDetails: Record<string, ExcludedOrder> = {};
        (Object.values(allExcludedDetails).flat() as ExcludedOrder[]).forEach(ex => {
            const cleanNum = ex.orderNumber.replace(' (제외)', '').trim();
            foundDetails[cleanNum] = ex;
        });

        // 마스터 주문서에서 모든 주문번호 추출 (타이밍 이슈 방지)
        const masterOrderNumbers = new Set<string>();
        if (masterOrderData && masterOrderData.length > 1) {
            for (let i = 1; i < masterOrderData.length; i++) {
                const row = masterOrderData[i];
                if (!row) continue;
                const orderNum = String(row[2] || '').trim();
                if (orderNum) masterOrderNumbers.add(orderNum);
            }
        }

        // 디버깅 로그
        console.log('[가구매 디버깅] 입력된 주문번호:', Array.from(inputNumbers));
        console.log('[가구매 디버깅] 마스터 주문서 총 주문 수:', masterOrderNumbers.size);
        console.log('[가구매 디버깅] allExcludedDetails 키:', Object.keys(allExcludedDetails));
        console.log('[가구매 디버깅] foundDetails 주문 수:', Object.keys(foundDetails).length);

        // 매칭: 제외된 주문 OR 마스터 주문서에 있는 주문
        const matched = Array.from(inputNumbers).filter(num =>
            foundDetails[num] || masterOrderNumbers.has(num)
        );
        const missing = Array.from(inputNumbers).filter(num =>
            !foundDetails[num] && !masterOrderNumbers.has(num)
        );

        console.log('[가구매 디버깅] 매칭된 번호:', matched);
        console.log('[가구매 디버깅] 미발견 번호:', missing);

        return { inputNumbers, matched, missing, foundDetails, nameMap };
    }, [fakeOrderInput, allExcludedDetails, masterOrderData]);

    // 마스터 주문서 품목별 건수 분석 (가구매 제외 / 가구매 분리)
    const masterProductSummary = useMemo(() => {
        if (!masterOrderData || masterOrderData.length < 2) return null;
        const fakeNums = new Set<string>();
        fakeOrderInput.split('\n').forEach(line => {
            const matches = line.trim().match(/[A-Za-z0-9-]{5,}/g);
            if (matches) matches.forEach(m => fakeNums.add(m.trim()));
        });
        // 업체-키워드 맵 생성
        const companyKeywordsMap = new Map<string, string[]>();
        Object.keys(pricingConfig).forEach(name => companyKeywordsMap.set(name, getKeywordsForCompany(name, pricingConfig)));
        const productToCompany: Record<string, string> = {};
        const realOrders: Record<string, number> = {};
        const fakeOrders: Record<string, number> = {};
        const unclaimedOrders: { recipientName: string; productName: string; groupName: string; orderNumber: string; qty: number }[] = [];
        const allOrderDetails: { recipientName: string; productName: string; groupName: string; orderNumber: string; qty: number; company: string; isFake: boolean }[] = [];
        for (let i = 1; i < masterOrderData.length; i++) {
            const row = masterOrderData[i];
            if (!row) continue;
            const orderNum = String(row[2] || '').trim();
            const groupName = String(row[10] || '').trim();
            const qty = parseInt(String(row[22] || '1'), 10) || 1;
            if (!groupName) continue;
            const recipientName = String(row[26] || '').trim();
            const productName = String(row[11] || '').trim();
            // 업체명 매핑
            if (!productToCompany[groupName]) {
                const groupNorm = groupName.replace(/\s+/g, '').normalize('NFC');
                for (const [name, keywords] of companyKeywordsMap.entries()) {
                    if (keywords.some(k => groupNorm.includes(k.replace(/\s+/g, '').normalize('NFC')))) {
                        productToCompany[groupName] = name;
                        break;
                    }
                }
            }
            const isFake = fakeNums.has(orderNum);
            const company = productToCompany[groupName] || '';
            allOrderDetails.push({ recipientName, productName, groupName, orderNumber: orderNum, qty, company, isFake });
            if (isFake) {
                fakeOrders[groupName] = (fakeOrders[groupName] || 0) + qty;
            } else {
                realOrders[groupName] = (realOrders[groupName] || 0) + qty;
                // 어떤 업체에도 매칭되지 않은 주문 수집
                if (!company) {
                    unclaimedOrders.push({ recipientName, productName, groupName, orderNumber: orderNum, qty });
                }
            }
        }
        const realTotal = Object.values(realOrders).reduce((a, b) => a + b, 0);
        const fakeTotal = Object.values(fakeOrders).reduce((a, b) => a + b, 0);
        // 업체별 마스터 주문 건수 (행 기준)
        const companyOrderCounts: Record<string, number> = {};
        allOrderDetails.forEach(d => {
            if (d.company) {
                companyOrderCounts[d.company] = (companyOrderCounts[d.company] || 0) + 1;
            }
        });
        return { realOrders, fakeOrders, realTotal, fakeTotal, productToCompany, unclaimedOrders, allOrderDetails, companyOrderCounts };
    }, [masterOrderData, fakeOrderInput, pricingConfig]);

    // 전체 비용 목록: 수동 입력 + 자동 물류비(택배대행/롯데택배/가구매 기본)
    const allExpenses = useMemo(() => {
        const autoExpenses: ExpenseRecord[] = [];
        const hasAgent = agentResult && agentResult.matched > 0;
        const hasLotte = lotteResult && lotteResult.matched > 0;

        if (hasAgent) {
            autoExpenses.push({
                id: 'auto-agent',
                category: '물류비',
                amount: agentResult.matched * 2200,
                description: `택배대행 ${agentResult.matched}건`,
                isAuto: true,
            });
        }
        if (hasLotte) {
            autoExpenses.push({
                id: 'auto-lotte',
                category: '물류비',
                amount: lotteResult.matched * 2300,
                description: `롯데택배 ${lotteResult.matched}건`,
                isAuto: true,
            });
        }
        // 운송장 매칭 전이라도 가구매 명단이 있으면 기본 물류비 자동 추가
        if (!hasAgent && !hasLotte && fakeOrderAnalysis.inputNumbers.size > 0) {
            autoExpenses.push({
                id: 'auto-fake-default',
                category: '물류비',
                amount: fakeOrderAnalysis.inputNumbers.size * 2200,
                description: `가구매 택배 ${fakeOrderAnalysis.inputNumbers.size}건`,
                isAuto: true,
            });
        }
        return [...autoExpenses, ...expenses];
    }, [expenses, agentResult, lotteResult, fakeOrderAnalysis.inputNumbers.size]);

    // 플랫폼 자동 감지
    const detectPlatform = (headerRow: any[]): { platform: PlatformConfig; name: string; score: number } | null => {
        const normalize = (s: any) => String(s || '').replace(/\s+/g, '').toLowerCase().normalize('NFC');
        const uploadedHeaders = headerRow.map(normalize);
        let bestMatch: { platform: PlatformConfig; name: string; score: number } | null = null;

        for (const [platformName, pc] of Object.entries(platformConfigs) as [string, PlatformConfig][]) {
            if (pc.sampleHeaders && pc.sampleHeaders.length > 0) {
                const sampleNormalized = pc.sampleHeaders.map(normalize);
                let matchCount = 0;
                for (let i = 0; i < Math.min(sampleNormalized.length, uploadedHeaders.length); i++) {
                    if (sampleNormalized[i] === uploadedHeaders[i]) matchCount++;
                }
                const score = matchCount / Math.max(sampleNormalized.length, uploadedHeaders.length);
                if (score >= 0.7 && (!bestMatch || score > bestMatch.score)) {
                    bestMatch = { platform: pc, name: platformName, score };
                }
            }
        }
        return bestMatch;
    };

    // 플랫폼 데이터를 쿠팡 컬럼 위치로 정규화
    const normalizePlatformRow = (row: any[], mapping: PlatformConfig['orderColumns']): any[] => {
        const normalized: any[] = new Array(31).fill('');
        normalized[2] = row[mapping.orderNumber] ?? '';
        normalized[10] = mapping.groupName != null ? (row[mapping.groupName] ?? '') : '';

        let productName = String(row[mapping.productName] ?? '').trim();
        if (mapping.optionName != null && row[mapping.optionName]) {
            const optionName = String(row[mapping.optionName]).trim();
            if (optionName) productName = productName ? `${productName} ${optionName}` : optionName;
        }
        normalized[11] = productName;
        normalized[22] = row[mapping.quantity] ?? '';
        normalized[26] = row[mapping.recipientName] ?? '';
        normalized[27] = row[mapping.recipientPhone] ?? '';
        normalized[28] = mapping.postalCode != null ? (row[mapping.postalCode] ?? '') : '';
        normalized[29] = row[mapping.address] ?? '';
        normalized[30] = mapping.deliveryMessage != null ? (row[mapping.deliveryMessage] ?? '') : '';
        return normalized;
    };

    const handleMasterUpload = async (file: File) => {
        console.log('🚀 [파일 업로드] 시작:', file.name);
        console.log('🚀 [platformConfigs]:', platformConfigs);
        setMasterOrderFile(file);
        try {
            const data = await file.arrayBuffer();
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            let json = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
            if (!json || json.length < 2) return;

            // 플랫폼 감지 및 정규화
            const detectedPlatform = detectPlatform(json[0]);
            let platformName: string | null = null;

            if (detectedPlatform) {
                platformName = detectedPlatform.name;
                const pc = detectedPlatform.platform;
                const headerRowIdx = pc.headerRowIndex || 0;
                const dataStart = pc.dataStartRow || headerRowIdx + 1;

                // 쿠팡 형식 헤더 생성
                const coupangHeader = new Array(31).fill('');
                coupangHeader[2] = '주문번호';
                coupangHeader[10] = '그룹명';
                coupangHeader[11] = '상품명';
                coupangHeader[22] = '수량';
                coupangHeader[26] = '받는분';
                coupangHeader[27] = '전화번호';
                coupangHeader[28] = '우편번호';
                coupangHeader[29] = '주소';
                coupangHeader[30] = '배송메세지';

                const normalized = [coupangHeader];
                for (let i = dataStart; i < json.length; i++) {
                    const row = json[i];
                    if (!row || row.every((c: any) => !c)) continue;
                    normalized.push(normalizePlatformRow(row, pc.orderColumns));
                }

                json = normalized;
                setUploadedPlatforms([{ name: platformName, count: normalized.length - 1 }]);
                setRowPlatformSources([null, ...Array(normalized.length - 1).fill(platformName)]);

                // 정규화된 데이터를 파일로 저장
                const normalizedSheet = XLSX.utils.aoa_to_sheet(json);
                const normalizedWb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(normalizedWb, normalizedSheet, 'Sheet1');
                const normalizedBuffer = XLSX.write(normalizedWb, { bookType: 'xlsx', type: 'array' });
                setMasterOrderFile(new File([normalizedBuffer], file.name, {
                    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }));

                console.log(`✅ [Platform] "${platformName}" 감지됨 (${Math.round(detectedPlatform.score * 100)}% 일치): ${json.length - 1}건 정규화`);
            } else {
                setUploadedPlatforms([{ name: '쿠팡', count: json.length - 1 }]);
                setRowPlatformSources([]);
            }

            const groupColIdx = 10;
            const companiesInFile = new Set<string>();
            const companyKeywordsMap = new Map<string, string[]>();
            Object.keys(pricingConfig).forEach(name => companyKeywordsMap.set(name, getKeywordsForCompany(name, pricingConfig)));
            for (let i = 1; i < json.length; i++) {
                const rawVal = String(json[i][groupColIdx] || '');
                const groupVal = rawVal.replace(/\s+/g, '').normalize('NFC');
                if (!groupVal) continue;
                for (const [name, keywords] of companyKeywordsMap.entries()) {
                    const isMatched = keywords.some(k => {
                        const normK = k.replace(/\s+/g, '').normalize('NFC');
                        return groupVal.includes(normK);
                    });
                    if (isMatched) { companiesInFile.add(name); break; }
                }
            }
            setDetectedCompanies(companiesInFile);
            setMasterOrderData(json);

            // 기존 수동 입금내역이 있으면 포함 여부 확인
            if (manualTransfers.length > 0) {
                const transferList = manualTransfers.map(t => `  • ${t.label || '수동 입금'} - ${t.amount.toLocaleString()}원`).join('\n');
                const totalAmount = manualTransfers.reduce((sum, t) => sum + t.amount, 0);
                if (!confirm(`기존 수동 입금내역 ${manualTransfers.length}건 (총 ${totalAmount.toLocaleString()}원)이 있습니다.\n포함하시겠습니까?\n\n${transferList}\n\n[확인] 유지  |  [취소] 삭제`)) {
                    setManualTransfers([]);
                }
            }
        } catch (error) { console.error("Master upload analysis failed:", error); }
    };

    const clearMasterFile = () => { setMasterOrderFile(null); setMasterOrderData(null); setDetectedCompanies(new Set()); setUploadedPlatforms([]); setRowPlatformSources([]); };

    const handleBatchUpload = async (file: File) => {
        console.log('🚀 [배치 업로드] 시작:', file.name);
        try {
            const data = await file.arrayBuffer();
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            let json = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
            if (!json || json.length < 2) { alert('유효한 주문서가 아닙니다.'); return; }

            // 플랫폼 감지 및 정규화 (마스터 업로드와 동일)
            const detectedPlatform = detectPlatform(json[0]);
            if (detectedPlatform) {
                const platformName = detectedPlatform.name;
                const pc = detectedPlatform.platform;
                const headerRowIdx = pc.headerRowIndex || 0;
                const dataStart = pc.dataStartRow || headerRowIdx + 1;

                // 쿠팡 형식 헤더 생성
                const coupangHeader = new Array(31).fill('');
                coupangHeader[2] = '주문번호';
                coupangHeader[10] = '그룹명';
                coupangHeader[11] = '상품명';
                coupangHeader[22] = '수량';
                coupangHeader[26] = '받는분';
                coupangHeader[27] = '전화번호';
                coupangHeader[28] = '우편번호';
                coupangHeader[29] = '주소';
                coupangHeader[30] = '배송메세지';

                const normalized = [coupangHeader];
                for (let i = dataStart; i < json.length; i++) {
                    const row = json[i];
                    if (!row || row.every((c: any) => !c)) continue;
                    normalized.push(normalizePlatformRow(row, pc.orderColumns));
                }

                json = normalized;
                console.log(`✅ [배치 정규화] "${platformName}" 감지됨 (${Math.round(detectedPlatform.score * 100)}% 일치): ${json.length - 1}건 정규화`);
            }

            // 정규화된 데이터를 파일로 생성 (플랫폼 파일인 경우)
            let processedFile = file;
            if (detectedPlatform) {
                const normalizedSheet = XLSX.utils.aoa_to_sheet(json);
                const normalizedWb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(normalizedWb, normalizedSheet, 'Sheet1');
                const normalizedBuffer = XLSX.write(normalizedWb, { bookType: 'xlsx', type: 'array' });
                processedFile = new File([normalizedBuffer], file.name, {
                    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                });
            }

            const groupColIdx = 10;
            const companyRowCounts: Record<string, number> = {};
            const companyKeywordsMap = new Map<string, string[]>();
            Object.keys(pricingConfig).forEach(name => companyKeywordsMap.set(name, getKeywordsForCompany(name, pricingConfig)));
            for (let i = 1; i < json.length; i++) {
                const groupVal = String(json[i][groupColIdx] || '').replace(/\s+/g, '').normalize('NFC');
                if (!groupVal) continue;
                for (const [name, keywords] of companyKeywordsMap.entries()) {
                    if (keywords.some(k => groupVal.includes(k.replace(/\s+/g, '').normalize('NFC')))) { companyRowCounts[name] = (companyRowCounts[name] || 0) + 1; break; }
                }
            }
            const companiesInFile = new Set(Object.keys(companyRowCounts));
            if (companiesInFile.size === 0) { alert('주문서에서 매칭되는 업체를 찾지 못했습니다.'); return; }
            let maxRound = 0;
            (Object.values(companySessions) as SessionData[][]).forEach(sessions => {
                sessions.forEach(s => { if (s.round > maxRound) maxRound = s.round; });
            });
            const nextRound = maxRound + 1;
            const newBatchFiles: Record<string, File> = {};
            const newExpectedCounts: Record<string, number> = {};
            const newSessions: Record<string, SessionData[]> = { ...companySessions };
            const newSelectedIds = new Set(selectedSessionIds);
            for (const companyName of companiesInFile) {
                const newSessionId = `${companyName}-batch-${nextRound}-${Date.now()}`;
                const newSession: SessionData = { id: newSessionId, companyName, round: nextRound };
                newSessions[companyName] = [...(newSessions[companyName] || []), newSession];
                newSelectedIds.add(newSessionId);
                newBatchFiles[newSessionId] = processedFile;
                newExpectedCounts[newSessionId] = companyRowCounts[companyName] || 0;
            }
            setCompanySessions(newSessions);
            setSelectedSessionIds(newSelectedIds);
            setBatchFiles(prev => ({ ...prev, ...newBatchFiles }));
            setBatchExpectedCounts(prev => ({ ...prev, ...newExpectedCounts }));
        } catch (error) {
            console.error("Batch upload failed:", error);
            alert('파일 처리 중 오류가 발생했습니다.');
        }
    };

    const handleLotteFileUpload = async (file: File) => {
        if (!masterOrderFile) { alert('원본 주문서를 먼저 업로드해주세요.'); return; }
        setLotteFile(file);
        setLotteResult(null);
        setLotteMatchedRows(null);
        try {
            // 가구매 명단에서 주문번호 추출
            const fakeOrderNums = new Set<string>();
            fakeOrderInput.split('\n').forEach(line => {
                const matches = line.match(/[A-Za-z0-9-]{5,}/g);
                if (matches) matches.forEach(m => fakeOrderNums.add(m.trim().replace(/[^A-Z0-9]/gi, '').toUpperCase()));
            });
            if (fakeOrderNums.size === 0) { alert('가구매 명단에 주문번호가 없습니다.'); return; }

            // 롯데택배 파일 읽기: J열(idx 9)=주문번호, G열(idx 6)=운송장번호
            const lotteData = await file.arrayBuffer();
            const lotteWb = XLSX.read(lotteData, { type: 'array' });
            const lotteWs = lotteWb.Sheets[lotteWb.SheetNames[0]];
            const lotteAoa: any[][] = XLSX.utils.sheet_to_json(lotteWs, { header: 1 });

            const trackingMap = new Map<string, string>();
            for (let i = 1; i < lotteAoa.length; i++) {
                const row = lotteAoa[i];
                if (!row) continue;
                const orderNum = String(row[9] || '').trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
                const trackingNum = String(row[6] || '').trim();
                if (orderNum && trackingNum && trackingNum.length >= 5) {
                    trackingMap.set(orderNum, trackingNum);
                }
            }

            // 원본 주문서 읽기
            const masterData = await masterOrderFile.arrayBuffer();
            const masterWb = XLSX.read(masterData, { type: 'array' });
            const masterWs = masterWb.Sheets[masterWb.SheetNames[0]];
            const masterAoa: any[][] = XLSX.utils.sheet_to_json(masterWs, { header: 1 });

            // C열(idx 2)=주문번호, D열(idx 3)=택배사, E열(idx 4)=운송장번호
            const header = masterAoa[0] || [];
            const matchedRows: any[][] = [header];
            const notFoundOrders: string[] = [];
            for (let i = 1; i < masterAoa.length; i++) {
                const row = masterAoa[i];
                if (!row) continue;
                const orderNum = String(row[2] || '').trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
                if (!fakeOrderNums.has(orderNum)) continue;
                const tracking = trackingMap.get(orderNum);
                if (tracking) {
                    const newRow = [...row];
                    while (newRow.length < 5) newRow.push('');
                    newRow[3] = '롯데택배';
                    newRow[4] = tracking;
                    matchedRows.push(newRow);
                } else {
                    notFoundOrders.push(String(row[2] || ''));
                }
            }

            const matchedCount = matchedRows.length - 1; // 헤더 제외
            setLotteResult({ matched: matchedCount, total: fakeOrderNums.size, notFound: notFoundOrders });
            if (matchedCount > 0) setLotteMatchedRows(matchedRows);
        } catch (err: any) {
            console.error('롯데택배 처리 오류:', err);
            alert('롯데택배 파일 처리 중 오류가 발생했습니다: ' + err.message);
        }
    };

    const handleLotteDownload = () => {
        if (!lotteMatchedRows) return;
        const ws = XLSX.utils.aoa_to_sheet(lotteMatchedRows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '주문서');
        XLSX.writeFile(wb, `${new Date().toISOString().slice(0, 10)}_가구매_운송장입력완료.xlsx`);
    };

    const handleAgentFileUpload = async (file: File) => {
        if (!masterOrderFile) { alert('원본 주문서를 먼저 업로드해주세요.'); return; }
        setAgentFile(file);
        setAgentResult(null);
        setAgentMatchedRows(null);
        try {
            const fakeOrderNums = new Set<string>();
            fakeOrderInput.split('\n').forEach(line => {
                const matches = line.match(/[A-Za-z0-9-]{5,}/g);
                if (matches) matches.forEach(m => fakeOrderNums.add(m.trim().replace(/[^A-Z0-9]/gi, '').toUpperCase()));
            });
            if (fakeOrderNums.size === 0) { alert('가구매 명단에 주문번호가 없습니다.'); return; }

            // 택배대행 파일 읽기: A열(idx 0)=주문번호, P열(idx 15)=운송장번호
            const agentData = await file.arrayBuffer();
            const agentWb = XLSX.read(agentData, { type: 'array' });
            const agentWs = agentWb.Sheets[agentWb.SheetNames[0]];
            const agentAoa: any[][] = XLSX.utils.sheet_to_json(agentWs, { header: 1 });

            const trackingMap = new Map<string, string>();
            for (let i = 1; i < agentAoa.length; i++) {
                const row = agentAoa[i];
                if (!row) continue;
                const orderNum = String(row[0] || '').trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
                const trackingNum = String(row[15] || '').trim();
                if (orderNum && trackingNum && trackingNum.length >= 5) {
                    trackingMap.set(orderNum, trackingNum);
                }
            }

            const masterData = await masterOrderFile.arrayBuffer();
            const masterWb = XLSX.read(masterData, { type: 'array' });
            const masterWs = masterWb.Sheets[masterWb.SheetNames[0]];
            const masterAoa: any[][] = XLSX.utils.sheet_to_json(masterWs, { header: 1 });

            const header = masterAoa[0] || [];
            const matchedRows: any[][] = [header];
            const notFoundOrders: string[] = [];
            for (let i = 1; i < masterAoa.length; i++) {
                const row = masterAoa[i];
                if (!row) continue;
                const orderNum = String(row[2] || '').trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
                if (!fakeOrderNums.has(orderNum)) continue;
                const tracking = trackingMap.get(orderNum);
                if (tracking) {
                    const newRow = [...row];
                    while (newRow.length < 5) newRow.push('');
                    newRow[3] = '롯데택배';
                    newRow[4] = tracking;
                    matchedRows.push(newRow);
                } else {
                    notFoundOrders.push(String(row[2] || ''));
                }
            }

            const matchedCount = matchedRows.length - 1;
            setAgentResult({ matched: matchedCount, total: fakeOrderNums.size, notFound: notFoundOrders });
            if (matchedCount > 0) setAgentMatchedRows(matchedRows);
        } catch (err: any) {
            console.error('택배대행 운송장 처리 오류:', err);
            alert('택배대행 운송장 파일 처리 중 오류가 발생했습니다: ' + err.message);
        }
    };

    const handleAgentDownload = () => {
        if (!agentMatchedRows) return;
        const ws = XLSX.utils.aoa_to_sheet(agentMatchedRows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '주문서');
        XLSX.writeFile(wb, `${new Date().toISOString().slice(0, 10)}_가구매_택배대행_운송장완료.xlsx`);
    };

    const handleDeliveryAgentDownload = async () => {
        if (!masterOrderFile) { alert('원본 주문서를 먼저 업로드해주세요.'); return; }
        // 가구매 명단에서 주문번호 추출
        const fakeOrderNums = new Set<string>();
        fakeOrderInput.split('\n').forEach(line => {
            const matches = line.match(/[A-Za-z0-9-]{5,}/g);
            if (matches) matches.forEach(m => fakeOrderNums.add(m.trim().replace(/[^A-Z0-9]/gi, '').toUpperCase()));
        });
        if (fakeOrderNums.size === 0) { alert('가구매 명단에 주문번호가 없습니다.'); return; }

        try {
            // 원본 주문서 읽기
            const masterData = await masterOrderFile.arrayBuffer();
            const masterWb = XLSX.read(masterData, { type: 'array' });
            const masterWs = masterWb.Sheets[masterWb.SheetNames[0]];
            const masterAoa: any[][] = XLSX.utils.sheet_to_json(masterWs, { header: 1 });

            // 택배대행 템플릿 헤더
            const templateHeader = ['주문번호', '받는사람', '전화번호1', '전화번호2', '우편번호', '주소', '상품명1', '상품상세1', '수량(A타입)', '배송메시지', '불필요항목', '불필요항목', '불필요항목', '보내는사람(지정)', '전화번호1(지정)', '송장번호'];
            const rows: any[][] = [templateHeader];
            const notFoundOrders: string[] = [];

            for (let i = 1; i < masterAoa.length; i++) {
                const row = masterAoa[i];
                if (!row) continue;
                const orderNum = String(row[2] || '').trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
                if (!fakeOrderNums.has(orderNum)) continue;

                const recipientName = String(row[26] || '').trim();
                const phone = String(row[27] || '').trim();
                const address = String(row[29] || '').trim();
                const originalOrderNum = String(row[2] || '').trim();

                if (!recipientName) { notFoundOrders.push(originalOrderNum); }

                rows.push([
                    originalOrderNum,   // 주문번호
                    recipientName,      // 받는사람
                    phone,              // 전화번호1
                    '',                 // 전화번호2
                    '',                 // 우편번호
                    address,            // 주소
                    '완구류',            // 상품명1 (고정)
                    '',                 // 상품상세1
                    '',                 // 수량(A타입)
                    '',                 // 배송메시지
                    '',                 // 불필요항목
                    '',                 // 불필요항목
                    '',                 // 불필요항목
                    '주노엘',           // 보내는사람(지정) (고정)
                    '010-5044-7749',    // 전화번호1(지정) (고정)
                    '',                 // 송장번호
                ]);
            }

            const matchedCount = rows.length - 1;
            if (matchedCount === 0) { alert('원본 주문서에서 가구매 명단과 매칭되는 주문을 찾지 못했습니다.'); return; }

            const ws = XLSX.utils.aoa_to_sheet(rows);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
            XLSX.writeFile(wb, `${new Date().toISOString().slice(0, 10)}_택배대행.xlsx`);

            if (notFoundOrders.length > 0) {
                alert(`택배대행 ${matchedCount}건 다운로드 완료!\n\n배송정보 누락 ${notFoundOrders.length}건: ${notFoundOrders.join(', ')}`);
            }
        } catch (err: any) {
            console.error('택배대행 처리 오류:', err);
            alert('택배대행 파일 생성 중 오류가 발생했습니다: ' + err.message);
        }
    };

    const handleLotteTemplateDownload = async () => {
        if (!masterOrderFile) { alert('원본 주문서를 먼저 업로드해주세요.'); return; }
        const fakeOrderNums = new Set<string>();
        fakeOrderInput.split('\n').forEach(line => {
            const matches = line.match(/[A-Za-z0-9-]{5,}/g);
            if (matches) matches.forEach(m => fakeOrderNums.add(m.trim().replace(/[^A-Z0-9]/gi, '').toUpperCase()));
        });
        if (fakeOrderNums.size === 0) { alert('가구매 명단에 주문번호가 없습니다.'); return; }

        try {
            const masterData = await masterOrderFile.arrayBuffer();
            const masterWb = XLSX.read(masterData, { type: 'array' });
            const masterWs = masterWb.Sheets[masterWb.SheetNames[0]];
            const masterAoa: any[][] = XLSX.utils.sheet_to_json(masterWs, { header: 1 });

            const templateHeader = ['주문번호', '보내는사람(지정)', '전화번호1(지정)', '', '우편번호(지정)', '주소(지정)', '받는사람', '전화번호1', '전화번호2', '우편번호', '주소', '상품명1', '상품상세1', '수량(A타입)', '배송시작시간', '도착구분', '운임', '운송장번호'];
            const rows: any[][] = [templateHeader];
            const notFoundOrders: string[] = [];

            for (let i = 1; i < masterAoa.length; i++) {
                const row = masterAoa[i];
                if (!row) continue;
                const orderNum = String(row[2] || '').trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
                if (!fakeOrderNums.has(orderNum)) continue;

                const recipientName = String(row[26] || '').trim();
                const phone = String(row[27] || '').trim();
                const address = String(row[29] || '').trim();
                const originalOrderNum = String(row[2] || '').trim();

                if (!recipientName) { notFoundOrders.push(originalOrderNum); }

                rows.push([
                    originalOrderNum,               // 주문번호
                    BUSINESS_INFO[businessId as keyof typeof BUSINESS_INFO]?.senderName || '안군농원',                       // 보내는사람(지정)
                    '01050447749',                   // 전화번호1(지정)
                    '',                              // (빈 열)
                    '',                              // 우편번호(지정)
                    '인천시 연수구 송도동 214, D동 2206-1호', // 주소(지정)
                    recipientName,                   // 받는사람
                    phone,                           // 전화번호1
                    '',                              // 전화번호2
                    '',                              // 우편번호
                    address,                         // 주소
                    '완구류',                         // 상품명1
                    '',                              // 상품상세1
                    '',                              // 수량(A타입)
                    '',                              // 배송시작시간
                    '',                              // 도착구분
                    '',                              // 운임
                    '',                              // 운송장번호
                ]);
            }

            const matchedCount = rows.length - 1;
            if (matchedCount === 0) { alert('원본 주문서에서 가구매 명단과 매칭되는 주문을 찾지 못했습니다.'); return; }

            const ws = XLSX.utils.aoa_to_sheet(rows);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
            XLSX.writeFile(wb, `${new Date().toISOString().slice(0, 10)}_롯데택배.xlsx`);

            if (notFoundOrders.length > 0) {
                alert(`롯데택배 ${matchedCount}건 다운로드 완료!\n\n배송정보 누락 ${notFoundOrders.length}건: ${notFoundOrders.join(', ')}`);
            }
        } catch (err: any) {
            console.error('롯데택배 템플릿 처리 오류:', err);
            alert('롯데택배 파일 생성 중 오류가 발생했습니다: ' + err.message);
        }
    };

    const handleAddManualOrder = (e: React.FormEvent) => {
        e.preventDefault();
        if (!manualInput.companyName || !manualInput.recipientName || !manualInput.productName) {
            alert('업체, 수령자 이름, 품목명은 필수입니다.'); return;
        }
        const newOrder: ManualOrder = {
            id: `mo-${Date.now()}`, companyName: manualInput.companyName, recipientName: manualInput.recipientName,
            phone: manualInput.phone, address: manualInput.address, productName: manualInput.productName, qty: parseInt(manualInput.qty) || 1
        };
        setManualOrders(prev => [...prev, newOrder]);
        setManualInput(prev => ({ ...prev, recipientName: '', phone: '', address: '', productName: '', qty: '1' }));
    };

    const handleQuickSelect = (person: { name: string, phone: string, address: string }) => {
        setManualInput(prev => ({ ...prev, recipientName: person.name, phone: person.phone, address: person.address }));
    };

    const handleRemoveManualOrder = (id: string) => setManualOrders(prev => prev.filter(o => o.id !== id));

    const handleAddManualTransfer = (e: React.FormEvent) => {
        e.preventDefault();
        if (!newTransfer.label || !newTransfer.amount) return;
        const transfer: ManualTransfer = {
            id: `manual-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            label: newTransfer.label, bankName: newTransfer.bankName || '은행', accountNumber: newTransfer.accountNumber || '계좌', amount: parseInt(newTransfer.amount) || 0
        };
        setManualTransfers(prev => [...prev, transfer]);
        setNewTransfer({ label: '', bankName: '', accountNumber: '', amount: '' });
    };

    const handleAddCompanyAdjustment = (companyName: string, amountStr: string) => {
        const parsedAmount = parseInt(amountStr);
        if (!amountStr || isNaN(parsedAmount) || parsedAmount <= 0) return;
        const config = pricingConfig[companyName];
        const transfer: ManualTransfer = {
            id: `adj-${companyName}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            label: `${companyName}(수동)`, companyName: companyName, bankName: config?.bankName || '은행', accountNumber: config?.accountNumber || '계좌', amount: parsedAmount, isAdjustment: true
        };
        setManualTransfers(prev => [...prev, transfer]);
    };

    const handleDeleteManualTransfer = (id: string) => setManualTransfers(prev => prev.filter(t => t.id !== id));

    const handleResetSessionData = (companyName: string, sessionId: string, round: number) => {
        if (!confirm(`${companyName} ${round}차의 정산 데이터를 초기화할까요?`)) return;
        const newId = `${companyName}-${round}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
        setTotalsMap(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
        setExcludedCountsMap(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
        setAllExcludedDetails(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
        setAllOrderRows(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
        setAllInvoiceRows(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
        setAllUploadInvoiceRows(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
        setAllHeaders(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
        setAllSummaries(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
        setCompanySessions(prev => ({ ...prev, [companyName]: prev[companyName].map(s => s.id === sessionId ? { ...s, id: newId } : s) }));
        setSelectedSessionIds(prev => { const next = new Set(prev); next.delete(sessionId); next.add(newId); return next; });
    };

    const handleAddSession = (companyName: string) => {
        const newSessionId = `${companyName}-${Date.now()}`;
        setCompanySessions(prev => {
            const current = prev[companyName] || [];
            const nextRound = current.length + 1;
            const newSession: SessionData = { id: newSessionId, companyName, round: nextRound };
            return { ...prev, [companyName]: [...current, newSession] };
        });
        setSelectedSessionIds(prev => { const next = new Set(prev); next.add(newSessionId); return next; });
    };

    const handleRemoveSession = (companyName: string, sessionId: string) => {
        if (!confirm('이 차수의 작업 줄을 삭제하시겠습니까?')) return;
        setCompanySessions(prev => ({ ...prev, [companyName]: prev[companyName].filter(s => s.id !== sessionId) }));
        setTotalsMap(prev => { const n = { ...prev }; delete n[sessionId]; return n; });
        setExcludedCountsMap(prev => { const n = { ...prev }; delete n[sessionId]; return n; });
        setAllExcludedDetails(prev => { const n = { ...prev }; delete n[sessionId]; return n; });
        setSelectedSessionIds(prev => { const next = new Set(prev); next.delete(sessionId); return next; });
    };

    const handleVendorFileChange = (companyName: string, file: File | null) => {
        setVendorFiles(prev => {
            const newState = { ...prev };
            if (file) newState[companyName] = file; else delete newState[companyName];
            return newState;
        });
    };

    const handleResultUpdate = useCallback((sessionId: string, totalPrice: number, excludedCount: number = 0, excludedDetails: ExcludedOrder[] = []) => {
        setTotalsMap(prev => ({ ...prev, [sessionId]: totalPrice }));
        setExcludedCountsMap(prev => ({ ...prev, [sessionId]: excludedCount }));
        setAllExcludedDetails(prev => ({ ...prev, [sessionId]: excludedDetails }));
    }, []);

    const [allRegisteredNames, setAllRegisteredNames] = useState<Record<string, Record<string, string>>>({});

    // 수동발주 취소/승인 상태 (업체별)
    const [manualOrdersRejectedCompanies, setManualOrdersRejectedCompanies] = useState<Set<string>>(new Set());
    const handleManualOrdersApproval = useCallback((companyName: string, approved: boolean) => {
        setManualOrdersRejectedCompanies(prev => {
            const next = new Set(prev);
            if (approved) next.delete(companyName);
            else next.add(companyName);
            return next;
        });
    }, []);

    const handleDataUpdate = useCallback((sessionId: string, orderRows: any[][], invoiceRows: any[][], uploadInvoiceRows: any[][], summaryExcel: string, header?: any[], registeredProductNames?: Record<string, string>, itemSummary?: Record<string, { count: number; totalPrice: number }>) => {
        setAllOrderRows(prev => ({ ...prev, [sessionId]: orderRows }));
        setAllInvoiceRows(prev => ({ ...prev, [sessionId]: invoiceRows }));
        setAllUploadInvoiceRows(prev => ({ ...prev, [sessionId]: uploadInvoiceRows }));
        if (header) setAllHeaders(prev => ({ ...prev, [sessionId]: header }));
        setAllSummaries(prev => ({ ...prev, [sessionId]: summaryExcel }));
        if (registeredProductNames) setAllRegisteredNames(prev => ({ ...prev, [sessionId]: registeredProductNames }));
        if (itemSummary) setAllItemSummaries(prev => ({ ...prev, [sessionId]: itemSummary }));
    }, []);

    const handleToggleSessionSelection = (sessionId: string) => {
        setSelectedSessionIds(prev => {
            const next = new Set(prev);
            if (next.has(sessionId)) next.delete(sessionId); else next.add(sessionId);
            return next;
        });
    };

    const handleSelectAllSessions = () => {
        const allActiveIds = (Object.values(companySessions).flat() as SessionData[]).map(s => s.id);
        if (selectedSessionIds.size === allActiveIds.length) setSelectedSessionIds(new Set());
        else setSelectedSessionIds(new Set(allActiveIds));
    };

    const handleDownloadMergedOrder = (companyName: string) => {
        const sessions = companySessions[companyName] || [];
        const mergedRows: any[][] = [];
        sessions.forEach(s => {
            if (allOrderRows[s.id] && allOrderRows[s.id].length > 0) mergedRows.push(...allOrderRows[s.id]);
        });
        if (mergedRows.length === 0) { alert('합산할 발주 데이터가 없습니다.'); return; }
        const companyConfig = pricingConfig[companyName];
        if (!companyConfig) return;
        const header = getHeaderForCompany(companyName, companyConfig);
        const ws = XLSX.utils.aoa_to_sheet([header, ...mergedRows]);
        ws['!cols'] = header.map(() => ({ wch: 15 }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '발주서');
        const dateStr = new Date().toISOString().slice(0, 10);
        XLSX.writeFile(wb, `${dateStr} ${companyName} 합산발주서.xlsx`);
    };

    const handleDownloadMergedInvoice = (companyName: string, type: 'mgmt' | 'upload') => {
        const sessions = companySessions[companyName] || [];
        const mergedRows: any[][] = [];
        let headerRow: any[] = [];
        sessions.forEach(s => {
            const rows = type === 'mgmt' ? allInvoiceRows[s.id] : allUploadInvoiceRows[s.id];
            if (rows && rows.length > 0) {
                if (headerRow.length === 0 && allHeaders[s.id]) headerRow = allHeaders[s.id];
                mergedRows.push(...rows);
            }
        });
        if (mergedRows.length === 0) { alert('합산할 송장 데이터가 없습니다.'); return; }
        const wb = XLSX.utils.book_new();
        const aoa = headerRow.length > 0 ? [headerRow, ...mergedRows] : mergedRows;
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        XLSX.utils.book_append_sheet(wb, ws, type === 'mgmt' ? '기록용' : '업로드용');
        const dateStr = new Date().toISOString().slice(0, 10);
        const label = type === 'mgmt' ? '기록용' : '업로드용';
        XLSX.writeFile(wb, `${dateStr} ${companyName} 합산송장_${label}.xlsx`);
    };

    const handleDownloadMergedUploadInvoices = () => {
        if (selectedSessionIds.size === 0) { alert('병합할 업체를 선택해주세요.'); return; }
        const mergedRows: any[][] = [];
        let headerRow: any[] = [];
        const selectedCompanyNames: string[] = [];
        const sortedSessions = (Object.values(companySessions).flat() as SessionData[]).filter((s: SessionData) => selectedSessionIds.has(s.id));
        sortedSessions.forEach((s: SessionData) => {
            if (allUploadInvoiceRows[s.id] && allUploadInvoiceRows[s.id].length > 0) {
                if (headerRow.length === 0 && allHeaders[s.id]) headerRow = allHeaders[s.id];
                mergedRows.push(...allUploadInvoiceRows[s.id]);
                if (!selectedCompanyNames.includes(s.companyName)) selectedCompanyNames.push(s.companyName);
            }
        });
        // 가구매 송장(롯데택배/택배대행) 병합
        if (lotteMatchedRows && lotteMatchedRows.length > 1) {
            if (headerRow.length === 0) headerRow = lotteMatchedRows[0];
            mergedRows.push(...lotteMatchedRows.slice(1));
        }
        if (agentMatchedRows && agentMatchedRows.length > 1) {
            if (headerRow.length === 0) headerRow = agentMatchedRows[0];
            mergedRows.push(...agentMatchedRows.slice(1));
        }
        if (mergedRows.length === 0) { alert('선택된 업체 중 매칭된 송장 데이터가 없습니다.'); return; }
        const wb = XLSX.utils.book_new();
        const aoa = headerRow.length > 0 ? [headerRow, ...mergedRows] : mergedRows;
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        XLSX.utils.book_append_sheet(wb, ws, "병합송장");
        const dateStr = new Date().toISOString().slice(0, 10);
        const companiesStr = selectedCompanyNames.length > 3 ? `${selectedCompanyNames.slice(0, 3).join(', ')} 외 ${selectedCompanyNames.length - 3}곳` : selectedCompanyNames.join(', ');
        XLSX.writeFile(wb, `${dateStr} [${companiesStr}] 업로드용_송장_병합.xlsx`);
    };

    const handleDownloadDepositList = () => {
        if (selectedSessionIds.size === 0) { alert('입금 목록을 생성할 업체를 선택해주세요.'); return; }
        const wb = XLSX.utils.book_new();
        const depositRows: any[][] = [];
        let total = 0;
        const sortedCompanyNames = sortCompanies(Object.keys(pricingConfig));
        sortedCompanyNames.forEach(name => {
            const sessions = companySessions[name] || [];
            const config = pricingConfig[name];
            let companyTotal = 0;
            sessions.forEach(s => {
                if (!selectedSessionIds.has(s.id)) return;
                companyTotal += totalsMap[s.id] || 0;
            });
            if (companyTotal > 0) { depositRows.push([config?.bankName || '은행미지정', config?.accountNumber || '계좌미지정', companyTotal, name]); total += companyTotal; }
        });
        manualTransfers.forEach(t => { depositRows.push([t.bankName, t.accountNumber, t.amount, t.label]); total += t.amount; });
        if (fakeOrderAnalysis.inputNumbers.size > 0) {
            const deliveryFee = fakeOrderAnalysis.inputNumbers.size * 2200;
            depositRows.push(['카카오뱅크', '3333-18-8744855', deliveryFee, `택배대행(${fakeOrderAnalysis.inputNumbers.size}건)`]);
            total += deliveryFee;
        }
        if (depositRows.length === 0) { alert('선택된 업체 중 입금할 내역이 없습니다.'); return; }
        depositRows.push([], ['', '합계', total]);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(depositRows), "입금내역");
        XLSX.writeFile(wb, `${new Date().toISOString().slice(0, 10)}_입금목록.xlsx`);
    };

    const handleDownloadWorkLog = () => {
        const wb = XLSX.utils.book_new();
        const summarySheetData: any[][] = [];
        const sortedCompanyNames = sortCompanies(Object.keys(pricingConfig));
        sortedCompanyNames.forEach(name => {
            const sessions = companySessions[name] || [];
            let hasAddedHeader = false;
            sessions.forEach(s => {
                const text = allSummaries[s.id];
                if (text && text.trim()) {
                    if (!hasAddedHeader) { summarySheetData.push([`[${name} 정산내역]`]); hasAddedHeader = true; }
                    text.split('\n').forEach(line => summarySheetData.push(line.split('\t')));
                    summarySheetData.push([]);
                }
            });
        });
        if (summarySheetData.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summarySheetData), "요약시트");
        const depositRows: any[][] = [];
        let depTotal = 0;
        sortedCompanyNames.forEach(name => {
            const sessions = companySessions[name] || [];
            const config = pricingConfig[name];
            sessions.forEach(s => {
                const amount = totalsMap[s.id] || 0;
                if (amount > 0) { depositRows.push([config?.bankName || '', config?.accountNumber || '', amount]); depTotal += amount; }
            });
        });
        manualTransfers.forEach(t => { depositRows.push([t.bankName, t.accountNumber, t.amount]); depTotal += t.amount; });
        if (fakeOrderAnalysis.inputNumbers.size > 0) {
            const deliveryFee = fakeOrderAnalysis.inputNumbers.size * 2200;
            depositRows.push(['카카오뱅크', '3333-18-8744855', deliveryFee]);
            depTotal += deliveryFee;
        }
        if (depositRows.length > 0) depositRows.push([], ['', '합계', depTotal]);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(depositRows), "입금내역");
        const orderSheetData: any[][] = [];
        const invoiceSheetData: any[][] = [];
        sortedCompanyNames.forEach(name => {
            (companySessions[name] || []).forEach(s => {
                if (allOrderRows[s.id]) orderSheetData.push(...allOrderRows[s.id]);
                if (allInvoiceRows[s.id]) invoiceSheetData.push(...allInvoiceRows[s.id]);
            });
        });
        if (orderSheetData.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(orderSheetData), "발주시트");
        if (invoiceSheetData.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(invoiceSheetData), "송장시트");

        // 마진시트 생성: 요약시트의 품목별 판매가, 공급가, 마진 정보
        // 업체별 등록상품명 매핑 (displayName -> K열 값)
        const mergedRegNames: Record<string, Record<string, string>> = {};
        sortedCompanyNames.forEach(name => {
            (companySessions[name] || []).forEach(s => {
                if (allRegisteredNames[s.id]) {
                    if (!mergedRegNames[name]) mergedRegNames[name] = {};
                    Object.assign(mergedRegNames[name], allRegisteredNames[s.id]);
                }
            });
        });

        const marginSheetData: any[][] = [['등록상품명', '품목명', '수량', '판매가', '공급가', '마진(개당)', '총마진', '지출금액', '지출내역']];
        let marginCurrentCompany = '';
        for (const row of summarySheetData) {
            const firstCell = String(row[0] || '').trim();
            const companyMatch = firstCell.match(/^\[(.+?)\s*정산내역\]$/);
            if (companyMatch) { marginCurrentCompany = companyMatch[1]; continue; }
            if (marginCurrentCompany && row.length >= 3) {
                const productName = String(row[1] || '').trim();
                const countMatch = String(row[2] || '').trim().match(/(\d+)개/);
                if (productName && countMatch) {
                    const count = parseInt(countMatch[1]);
                    const companyConfig = pricingConfig[marginCurrentCompany];
                    if (companyConfig) {
                        let sellingPrice = 0, supplyPrice = 0, margin = 0;
                        for (const productKey of Object.keys(companyConfig.products)) {
                            const product = companyConfig.products[productKey] as any;
                            if (product.displayName === productName) {
                                sellingPrice = product.sellingPrice || 0;
                                supplyPrice = product.supplyPrice || 0;
                                margin = product.margin || 0;
                                break;
                            }
                        }
                        const regName = mergedRegNames[marginCurrentCompany]?.[productName] || marginCurrentCompany;
                        marginSheetData.push([regName, productName, count, sellingPrice, supplyPrice, margin, margin * count, '', '']);
                    }
                }
            }
        }

        // 총 마진
        const totalMargin = marginSheetData.length > 1
            ? marginSheetData.slice(1).reduce((sum: number, r: any[]) => sum + (r[6] || 0), 0)
            : 0;
        if (marginSheetData.length > 1) {
            marginSheetData.push([]);
            marginSheetData.push(['', '', '', '', '', '총 마진', totalMargin, '', '']);
        }

        // 비용 섹션 (allExpenses 통합: 자동 물류비 + 수동 비용)
        if (allExpenses.length > 0) {
            marginSheetData.push([]);
            marginSheetData.push(['', '[비용]', '', '', '', '', '', '', '']);
            allExpenses.forEach(exp => {
                marginSheetData.push(['', exp.category, '', '', '', '', '', exp.amount, exp.description]);
            });
            const totalExpense = allExpenses.reduce((sum, e) => sum + e.amount, 0);
            marginSheetData.push([]);
            marginSheetData.push(['', '', '', '', '', '총 비용', '', totalExpense, '']);
            marginSheetData.push(['', '', '', '', '', '순이익', '', totalMargin - totalExpense, '']);
        }

        if (marginSheetData.length > 1) {
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(marginSheetData), "마진시트");
        }

        const todayDate = new Date().toISOString().slice(0, 10);
        XLSX.writeFile(wb, `${todayDate}_업무일지.xlsx`);
    };

    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
    const [saveError, setSaveError] = useState<string>('');

    const handleSaveToSalesHistory = async () => {
        // 마스터파일 이름에서 날짜 파싱 (예: "0309_주문목록.xlsx" → "2026-03-09")
        let recordDate = new Date().toISOString().slice(0, 10);
        if (masterOrderFile) {
            const fname = masterOrderFile.name;
            const fullMatch = fname.match(/(\d{4})-(\d{2})-(\d{2})/);
            const shortMatch = fname.match(/(\d{2})(\d{2})/);
            if (fullMatch) {
                recordDate = `${fullMatch[1]}-${fullMatch[2]}-${fullMatch[3]}`;
            } else if (shortMatch) {
                const mm = parseInt(shortMatch[1]);
                const dd = parseInt(shortMatch[2]);
                if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
                    recordDate = `${new Date().getFullYear()}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
                }
            }
        }
        const sortedCompanyNames = sortCompanies(Object.keys(pricingConfig));

        // 발주/송장 데이터 수집
        const orderSheetData: any[][] = [];
        const invoiceSheetData: any[][] = [];
        sortedCompanyNames.forEach(name => {
            (companySessions[name] || []).forEach(s => {
                if (allOrderRows[s.id]) orderSheetData.push(...allOrderRows[s.id]);
                if (allInvoiceRows[s.id]) invoiceSheetData.push(...allInvoiceRows[s.id]);
            });
        });

        // 입금 데이터 수집
        const depositRows: { bankName: string; accountNumber: string; amount: number }[] = [];
        let depTotal = 0;
        sortedCompanyNames.forEach(name => {
            const sessions = companySessions[name] || [];
            const config = pricingConfig[name];
            sessions.forEach(s => {
                const amount = totalsMap[s.id] || 0;
                if (amount > 0) {
                    depositRows.push({ bankName: config?.bankName || '', accountNumber: config?.accountNumber || '', amount });
                    depTotal += amount;
                }
            });
        });
        manualTransfers.forEach(t => {
            depositRows.push({ bankName: t.bankName, accountNumber: t.accountNumber, amount: t.amount });
            depTotal += t.amount;
        });
        if (fakeOrderAnalysis.inputNumbers.size > 0) {
            const deliveryFee = fakeOrderAnalysis.inputNumbers.size * 2200;
            depositRows.push({ bankName: '카카오뱅크', accountNumber: '3333-18-8744855', amount: deliveryFee });
            depTotal += deliveryFee;
        }

        // 마진 데이터 수집
        const mergedRegNames: Record<string, Record<string, string>> = {};
        sortedCompanyNames.forEach(name => {
            (companySessions[name] || []).forEach(s => {
                if (allRegisteredNames[s.id]) {
                    if (!mergedRegNames[name]) mergedRegNames[name] = {};
                    Object.assign(mergedRegNames[name], allRegisteredNames[s.id]);
                }
            });
        });

        // 요약 데이터에서 마진 정보 추출 (같은 상품은 합산)
        const marginMap = new Map<string, MarginRecord>();
        let marginCurrentCompany = '';
        const summaryLines: string[][] = [];
        sortedCompanyNames.forEach(name => {
            const sessions = companySessions[name] || [];
            let hasAdded = false;
            sessions.forEach(s => {
                const text = allSummaries[s.id];
                if (text && text.trim()) {
                    if (!hasAdded) { summaryLines.push([`[${name} 정산내역]`]); hasAdded = true; }
                    text.split('\n').forEach(line => summaryLines.push(line.split('\t')));
                    summaryLines.push([]);
                }
            });
        });

        for (const row of summaryLines) {
            const firstCell = String(row[0] || '').trim();
            const companyMatch = firstCell.match(/^\[(.+?)\s*정산내역\]$/);
            if (companyMatch) { marginCurrentCompany = companyMatch[1]; continue; }
            if (marginCurrentCompany && row.length >= 3) {
                const productName = String(row[1] || '').trim();
                const countMatch = String(row[2] || '').trim().match(/(\d+)개/);
                if (productName && countMatch) {
                    const count = parseInt(countMatch[1]);
                    const companyConfig = pricingConfig[marginCurrentCompany];
                    if (companyConfig) {
                        let sellingPrice = 0, supplyPrice = 0, margin = 0;
                        for (const productKey of Object.keys(companyConfig.products)) {
                            const product = companyConfig.products[productKey] as any;
                            if (product.displayName === productName) {
                                sellingPrice = product.sellingPrice || 0;
                                supplyPrice = product.supplyPrice || 0;
                                margin = product.margin || 0;
                                break;
                            }
                        }
                        const regName = mergedRegNames[marginCurrentCompany]?.[productName] || marginCurrentCompany;
                        const key = `${marginCurrentCompany}::${productName}`;
                        const existing = marginMap.get(key);
                        if (existing) {
                            existing.count += count;
                            existing.totalMargin += margin * count;
                        } else {
                            marginMap.set(key, {
                                registeredName: regName, productName, count,
                                sellingPrice, supplyPrice, marginPerUnit: margin, totalMargin: margin * count,
                            });
                        }
                    }
                }
            }
        }
        const marginRecords = Array.from(marginMap.values());
        const marginTotal = marginRecords.reduce((sum, r) => sum + r.totalMargin, 0);

        // 합산 summaryLines에서 매출 records 생성 (같은 업체+상품은 합산)
        const recordMap = new Map<string, SalesRecord>();
        let recordCurrentCompany = '';
        for (const row of summaryLines) {
            const firstCell = String(row[0] || '').trim();
            const companyMatch = firstCell.match(/^\[(.+?)\s*정산내역\]$/);
            if (companyMatch) { recordCurrentCompany = companyMatch[1]; continue; }
            if (recordCurrentCompany && row.length >= 3) {
                const productName = String(row[1] || '').trim();
                const countMatch = String(row[2] || '').trim().match(/(\d+)개/);
                if (productName && countMatch) {
                    const count = parseInt(countMatch[1]);
                    const priceStr = String(row[3] || '').replace(/[,원\s]/g, '');
                    const totalPrice = parseInt(priceStr) || 0;
                    const companyConfig = pricingConfig[recordCurrentCompany];
                    let margin = 0;
                    if (companyConfig?.products) {
                        const productEntry = Object.values(companyConfig.products).find((p: any) => p.displayName === productName);
                        if ((productEntry as any)?.margin) margin = (productEntry as any).margin;
                    }
                    const key = `${recordCurrentCompany}::${productName}`;
                    const existing = recordMap.get(key);
                    if (existing) {
                        existing.count += count;
                        existing.totalPrice += totalPrice;
                        existing.supplyPrice = existing.count > 0 ? Math.round(existing.totalPrice / existing.count) : 0;
                    } else {
                        const supplyPrice = count > 0 ? Math.round(totalPrice / count) : 0;
                        recordMap.set(key, { date: recordDate, company: recordCurrentCompany, product: productName, count, supplyPrice, totalPrice, margin });
                    }
                }
            }
        }
        const records = Array.from(recordMap.values());
        const totalAmount = records.reduce((sum, r) => sum + r.totalPrice, 0);

        // Firestore는 undefined를 저장할 수 없으므로 null로 치환
        const sanitizeRows = (rows: any[][]): any[][] =>
            rows.map(row => row.map(cell => cell === undefined ? null : cell));

        const dailySales: DailySales = {
            date: recordDate, records, totalAmount, savedAt: new Date().toISOString(),
            orderRows: orderSheetData.length > 0 ? sanitizeRows(orderSheetData) : undefined,
            invoiceRows: invoiceSheetData.length > 0 ? sanitizeRows(invoiceSheetData) : undefined,
            depositRecords: depositRows.length > 0 ? depositRows : undefined,
            depositTotal: depTotal > 0 ? depTotal : undefined,
            marginRecords: marginRecords.length > 0 ? marginRecords : undefined,
            marginTotal: marginTotal > 0 ? marginTotal : undefined,
            expenseRecords: allExpenses.length > 0 ? allExpenses : undefined,
        };

        setSaveStatus('saving');
        try {
            await upsertDailySales(dailySales, businessId);
            setSaveStatus('success');
            setTimeout(() => setSaveStatus('idle'), 2000);
        } catch (err: any) {
            console.error('매출 기록 저장 실패:', err);
            const rawMsg = err?.message || err?.code || '';
            let koreanMsg = '알 수 없는 오류가 발생했습니다.';
            if (rawMsg.includes('permission') || rawMsg.includes('PERMISSION_DENIED')) koreanMsg = 'Firestore 권한이 없습니다. 보안 규칙을 확인하세요.';
            else if (rawMsg.includes('not-found')) koreanMsg = 'Firestore 컬렉션을 찾을 수 없습니다.';
            else if (rawMsg.includes('unavailable') || rawMsg.includes('network')) koreanMsg = '네트워크 연결을 확인하세요.';
            else if (rawMsg.includes('undefined') || rawMsg.includes('unsupported field value')) koreanMsg = '저장 데이터에 잘못된 값이 포함되어 있습니다.';
            else if (rawMsg.includes('quota')) koreanMsg = 'Firestore 사용량 한도를 초과했습니다.';
            else if (rawMsg) koreanMsg = rawMsg;
            setSaveError(koreanMsg);
            setSaveStatus('error');
            setTimeout(() => setSaveStatus('idle'), 5000);
        }
    };

    const grandTotal = (Object.values(totalsMap) as number[]).reduce((a: number, b: number) => a + b, 0) +
                       manualTransfers.reduce((a: number, b: ManualTransfer) => a + b.amount, 0);

    // 전체 워크스테이션 주문수 합산 (원본 주문수와 비교용)
    // allItemSummaries는 Firestore 동기화 시 누락될 수 있으므로 allOrderRows 기반으로 카운트
    const totalWorkstationOrderCount = useMemo(() => {
        return (Object.values(allOrderRows) as any[][][]).reduce((sum: number, rows: any[][]) => sum + rows.length, 0);
    }, [allOrderRows]);

    const orderCountMismatch = masterProductSummary && totalWorkstationOrderCount > 0
        ? masterProductSummary.realTotal - totalWorkstationOrderCount
        : 0;

    const isAllSelected = selectedSessionIds.size > 0 && selectedSessionIds.size === (Object.values(companySessions).flat() as SessionData[]).length;

    return (
        <div className="space-y-6 animate-fade-in">
            <div>
                <section className="bg-zinc-900/60 rounded-[2.5rem] p-6 border border-zinc-800 shadow-2xl backdrop-blur-md">
                    <div className="flex flex-col lg:flex-row gap-6">
                        <div className="lg:w-[320px] shrink-0 flex flex-col gap-4">
                                <FileUpload
                                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleMasterUpload(f); }}
                                    onDrop={(e) => { const f = e.dataTransfer.files?.[0]; if (f) handleMasterUpload(f); }}
                                />
                            {masterOrderFile && (
                                <div className="bg-zinc-950 p-4 rounded-2xl border border-zinc-800 shadow-inner flex flex-col gap-3 min-w-[200px] animate-pop-in">
                                    <div className="flex justify-between items-center">
                                        <h4 className="text-zinc-500 font-black text-[10px] uppercase tracking-widest">Master File</h4>
                                        <button onClick={clearMasterFile} className="text-zinc-700 hover:text-rose-500 p-1"><ArrowPathIcon className="w-3.5 h-3.5" /></button>
                                    </div>
                                    <div className="text-white font-black text-sm truncate max-w-[150px]">{masterOrderFile.name}</div>
                                    <div className="flex items-center gap-2">
                                        <span className="bg-rose-500 text-white px-2 py-0.5 rounded-full text-[9px] font-black">{detectedCompanies.size}개 업체 탐지</span>
                                    </div>
                                    {masterProductSummary && (
                                        <div className="mt-1 flex gap-6 items-start">
                                            <div className="flex-1 min-w-0">
                                                <div className="text-xs font-black text-emerald-400 uppercase tracking-widest mb-1">실제 구매 ({masterProductSummary.realTotal}건)</div>
                                                <div>
                                                    {(() => {
                                                        const grouped: Record<string, [string, number][]> = {};
                                                        Object.entries(masterProductSummary.realOrders).forEach(([name, count]) => {
                                                            const company = masterProductSummary.productToCompany[name] || '기타';
                                                            if (!grouped[company]) grouped[company] = [];
                                                            grouped[company].push([name, count as number]);
                                                        });
                                                        Object.values(grouped).forEach(items => items.sort((a, b) => b[1] - a[1]));
                                                        return Object.entries(grouped).sort(([,a],[,b]) => b.reduce((s,x)=>s+x[1],0) - a.reduce((s,x)=>s+x[1],0)).map(([company, items]) => {
                                                            const companyTotal = items.reduce((s, x) => s + x[1], 0);
                                                            return (
                                                            <div key={company}>
                                                                <div className="text-sm text-zinc-300 font-black">{company} {companyTotal}건</div>
                                                                {items.map(([name, count]) => (
                                                                    <div key={name} className="flex text-sm pl-3">
                                                                        <span className="text-zinc-400">{name}</span>
                                                                        <span className="text-white font-black ml-1">{count}건</span>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        );});
                                                    })()}
                                                </div>
                                            </div>
                                            {masterProductSummary.fakeTotal > 0 && (
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-xs font-black text-amber-400 uppercase tracking-widest mb-1">가구매 ({masterProductSummary.fakeTotal}건)</div>
                                                    <div>
                                                        {(() => {
                                                            const grouped: Record<string, [string, number][]> = {};
                                                            Object.entries(masterProductSummary.fakeOrders).forEach(([name, count]) => {
                                                                const company = masterProductSummary.productToCompany[name] || '기타';
                                                                if (!grouped[company]) grouped[company] = [];
                                                                grouped[company].push([name, count as number]);
                                                            });
                                                            Object.values(grouped).forEach(items => items.sort((a, b) => b[1] - a[1]));
                                                            return Object.entries(grouped).sort(([,a],[,b]) => b.reduce((s,x)=>s+x[1],0) - a.reduce((s,x)=>s+x[1],0)).map(([company, items]) => {
                                                                const companyTotal = items.reduce((s, x) => s + x[1], 0);
                                                                return (
                                                                <div key={company}>
                                                                    <div className="text-sm text-zinc-400 font-black">{company} {companyTotal}건</div>
                                                                    {items.map(([name, count]) => (
                                                                        <div key={name} className="flex text-sm pl-3">
                                                                            <span className="text-zinc-500">{name}</span>
                                                                            <span className="text-amber-400 font-black ml-1">{count}건</span>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            );});
                                                        })()}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {masterProductSummary && masterProductSummary.allOrderDetails.length > 0 && (
                                        <details className="mt-2">
                                            <summary className="text-[10px] font-black text-zinc-600 cursor-pointer hover:text-zinc-400 transition-colors select-none">
                                                주문 상세 펼치기 ({masterProductSummary.realTotal + masterProductSummary.fakeTotal}건)
                                            </summary>
                                            <div className="mt-1 max-h-[300px] overflow-auto custom-scrollbar space-y-2 bg-zinc-950/50 rounded-lg p-2 border border-zinc-800/50">
                                                {(() => {
                                                    const details = masterProductSummary.allOrderDetails;
                                                    const grouped: Record<string, typeof details> = {};
                                                    details.forEach(d => {
                                                        const key = d.company || '미매칭';
                                                        if (!grouped[key]) grouped[key] = [];
                                                        grouped[key].push(d);
                                                    });
                                                    return Object.entries(grouped)
                                                        .sort(([a], [b]) => a === '미매칭' ? 1 : b === '미매칭' ? -1 : b.localeCompare(a))
                                                        .map(([company, orders]) => {
                                                        const realCount = orders.filter(o => !o.isFake).reduce((s, o) => s + o.qty, 0);
                                                        const fakeCount = orders.filter(o => o.isFake).reduce((s, o) => s + o.qty, 0);
                                                        return (
                                                            <div key={company}>
                                                                <div className="text-[11px] font-black text-zinc-300 flex items-center gap-2">
                                                                    <span className={company === '미매칭' ? 'text-red-400' : ''}>{company}</span>
                                                                    <span className="text-zinc-600">{realCount}건{fakeCount > 0 ? ` + 가구매 ${fakeCount}건` : ''}</span>
                                                                </div>
                                                                <div className="space-y-0.5 mt-0.5">
                                                                    {orders.map((o, idx) => (
                                                                        <div key={idx} className={`text-[10px] font-mono pl-3 flex gap-2 ${o.isFake ? 'text-amber-500/70 line-through' : company === '미매칭' ? 'text-red-300/80' : 'text-zinc-400'}`}>
                                                                            <span className="min-w-[50px]">{o.recipientName}</span>
                                                                            <span className="text-zinc-600">{o.groupName}</span>
                                                                            <span className="truncate">{o.productName}</span>
                                                                            {o.qty > 1 && <span className="text-white font-bold">x{o.qty}</span>}
                                                                            {o.isFake && <span className="text-amber-500/50 text-[8px]">가구매</span>}
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        );
                                                    });
                                                })()}
                                            </div>
                                        </details>
                                    )}
                                    {masterProductSummary?.unclaimedOrders && masterProductSummary.unclaimedOrders.length > 0 && (
                                        <div className="mt-2 bg-red-500/10 border border-red-500/40 rounded-xl px-3 py-2 animate-fade-in">
                                            <div className="text-red-400 text-[10px] font-black flex items-center gap-1 mb-1">
                                                <span>⚠</span> 업체 미매칭 {masterProductSummary.unclaimedOrders.reduce((s, o) => s + o.qty, 0)}건 - 어떤 업체에도 배정되지 않음
                                            </div>
                                            <div className="space-y-0.5">
                                                {masterProductSummary.unclaimedOrders.map((u, idx) => (
                                                    <div key={idx} className="text-[9px] text-red-300/80 font-mono truncate">
                                                        {u.recipientName} - {u.groupName} {u.productName} (x{u.qty})
                                                    </div>
                                                ))}
                                            </div>
                                            <div className="text-[9px] text-red-400/60 mt-1">
                                                해당 그룹명에 매칭되는 업체 키워드가 없습니다. 품목/업체 설정에서 키워드를 추가해주세요.
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        {masterOrderFile && (
                            <div className="bg-zinc-950 p-3 rounded-2xl border border-dashed border-zinc-700 hover:border-rose-500/50 transition-all">
                                <input ref={batchFileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { handleBatchUpload(f); e.target.value = ''; } }} />
                                <button onClick={() => batchFileInputRef.current?.click()} className="w-full flex items-center justify-center gap-2 py-2 text-[11px] font-black text-zinc-500 hover:text-rose-400 transition-colors">
                                    <PlusCircleIcon className="w-4 h-4" />
                                    <span>{(() => { let max = 0; (Object.values(companySessions) as SessionData[][]).forEach(ss => ss.forEach(s => { if (s.round > max) max = s.round; })); return `${max + 1}차 주문서 일괄 업로드`; })()}</span>
                                </button>
                            </div>
                        )}

                        <div className="flex-1 bg-zinc-950/40 p-5 rounded-2xl border border-zinc-800/50">
                            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
                                <div className="flex items-center gap-3">
                                    <h3 className="text-zinc-400 font-black text-[10px] uppercase tracking-widest flex items-center gap-2">
                                        <PlusCircleIcon className="w-4 h-4 text-rose-500" />
                                        수동 발주 추가
                                    </h3>
                                    <div className="flex bg-zinc-900 rounded-lg border border-zinc-800 p-0.5">
                                        <button onClick={() => setIsAIMode(false)} className={`px-3 py-1 rounded-md text-[10px] font-black transition-all ${!isAIMode ? 'bg-rose-500 text-white shadow' : 'text-zinc-500 hover:text-zinc-300'}`}>수동 입력</button>
                                        <button onClick={() => setIsAIMode(true)} className={`px-3 py-1 rounded-md text-[10px] font-black transition-all ${isAIMode ? 'bg-violet-500 text-white shadow' : 'text-zinc-500 hover:text-zinc-300'}`}>AI 입력</button>
                                    </div>
                                </div>
                                {!isAIMode && (
                                    <div className="flex flex-wrap gap-2">
                                        <span className="text-zinc-600 text-[9px] font-black uppercase self-center mr-1">빠른 선택 :</span>
                                        {QUICK_RECIPIENTS.map(p => (
                                            <button key={p.name} type="button" onClick={() => handleQuickSelect(p)} className="px-3 py-1 bg-zinc-800 hover:bg-rose-500 hover:text-white border border-zinc-700 rounded-full text-[10px] font-black text-zinc-400 transition-all shadow-sm">{p.name}</button>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {!isAIMode ? (
                                <form onSubmit={handleAddManualOrder} className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                                    <select value={manualInput.companyName} onChange={e => setManualInput({...manualInput, companyName: e.target.value, productName: ''})} className="bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none">
                                        <option value="">업체 선택</option>
                                        {Object.keys(pricingConfig).sort().map(name => <option key={name} value={name}>{name}</option>)}
                                    </select>
                                    <input placeholder="수령자" value={manualInput.recipientName} onChange={e => setManualInput({...manualInput, recipientName: e.target.value})} className="bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none" />
                                    <input placeholder="전화번호" value={manualInput.phone} onChange={e => setManualInput({...manualInput, phone: e.target.value})} className="bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none" />
                                    <input placeholder="주소" value={manualInput.address} onChange={e => setManualInput({...manualInput, address: e.target.value})} className="bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none" />
                                    <select value={manualInput.productName} onChange={e => setManualInput({...manualInput, productName: e.target.value})} className="bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none">
                                        <option value="">품목 선택</option>
                                        {manualInput.companyName && pricingConfig[manualInput.companyName]?.products &&
                                            Object.entries(pricingConfig[manualInput.companyName].products).map(([key, p]: [string, any]) => (
                                                <option key={key} value={p.displayName || key}>{p.displayName || key} ({(Number(p.supplyPrice) || 0).toLocaleString()}원)</option>
                                            ))
                                        }
                                    </select>
                                    <div className="flex gap-2">
                                        <input type="number" placeholder="수량" value={manualInput.qty} onChange={e => setManualInput({...manualInput, qty: e.target.value})} className="w-16 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none" />
                                        <button type="submit" className="flex-1 bg-rose-500 hover:bg-rose-600 text-white font-black rounded-xl text-xs transition-all shadow-lg">추가</button>
                                    </div>
                                </form>
                            ) : (
                                <div className="flex flex-col gap-3">
                                    <div className="flex gap-2">
                                        <textarea
                                            value={aiInput}
                                            onChange={e => setAiInput(e.target.value)}
                                            placeholder="예: 연두 포기김치 3kg를 김지아 집으로 보내줘&#10;예: 김성아한테 웰그린 당근 3kg 2개, 연두 총각김치 5kg 1개"
                                            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-xs font-bold text-white focus:ring-1 focus:ring-violet-500/30 outline-none resize-none min-h-[80px] placeholder:text-zinc-700"
                                            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && aiInput.trim()) { e.preventDefault(); parseNaturalLanguage(aiInput.trim()); } }}
                                        />
                                        <button
                                            onClick={() => aiInput.trim() && parseNaturalLanguage(aiInput.trim())}
                                            disabled={aiLoading || !aiInput.trim()}
                                            className="px-4 bg-violet-500 hover:bg-violet-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white font-black rounded-xl text-xs transition-all shadow-lg self-end h-10"
                                        >
                                            {aiLoading ? '분석중...' : 'AI 분석'}
                                        </button>
                                    </div>
                                    {aiError && <p className="text-rose-400 text-[11px] font-bold">{aiError}</p>}
                                    {parsedOrders.length > 0 && (
                                        <div className="bg-zinc-900/60 rounded-xl border border-violet-500/20 p-4 flex flex-col gap-2">
                                            <h4 className="text-violet-400 text-[10px] font-black uppercase tracking-widest mb-1">AI 파싱 결과 (수정 가능)</h4>
                                            {parsedOrders.map((o, i) => (
                                                <div key={i} className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 items-center bg-zinc-950/60 rounded-lg p-2 border border-zinc-800 animate-pop-in">
                                                    <select value={o.companyName} onChange={e => updateParsedOrder(i, { companyName: e.target.value, productName: '' })} className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-[11px] font-bold text-white outline-none">
                                                        <option value="">업체</option>
                                                        {Object.keys(pricingConfig).sort().map(name => <option key={name} value={name}>{name}</option>)}
                                                    </select>
                                                    <input value={o.recipientName} onChange={e => updateParsedOrder(i, { recipientName: e.target.value })} placeholder="수령자" className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-[11px] font-bold text-white outline-none" />
                                                    <input value={o.phone} onChange={e => updateParsedOrder(i, { phone: e.target.value })} placeholder="전화번호" className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-[11px] font-bold text-white outline-none" />
                                                    <input value={o.address} onChange={e => updateParsedOrder(i, { address: e.target.value })} placeholder="주소" className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-[11px] font-bold text-white outline-none" />
                                                    <select value={o.productName} onChange={e => updateParsedOrder(i, { productName: e.target.value })} className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-[11px] font-bold text-white outline-none">
                                                        <option value="">품목</option>
                                                        {o.companyName && pricingConfig[o.companyName]?.products &&
                                                            Object.entries(pricingConfig[o.companyName].products).map(([key, p]: [string, any]) => (
                                                                <option key={key} value={p.displayName || key}>{p.displayName || key} ({(Number(p.supplyPrice) || 0).toLocaleString()}원)</option>
                                                            ))
                                                        }
                                                    </select>
                                                    <div className="flex gap-1 items-center">
                                                        <input type="number" value={o.qty} onChange={e => updateParsedOrder(i, { qty: parseInt(e.target.value) || 1 })} className="w-14 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-[11px] font-bold text-white outline-none" />
                                                        <button onClick={() => removeParsedOrder(i)} className="text-zinc-600 hover:text-rose-500 transition-colors p-1"><TrashIcon className="w-3 h-3" /></button>
                                                    </div>
                                                </div>
                                            ))}
                                            <div className="flex justify-end gap-2 mt-2">
                                                <button onClick={() => { clearParsedOrders(); setAiInput(''); }} className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 font-black rounded-lg text-[11px] transition-all">취소</button>
                                                <button onClick={() => {
                                                    const newOrders: ManualOrder[] = parsedOrders.map(o => ({
                                                        id: `mo-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                                                        companyName: o.companyName, recipientName: o.recipientName,
                                                        phone: o.phone, address: o.address, productName: o.productName, qty: o.qty
                                                    }));
                                                    setManualOrders(prev => [...prev, ...newOrders]);
                                                    clearParsedOrders();
                                                    setAiInput('');
                                                }} className="px-4 py-1.5 bg-violet-500 hover:bg-violet-600 text-white font-black rounded-lg text-[11px] transition-all shadow-lg">전체 추가 ({parsedOrders.length}건)</button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {manualOrders.length > 0 && (
                                <div className="mt-4 flex flex-wrap gap-2">
                                    {manualOrders.map(o => (
                                        <div key={o.id} className="bg-zinc-900 px-3 py-1.5 rounded-lg border border-zinc-800 flex items-center gap-2 group animate-pop-in">
                                            <span className="text-[10px] font-black text-rose-500">{o.companyName}</span>
                                            <span className="text-[11px] font-bold text-zinc-300">{o.recipientName}</span>
                                            <span className="text-[10px] text-zinc-600 truncate max-w-[100px]">{o.productName}</span>
                                            <button onClick={() => handleRemoveManualOrder(o.id)} className="text-zinc-700 hover:text-rose-500 transition-colors"><TrashIcon className="w-3 h-3" /></button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </section>
            </div>

            <div className="flex flex-col lg:flex-row gap-6">
            <section className="flex-1 bg-zinc-900/60 rounded-[2.5rem] p-6 border border-zinc-800 shadow-2xl backdrop-blur-md">
                <div className="flex flex-col gap-6">
                    <div className="flex flex-col gap-4 w-full">
                        <div className="flex items-center gap-6">
                            <div className="bg-rose-500/10 p-4 rounded-[1.5rem] border border-rose-500/20 shadow-inner"><span className="text-3xl">💰</span></div>
                            <div>
                                <h2 className="text-zinc-500 font-black text-[10px] uppercase tracking-[0.2em] mb-0.5">Total Daily Settlement</h2>
                                <div className="flex items-baseline gap-2">
                                    <span className="text-4xl font-black text-white drop-shadow-lg">{grandTotal.toLocaleString()}</span>
                                    <span className="text-xl font-black text-rose-500">원</span>
                                </div>
                            </div>
                        </div>
                        {orderCountMismatch > 0 && (
                            <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-2 animate-fade-in">
                                <div className="text-red-400 text-[11px] font-black flex items-center gap-1">
                                    <span>⚠</span> 원본 {masterProductSummary!.realTotal}건 중 {orderCountMismatch}건이 발주서에 누락됨
                                    <span className="text-red-400/60 font-bold ml-1">(워크스테이션 합산: {totalWorkstationOrderCount}건)</span>
                                </div>
                            </div>
                        )}
                        <div className="flex flex-wrap gap-2 mt-1">
                            {sortCompanies(Object.keys(pricingConfig)).map(name => {
                                const sessions = companySessions[name] || [];
                                const sessionAmounts = sessions.map(s => ({ round: s.round, amount: totalsMap[s.id] || 0 })).filter(s => s.amount > 0);
                                if (sessionAmounts.length === 0) return null;
                                const companyTotal = sessionAmounts.reduce((sum, s) => sum + s.amount, 0);
                                return (
                                    <div key={name} className="bg-zinc-950/50 px-3 py-1.5 rounded-lg border border-zinc-800 flex items-center gap-2 group/item hover:border-rose-500/30 transition-all shadow-sm">
                                        <span className="text-[10px] font-black text-zinc-500">{name}</span>
                                        {sessionAmounts.length > 1 && sessionAmounts.map(s => (
                                            <span key={s.round} className="text-[9px] font-bold text-zinc-600">{s.round}차 {s.amount.toLocaleString()}</span>
                                        ))}
                                        <span className="text-[11px] font-black text-white">{sessionAmounts.length > 1 ? '합계 ' : ''}{companyTotal.toLocaleString()}원</span>
                                    </div>
                                );
                            })}
                            {manualTransfers.map(t => (
                                <div key={t.id} className={`${t.isAdjustment ? 'bg-rose-950/30 border-rose-500/30' : 'bg-indigo-950/30 border-indigo-500/30'} px-3 py-1.5 rounded-lg border flex items-center gap-2 group/item hover:border-rose-500/30 transition-all shadow-sm`}>
                                    <span className={`text-[10px] font-black ${t.isAdjustment ? 'text-rose-400' : 'text-indigo-400'}`}>{t.label}</span>
                                    <span className="text-[11px] font-black text-white">{t.amount.toLocaleString()}원</span>
                                    <button onClick={() => handleDeleteManualTransfer(t.id)} className="text-zinc-600 hover:text-rose-500 transition-all p-0.5"><TrashIcon className="w-3 h-3" /></button>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-3 shrink-0">
                        <button onClick={handleDownloadMergedUploadInvoices} disabled={selectedSessionIds.size === 0} className={`flex items-center gap-3 px-4 py-2.5 rounded-xl font-black text-xs transition-all border shadow-lg disabled:opacity-30 disabled:cursor-not-allowed ${selectedSessionIds.size > 0 ? 'bg-rose-500 text-white border-rose-400 ring-4 ring-rose-500/10' : 'bg-zinc-800 text-zinc-500 border-zinc-700'}`}>
                            <BoltIcon className="w-4 h-4" /><span>송장 병합 ({selectedSessionIds.size})</span>
                        </button>
                        <button onClick={handleDownloadDepositList} className="flex items-center gap-3 bg-zinc-800 text-zinc-300 hover:text-white px-4 py-2.5 rounded-xl font-black text-xs transition-all border border-zinc-700 hover:border-zinc-500 shadow-lg"><ArrowDownTrayIcon className="w-4 h-4" /><span>입금목록</span></button>
                        <button onClick={handleDownloadWorkLog} className="flex items-center gap-3 bg-rose-500 text-white hover:bg-rose-600 px-6 py-2.5 rounded-xl font-black text-sm transition-all shadow-xl border border-rose-400/20"><ClipboardDocumentCheckIcon className="w-5 h-5" /><span>업무일지</span></button>
                        <div className="flex flex-col items-end gap-1">
                            <button
                                onClick={handleSaveToSalesHistory}
                                disabled={saveStatus === 'saving'}
                                className={`flex items-center gap-3 px-6 py-2.5 rounded-xl font-black text-sm transition-all shadow-xl border ${
                                    saveStatus === 'success'
                                        ? 'bg-emerald-500 text-white border-emerald-400/20'
                                        : saveStatus === 'error'
                                        ? 'bg-red-500 text-white border-red-400/20'
                                        : saveStatus === 'saving'
                                        ? 'bg-zinc-700 text-zinc-400 border-zinc-600 cursor-wait'
                                        : 'bg-indigo-500 text-white hover:bg-indigo-600 border-indigo-400/20'
                                }`}
                            >
                                <ChartBarIcon className="w-5 h-5" />
                                <span>{
                                    saveStatus === 'saving' ? '저장 중...'
                                    : saveStatus === 'success' ? '기록 완료!'
                                    : saveStatus === 'error' ? '저장 실패'
                                    : '기록하기'
                                }</span>
                            </button>
                            {saveStatus === 'error' && saveError && (
                                <span className="text-red-400 text-[11px] font-bold max-w-[200px] text-right">{saveError}</span>
                            )}
                        </div>
                    </div>
                </div>
            </section>

            <section className="lg:w-[400px] shrink-0 bg-zinc-900/40 rounded-[2.5rem] p-6 border border-zinc-800 shadow-xl overflow-hidden">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <div className="bg-indigo-500/10 p-2 rounded-lg"><BoltIcon className="w-4 h-4 text-indigo-500" /></div>
                        <h3 className="text-xs font-black text-white tracking-widest uppercase">Other Expenses</h3>
                    </div>
                    <div className="flex p-1 bg-zinc-950 rounded-lg border border-zinc-800">
                        <button onClick={() => setIsBulkMode(false)} className={`px-4 py-1.5 rounded-md text-[10px] font-black transition-all ${!isBulkMode ? 'bg-zinc-800 text-white' : 'text-zinc-600'}`}>수동 입력</button>
                        <button onClick={() => setIsBulkMode(true)} className={`px-4 py-1.5 rounded-md text-[10px] font-black transition-all ${isBulkMode ? 'bg-indigo-600 text-white' : 'text-zinc-600'}`}>지능형 분석</button>
                    </div>
                </div>
                {!isBulkMode ? (
                    <form onSubmit={handleAddManualTransfer} className="grid grid-cols-2 gap-2 items-end">
                        <input type="text" placeholder="은행명" value={newTransfer.bankName} onChange={e => setNewTransfer({...newTransfer, bankName: e.target.value})} className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-bold text-white focus:outline-none" />
                        <input type="text" placeholder="계좌번호" value={newTransfer.accountNumber} onChange={e => setNewTransfer({...newTransfer, accountNumber: e.target.value})} className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono font-bold text-white focus:outline-none" />
                        <input type="number" placeholder="금액" value={newTransfer.amount} onChange={e => setNewTransfer({...newTransfer, amount: e.target.value})} className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-black text-rose-500 focus:outline-none" />
                        <input type="text" placeholder="입금자명" value={newTransfer.label} onChange={e => setNewTransfer({...newTransfer, label: e.target.value})} className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-bold text-white focus:outline-none" />
                        <button type="submit" className="bg-indigo-600 hover:bg-indigo-500 text-white font-black py-2 rounded-lg transition-all shadow-lg text-xs">추가</button>
                    </form>
                ) : (
                    <div className="space-y-3">
                        <textarea placeholder="예: 31000 홍길동 국민 1234..." value={bulkText} onChange={e => setBulkText(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-xs font-mono text-zinc-300 focus:outline-none h-24 resize-none" />
                        <div className="flex justify-end">
                            <button onClick={() => {
                                const lines = bulkText.split('\n');
                                const newEntries: ManualTransfer[] = [];
                                lines.forEach((line, index) => {
                                    if (!line.trim()) return;
                                    const parts = line.trim().split(/\s+/);
                                    let amount = 0; let labelParts: string[] = [];
                                    parts.forEach(p => {
                                        const cleanNum = p.replace(/[,원]/g, '');
                                        const n = parseInt(cleanNum);
                                        if (!isNaN(n) && /^\d+$/.test(cleanNum) && n >= 100 && amount === 0) amount = n;
                                        else if (p) labelParts.push(p);
                                    });
                                    if (amount > 0) newEntries.push({ id: `bulk-${Date.now()}-${index}`, label: labelParts.join(' ') || '수동 지출', bankName: '은행', accountNumber: '계좌', amount });
                                });
                                setManualTransfers(prev => [...prev, ...newEntries]); setBulkText(''); setIsBulkMode(false);
                            }} className="bg-indigo-600 hover:bg-indigo-500 text-white font-black py-2.5 px-6 rounded-xl transition-all shadow-xl flex items-center gap-2 text-xs">
                                <BoltIcon className="w-4 h-4" /><span>분석 및 추가</span>
                            </button>
                        </div>
                    </div>
                )}
            </section>
            </div>

            <section className="bg-zinc-900/20 rounded-[2.5rem] border border-zinc-900 overflow-hidden shadow-2xl">
                <div className="p-6 border-b border-zinc-900 bg-zinc-900/40 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="bg-zinc-800 p-2 rounded-xl border border-zinc-700"><BuildingStorefrontIcon className="w-5 h-5 text-rose-500" /></div>
                        <h2 className="text-xl font-black text-white tracking-tight uppercase">Workstation</h2>
                    </div>
                    {(() => {
                        const totalOrders: number = Object.values(allOrderRows).reduce<number>((sum, rows) => sum + (rows as any[][]).length, 0);
                        const totalAmount: number = Object.values(totalsMap).reduce<number>((sum, v) => sum + (v as number), 0);
                        return totalOrders > 0 ? (
                            <div className="flex items-center gap-3 text-xs font-black">
                                <span className="bg-rose-500/10 text-rose-400 px-3 py-1.5 rounded-full">{totalOrders}건</span>
                                <span className="bg-zinc-800 text-zinc-400 px-3 py-1.5 rounded-full">{totalAmount.toLocaleString()}원</span>
                            </div>
                        ) : null;
                    })()}
                </div>
                {/* 비용(지출내역) 섹션 */}
                <div className="m-4 p-6 rounded-2xl border border-zinc-700 bg-zinc-950">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="bg-orange-500/10 p-2 rounded-lg"><ChartBarIcon className="w-4 h-4 text-orange-500" /></div>
                        <h3 className="text-zinc-200 font-black text-xs uppercase tracking-widest flex items-center gap-2">
                            비용 관리
                            {allExpenses.length > 0 && (
                                <span className="bg-orange-500 text-white text-[9px] px-2 py-0.5 rounded-full animate-pop-in">
                                    {allExpenses.length}건 · {allExpenses.reduce((s, e) => s + e.amount, 0).toLocaleString()}원
                                </span>
                            )}
                        </h3>
                    </div>
                    <div className="flex items-center gap-2 mb-3">
                        <select
                            value={newExpense.category}
                            onChange={(e) => setNewExpense(prev => ({ ...prev, category: e.target.value }))}
                            className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-bold text-zinc-300 focus:outline-none focus:border-orange-500/50"
                        >
                            {EXPENSE_CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                        </select>
                        <input
                            type="text"
                            value={newExpense.amount}
                            onChange={(e) => {
                                const v = e.target.value.replace(/[^0-9]/g, '');
                                setNewExpense(prev => ({ ...prev, amount: v }));
                            }}
                            placeholder="금액"
                            className="w-28 bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] font-mono text-zinc-300 focus:outline-none focus:border-orange-500/50 text-right"
                        />
                        <input
                            type="text"
                            value={newExpense.description}
                            onChange={(e) => setNewExpense(prev => ({ ...prev, description: e.target.value }))}
                            placeholder="지출내역"
                            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-[11px] text-zinc-300 focus:outline-none focus:border-orange-500/50"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && newExpense.amount && parseInt(newExpense.amount) > 0) {
                                    setExpenses(prev => [...prev, {
                                        id: `exp-${Date.now()}`,
                                        category: newExpense.category,
                                        amount: parseInt(newExpense.amount),
                                        description: newExpense.description,
                                    }]);
                                    setNewExpense(prev => ({ ...prev, amount: '', description: '' }));
                                }
                            }}
                        />
                        <button
                            onClick={() => {
                                if (!newExpense.amount || parseInt(newExpense.amount) <= 0) return;
                                setExpenses(prev => [...prev, {
                                    id: `exp-${Date.now()}`,
                                    category: newExpense.category,
                                    amount: parseInt(newExpense.amount),
                                    description: newExpense.description,
                                }]);
                                setNewExpense(prev => ({ ...prev, amount: '', description: '' }));
                            }}
                            className="bg-orange-600 hover:bg-orange-500 text-white font-black py-2.5 px-4 rounded-xl transition-all shadow-md text-[10px] flex items-center gap-1.5"
                        >
                            <PlusCircleIcon className="w-3.5 h-3.5" />추가
                        </button>
                    </div>
                    {allExpenses.length > 0 && (
                        <div className="space-y-1.5">
                            {allExpenses.map((exp) => (
                                <div key={exp.id} className={`flex items-center justify-between px-4 py-2.5 rounded-xl border ${exp.isAuto ? 'bg-teal-950/20 border-teal-500/20' : 'bg-zinc-950/50 border-zinc-800/50'}`}>
                                    <div className="flex items-center gap-3">
                                        <span className={`text-[9px] font-black px-2 py-0.5 rounded-full ${exp.isAuto ? 'bg-teal-500/20 text-teal-400 border border-teal-500/30' : 'bg-orange-500/20 text-orange-400 border border-orange-500/30'}`}>
                                            {exp.category}
                                        </span>
                                        <span className="text-[11px] text-zinc-400">{exp.description}</span>
                                        {exp.isAuto && <span className="text-[9px] text-teal-600 font-bold">자동</span>}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-[11px] font-mono font-bold text-zinc-300">{exp.amount.toLocaleString()}원</span>
                                        {!exp.isAuto && (
                                            <button onClick={() => setExpenses(prev => prev.filter(e => e.id !== exp.id))} className="text-zinc-700 hover:text-rose-500 transition-colors">
                                                <TrashIcon className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))}
                            <div className="flex justify-end pt-2 pr-4">
                                <span className="text-[10px] font-black text-orange-400">
                                    총 비용: {allExpenses.reduce((s, e) => s + e.amount, 0).toLocaleString()}원
                                </span>
                            </div>
                        </div>
                    )}
                </div>

                <div className="m-4 p-6 rounded-2xl border border-zinc-700 bg-zinc-950">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                            <div className="bg-rose-500/10 p-2 rounded-lg"><BoltIcon className="w-4 h-4 text-rose-500" /></div>
                            <h3 className="text-zinc-200 font-black text-xs uppercase tracking-widest flex items-center gap-2">
                                가구매 명단 설정
                                {fakeOrderAnalysis.inputNumbers.size > 0 && (
                                    <div className="flex gap-1">
                                        <span className="bg-zinc-800 text-zinc-400 text-[9px] px-2 py-0.5 rounded-full animate-pop-in border border-zinc-700">
                                            총 {fakeOrderAnalysis.inputNumbers.size}명
                                        </span>
                                        <span className="bg-emerald-500 text-white text-[9px] px-2 py-0.5 rounded-full animate-pop-in">
                                            매칭 {fakeOrderAnalysis.matched.length}
                                        </span>
                                        {fakeOrderAnalysis.missing.length > 0 && (
                                            <span className="bg-rose-500 text-white text-[9px] px-2 py-0.5 rounded-full animate-pop-in">
                                                미발견 {fakeOrderAnalysis.missing.length}
                                            </span>
                                        )}
                                    </div>
                                )}
                            </h3>
                        </div>
                        <div className="flex gap-2">
                            <button onClick={() => setShowFakeDetail(!showFakeDetail)} className={`p-1 transition-colors ${showFakeDetail ? 'text-rose-500' : 'text-zinc-600 hover:text-white'}`} title="상세 누락 내역">
                                <DocumentCheckIcon className="w-4 h-4" />
                            </button>
                            <button onClick={() => setShowFakeOrderInput(!showFakeOrderInput)} className="text-zinc-500 hover:text-white transition-colors">
                                {showFakeOrderInput ? <ChevronUpIcon className="w-4 h-4" /> : <ChevronDownIcon className="w-4 h-4" />}
                            </button>
                        </div>
                    </div>

                    {showFakeDetail && fakeOrderAnalysis.inputNumbers.size > 0 && (
                        <div className="mb-4 bg-zinc-950/80 p-4 rounded-xl border border-zinc-800 animate-fade-in max-h-[300px] overflow-auto custom-scrollbar">
                            <div className="space-y-4">
                                {fakeOrderAnalysis.missing.length > 0 && (
                                    <div>
                                        <h4 className="text-rose-500 font-black text-xs mb-3 tracking-widest flex items-center gap-2">
                                            <span className="w-2 h-2 bg-rose-500 rounded-full animate-pulse" />
                                            파일에서 찾지 못한 주문 ({fakeOrderAnalysis.missing.length}건)
                                        </h4>
                                        <div className="grid grid-cols-1 gap-2">
                                            {fakeOrderAnalysis.missing.map(num => {
                                                const name = fakeOrderAnalysis.nameMap[num];
                                                return (
                                                    <div key={num} className="flex items-center justify-between bg-rose-950/30 border border-rose-500/20 px-4 py-3 rounded-xl">
                                                        <div className="flex items-center gap-3">
                                                            {name && <span className="text-sm font-black text-white">{name}</span>}
                                                            <span className="text-xs font-mono text-rose-400">{num}</span>
                                                        </div>
                                                        <span className="text-[11px] text-rose-500 font-bold bg-rose-950/50 px-2.5 py-1 rounded-lg border border-rose-500/20">주문서에서 미발견 - 업체 발주 누락 또는 주문번호 오류</span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                                <div>
                                    <h4 className="text-emerald-500 font-black text-xs mb-3 tracking-widest flex items-center gap-2">
                                        <span className="w-2 h-2 bg-emerald-500 rounded-full" />
                                        정상 제외 완료 ({fakeOrderAnalysis.matched.length}건)
                                    </h4>
                                    <div className="grid grid-cols-1 gap-2">
                                        {fakeOrderAnalysis.matched.map(num => {
                                            const detail = fakeOrderAnalysis.foundDetails[num];
                                            return (
                                                <div key={num} className="flex items-center justify-between bg-zinc-900/50 px-4 py-3 rounded-xl border border-zinc-800/50">
                                                    <div className="flex items-center gap-3">
                                                        <span className="text-sm font-black text-white">{detail.recipientName}</span>
                                                        <span className="text-xs font-mono text-zinc-500">{num}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-xs text-zinc-400 font-bold">{detail.productName}</span>
                                                        <span className="text-[11px] bg-zinc-800 text-emerald-500 px-2.5 py-1 rounded-full font-black border border-emerald-500/20">{detail.companyName}</span>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {showFakeOrderInput ? (
                        <div className="flex flex-col lg:flex-row gap-4 animate-fade-in">
                            <div className="flex-1">
                                <textarea
                                    autoFocus value={fakeOrderInput} onChange={(e) => setFakeOrderInput(e.target.value)}
                                    placeholder="예: 홍길동 20231010-00001"
                                    className="w-full h-full min-h-[96px] bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-[11px] font-mono text-zinc-300 focus:outline-none focus:border-rose-500/50 resize-none custom-scrollbar"
                                />
                            </div>
                            <div className="flex-1 space-y-3">
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={handleDeliveryAgentDownload}
                                    disabled={!masterOrderFile || fakeOrderAnalysis.inputNumbers.size === 0}
                                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-[10px] font-black border transition-all shadow-md disabled:opacity-30 disabled:cursor-not-allowed bg-amber-950/30 border-amber-500/30 text-amber-400 hover:bg-amber-900/40 hover:border-amber-500/50"
                                >
                                    <ArrowDownTrayIcon className="w-4 h-4" />
                                    <span>택배대행 다운로드 ({fakeOrderAnalysis.inputNumbers.size}건)</span>
                                </button>
                                <button
                                    onClick={handleLotteTemplateDownload}
                                    disabled={!masterOrderFile || fakeOrderAnalysis.inputNumbers.size === 0}
                                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-[10px] font-black border transition-all shadow-md disabled:opacity-30 disabled:cursor-not-allowed bg-indigo-950/30 border-indigo-500/30 text-indigo-400 hover:bg-indigo-900/40 hover:border-indigo-500/50"
                                >
                                    <ArrowDownTrayIcon className="w-4 h-4" />
                                    <span>롯데택배 다운로드 ({fakeOrderAnalysis.inputNumbers.size}건)</span>
                                </button>
                            </div>
                            <div className="flex items-center gap-2">
                                <label className={`flex-1 flex items-center justify-center gap-2 cursor-pointer px-4 py-2.5 rounded-xl text-[10px] font-black border transition-all shadow-md ${lotteFile ? 'bg-indigo-950/30 border-indigo-500/30 text-indigo-400' : 'bg-zinc-900/50 border-zinc-700 text-zinc-500 hover:border-indigo-500/40 hover:text-indigo-400'}`}>
                                    <ArrowDownTrayIcon className="w-4 h-4" />
                                    <span>{lotteFile ? lotteFile.name : '롯데택배 파일 업로드'}</span>
                                    <input type="file" className="sr-only" accept=".xlsx,.xls" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleLotteFileUpload(f); }} />
                                </label>
                                {lotteFile && (
                                    <button onClick={() => { setLotteFile(null); setLotteResult(null); setLotteMatchedRows(null); }} className="p-2 bg-zinc-900 rounded-xl text-zinc-700 hover:text-rose-500 border border-zinc-800 transition-colors">
                                        <ArrowPathIcon className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </div>
                            {lotteResult && (
                                <div className="bg-zinc-950/80 p-3 rounded-xl border border-zinc-800 animate-fade-in space-y-2">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="bg-emerald-500 text-white text-[9px] px-2 py-0.5 rounded-full font-black">매칭 {lotteResult.matched}건</span>
                                        <span className="text-zinc-500 text-[9px] font-black">/ 가구매 {lotteResult.total}건</span>
                                        {lotteResult.notFound.length > 0 && (
                                            <span className="bg-rose-500 text-white text-[9px] px-2 py-0.5 rounded-full font-black">미매칭 {lotteResult.notFound.length}건</span>
                                        )}
                                    </div>
                                    {lotteResult.notFound.length > 0 && (
                                        <div className="flex flex-wrap gap-1">
                                            {lotteResult.notFound.map(num => (
                                                <span key={num} className="bg-rose-950/40 text-rose-400 border border-rose-500/20 px-1.5 py-0.5 rounded text-[9px] font-mono">{num}</span>
                                            ))}
                                        </div>
                                    )}
                                    {lotteMatchedRows && (
                                        <button onClick={handleLotteDownload} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-[10px] font-black transition-colors shadow-lg">
                                            <ArrowDownTrayIcon className="w-4 h-4" />
                                            운송장 입력완료 다운로드 ({lotteResult.matched}건)
                                        </button>
                                    )}
                                </div>
                            )}
                            <div className="flex items-center gap-2">
                                <label className={`flex-1 flex items-center justify-center gap-2 cursor-pointer px-4 py-2.5 rounded-xl text-[10px] font-black border transition-all shadow-md ${agentFile ? 'bg-teal-950/30 border-teal-500/30 text-teal-400' : 'bg-zinc-900/50 border-zinc-700 text-zinc-500 hover:border-teal-500/40 hover:text-teal-400'}`}>
                                    <ArrowDownTrayIcon className="w-4 h-4" />
                                    <span>{agentFile ? agentFile.name : '택배대행 운송장 업로드'}</span>
                                    <input type="file" className="sr-only" accept=".xlsx,.xls" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAgentFileUpload(f); }} />
                                </label>
                                {agentFile && (
                                    <button onClick={() => { setAgentFile(null); setAgentResult(null); setAgentMatchedRows(null); }} className="p-2 bg-zinc-900 rounded-xl text-zinc-700 hover:text-rose-500 border border-zinc-800 transition-colors">
                                        <ArrowPathIcon className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </div>
                            {agentResult && (
                                <div className="bg-zinc-950/80 p-3 rounded-xl border border-zinc-800 animate-fade-in space-y-2">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="bg-emerald-500 text-white text-[9px] px-2 py-0.5 rounded-full font-black">매칭 {agentResult.matched}건</span>
                                        <span className="text-zinc-500 text-[9px] font-black">/ 가구매 {agentResult.total}건</span>
                                        {agentResult.notFound.length > 0 && (
                                            <span className="bg-rose-500 text-white text-[9px] px-2 py-0.5 rounded-full font-black">미매칭 {agentResult.notFound.length}건</span>
                                        )}
                                    </div>
                                    {agentResult.notFound.length > 0 && (
                                        <div className="flex flex-wrap gap-1">
                                            {agentResult.notFound.map(num => (
                                                <span key={num} className="bg-rose-950/40 text-rose-400 border border-rose-500/20 px-1.5 py-0.5 rounded text-[9px] font-mono">{num}</span>
                                            ))}
                                        </div>
                                    )}
                                    {agentMatchedRows && (
                                        <button onClick={handleAgentDownload} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-teal-600 hover:bg-teal-500 text-white rounded-xl text-[10px] font-black transition-colors shadow-lg">
                                            <ArrowDownTrayIcon className="w-4 h-4" />
                                            택배대행 운송장완료 다운로드 ({agentResult.matched}건)
                                        </button>
                                    )}
                                </div>
                            )}
                            </div>
                        </div>
                    ) : (
                        <div className="flex items-center justify-center h-24 border border-dashed border-zinc-800 rounded-xl cursor-pointer hover:bg-zinc-800/20 transition-all" onClick={() => setShowFakeOrderInput(true)}>
                            <span className="text-[10px] font-black text-zinc-600 uppercase tracking-widest">명단 입력하기</span>
                        </div>
                    )}
                </div>
                <div className="flex justify-end mb-2">
                    <button onClick={handleResetWorkstations} className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-black text-zinc-500 hover:text-rose-400 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-rose-500/30 rounded-lg transition-all" title="워크스테이션 초기화">
                        <ArrowPathIcon className="w-3.5 h-3.5" />
                        <span>워크스테이션 초기화</span>
                    </button>
                </div>
                <div className="overflow-x-auto">
                    <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={handleDragEnd}
                    >
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="sticky top-0 z-10 bg-zinc-950 text-zinc-500 text-[10px] font-black uppercase tracking-[0.15em]">
                                    <th className="px-6 py-4 w-[35%] whitespace-nowrap">
                                        <div className="flex items-center gap-3">
                                            <button onClick={handleSelectAllSessions} className={`w-5 h-5 rounded-md border flex items-center justify-center transition-all ${isAllSelected ? 'bg-rose-500 border-rose-400 text-white' : 'bg-zinc-900 border-zinc-700 text-transparent hover:border-rose-500/50'}`} title="전체 선택"><CheckIcon className="w-3 h-3" /></button>
                                            <span>업체 정보</span>
                                        </div>
                                    </th>
                                    <th className="px-6 py-4 w-[30%] text-center whitespace-nowrap">
                                        발주서
                                        {(() => {
                                            const total: number = Object.values(allOrderRows).reduce<number>((s, r) => s + (r as any[][]).length, 0);
                                            return total > 0 ? <span className="ml-2 text-white font-black text-xl normal-case tracking-normal">{total}건</span> : null;
                                        })()}
                                    </th>
                                    <th className="px-6 py-4 w-[35%] text-center whitespace-nowrap">송장 매칭</th>
                                </tr>
                            </thead>
                            <SortableContext
                                items={sortCompanies(Object.keys(pricingConfig))}
                                strategy={verticalListSortingStrategy}
                            >
                                {sortCompanies(Object.keys(pricingConfig)).map(company => (
                                    <SortableCompanyRow key={company} id={company}>
                                        {(companySessions[company] || []).map((session, sIdx) => {
                                        const prevItems = (companySessions[company] || [])
                                            .slice(0, sIdx)
                                            .map(ps => ({ round: ps.round, summary: allItemSummaries[ps.id] || {} }))
                                            .filter(item => Object.keys(item.summary).length > 0);
                                        return isReady ? (
                                            <CompanyWorkstationRow
                                                key={session.id} sessionId={session.id} companyName={company} roundNumber={session.round} isFirstSession={sIdx === 0} isLastSession={sIdx === (companySessions[company] || []).length - 1} pricingConfig={pricingConfig}
                                                vendorFile={vendorFiles[company] || null} masterFile={masterOrderFile} batchFile={batchFiles[session.id] || null} isDetected={detectedCompanies.has(company)} fakeOrderNumbers={fakeOrderInput}
                                                manualOrders={sIdx === 0 ? manualOrders.filter(o => o.companyName === company) : []} isSelected={selectedSessionIds.has(session.id)} onSelectToggle={handleToggleSessionSelection}
                                                onVendorFileChange={(file) => handleVendorFileChange(company, file)} onResultUpdate={handleResultUpdate} onDataUpdate={handleDataUpdate}
                                                onAddSession={() => handleAddSession(company)} onRemoveSession={() => handleRemoveSession(company, session.id)} onAddAdjustment={handleAddCompanyAdjustment}
                                                onDownloadMergedOrder={(companySessions[company] || []).length > 1 ? () => handleDownloadMergedOrder(company) : undefined}
                                                onDownloadMergedInvoice={(companySessions[company] || []).length > 1 ? (type: 'mgmt' | 'upload') => handleDownloadMergedInvoice(company, type) : undefined}
                                                previousRoundItems={prevItems}
                                                manualOrdersRejected={manualOrdersRejectedCompanies.has(company)}
                                                onManualOrdersApproval={handleManualOrdersApproval}
                                                businessId={businessId}
                                                onConfigChange={onConfigChange}
                                                masterExpectedCount={sIdx === 0
                                                    ? (masterProductSummary?.companyOrderCounts?.[company] || 0)
                                                    : (batchExpectedCounts[session.id] || 0)
                                                }
                                            />
                                        ) : null;
                                    })}
                                </SortableCompanyRow>
                            ))}
                            </SortableContext>
                        </table>
                    </DndContext>
                </div>
            </section>
        </div>
    );
};

export default CompanySelector;
