
import React, { useState, useEffect, useRef, useContext } from 'react';
import { useInvoiceMerger, type PlatformUploadResult } from '../hooks/useInvoiceMerger';
import { useConsolidatedOrderConverter, ProcessedResult, getKeywordsForCompany, getHeaderForCompany } from '../hooks/useConsolidatedOrderConverter';
import {
    ArrowDownTrayIcon, CheckIcon, UploadIcon, BoltIcon,
    ChevronDownIcon, ChevronUpIcon, ArrowPathIcon, DocumentArrowUpIcon,
    PlusCircleIcon, TrashIcon
} from './icons';
import type { PricingConfig, ExcludedOrder, ManualOrder, UnmatchedOrder, PlatformConfigs } from '../types';
import { DragHandleContext } from './DragHandleContext';
import { getBusinessInfo } from '../types';
import { useDailyWorkspace } from '../hooks/useFirestore';
import type { SessionResultData } from '../services/firestoreService';

declare var XLSX: any;

interface WorkflowStatus {
    order: boolean;
    deposit: boolean;
    invoice: boolean;
}

interface SessionAdjustment {
    id: string;
    amount: number;
    label: string;
}

interface CompanyWorkstationRowProps {
    sessionId: string;
    companyName: string;
    roundNumber: number;
    isFirstSession: boolean;
    isLastSession: boolean;
    pricingConfig: PricingConfig;
    vendorFile: File | null;
    masterFile: File | null;
    batchFile?: File | null;
    isDetected: boolean;
    fakeOrderNumbers: string;
    manualOrders?: ManualOrder[];
    isSelected?: boolean;
    onSelectToggle?: (sessionId: string) => void;
    onVendorFileChange: (file: File | null) => void;
    onResultUpdate: (sessionId: string, totalPrice: number, excludedCount?: number, excludedDetails?: ExcludedOrder[]) => void;
    onDataUpdate: (sessionId: string, orderRows: any[][], invoiceRows: any[][], uploadInvoiceRows: any[][], summaryExcel: string, header?: any[], registeredProductNames?: Record<string, string>, itemSummary?: Record<string, { count: number; totalPrice: number }>, orderItems?: { registeredProductName: string; registeredOptionName: string; matchedProductKey: string; qty: number }[]) => void;
    onAddSession: () => void;
    onRemoveSession: () => void;
    onAddAdjustment: (companyName: string, amount: string) => void;
    onDownloadMergedOrder?: () => void;
    onDownloadMergedInvoice?: (type: 'mgmt' | 'upload') => void;
    previousRoundItems?: { round: number; summary: Record<string, { count: number; totalPrice: number }> }[];
    manualOrdersRejected?: boolean;
    onManualOrdersApproval?: (companyName: string, approved: boolean) => void;
    businessId?: string;
    onConfigChange: (newConfig: PricingConfig) => void;
    masterExpectedCount?: number;
    missingItems?: { groupName: string; diffQty: number }[];
    orderPlatformMap?: Map<string, string>;
    platformConfigs?: PlatformConfigs;
    fakeCourierRows?: any[][];
}

const CompanyWorkstationRow: React.FC<CompanyWorkstationRowProps> = ({
    sessionId, companyName, roundNumber, isFirstSession, isLastSession, pricingConfig, vendorFile, masterFile, batchFile, isDetected, fakeOrderNumbers, manualOrders = [],
    isSelected, onSelectToggle, onVendorFileChange, onResultUpdate, onDataUpdate, onAddSession, onRemoveSession, onAddAdjustment, onDownloadMergedOrder, onDownloadMergedInvoice,
    previousRoundItems = [],
    manualOrdersRejected = false, onManualOrdersApproval,
    businessId, onConfigChange, masterExpectedCount = 0,
    missingItems = [],
    orderPlatformMap, platformConfigs,
    fakeCourierRows
}) => {
    const dragHandle = useContext(DragHandleContext);
    const [showSummary, setShowSummary] = useState(false);
    const [showExcluded, setShowExcluded] = useState(false);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [copiedExcelId, setCopiedExcelId] = useState<string | null>(null);
    const [localResult, setLocalResult] = useState<ProcessedResult | null>(null);
    const [excludedList, setExcludedList] = useState<ExcludedOrder[]>([]);
    const [unmatchedList, setUnmatchedList] = useState<UnmatchedOrder[]>([]);
    const [isLocalProcessing, setIsLocalProcessing] = useState(false);
    const [localFile, setLocalFile] = useState<File | null>(null);
    const [isAddingKeyword, setIsAddingKeyword] = useState(false);
    const [newKeyword, setNewKeyword] = useState('');
    const newKeywordRef = useRef('');
    const pricingConfigRef = useRef(pricingConfig);
    pricingConfigRef.current = pricingConfig;
    
    const { workspace, updateField } = useDailyWorkspace(businessId);

    // 수동 차감/추가 내역 상태
    const [adjAmount, setAdjAmount] = useState('');
    const [adjLabel, setAdjLabel] = useState('');
    const [sessionAdjustments, setSessionAdjustments] = useState<SessionAdjustment[]>([]);

    const [workflow, setWorkflow] = useState<WorkflowStatus>({ order: false, deposit: false, invoice: false });
    const [showPrevRoundItems, setShowPrevRoundItems] = useState(false);

    // 합산 헬퍼: previousRoundItems + 현재 세션 summary를 합산
    const _mergeSummaries = () => {
        const merged: Record<string, { count: number; totalPrice: number }> = {};
        for (const item of previousRoundItems) {
            for (const [key, stat] of Object.entries(item.summary) as [string, { count: number; totalPrice: number }][]) {
                if (!merged[key]) merged[key] = { count: 0, totalPrice: 0 };
                merged[key].count += stat.count;
                merged[key].totalPrice += stat.totalPrice;
            }
        }
        const sessionSummary = localResult?.summary
            || ((!localResult && !isLocalProcessing) ? workspace?.sessionResults?.[sessionId]?.itemSummary : undefined)
            || null;
        if (sessionSummary) {
            for (const [key, stat] of Object.entries(sessionSummary) as [string, { count: number; totalPrice: number }][]) {
                if (!merged[key]) merged[key] = { count: 0, totalPrice: 0 };
                merged[key].count += stat.count;
                merged[key].totalPrice += stat.totalPrice;
            }
        }
        return { merged, sessionSummary };
    };

    // 전체 차수 합산 (useMemo 제거 - 캐싱 문제 원천 차단)
    const { merged: combinedSummary, sessionSummary: currentSessionSummary } = _mergeSummaries();

    // 합산 정산 텍스트
    const combinedDepositText = (() => {
        if (Object.keys(combinedSummary).length === 0) return '';
        const today = new Date();
        const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
        const dateTitle = `${today.getMonth() + 1}/${today.getDate()} (${weekdays[today.getDay()]})`;
        const entries = Object.entries(combinedSummary) as [string, { count: number; totalPrice: number }][];
        const totalCount = entries.reduce((a, [, b]) => a + b.count, 0);
        let grandTotal = entries.reduce((a, [, b]) => a + b.totalPrice, 0);

        const lines: string[] = [];
        const bizShort = getBusinessInfo(businessId ?? '')?.shortName || '';
        lines.push(`${dateTitle} (${companyName})${bizShort ? ' ' + bizShort : ''} - 1~${roundNumber}차 합산`);
        lines.push(`총주문수\t${totalCount}개`);
        lines.push('');
        entries
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
            .forEach(([name, stat]) => {
                lines.push(`${name}\t${stat.count}개\t${stat.totalPrice.toLocaleString()}원`);
            });

        // 현재 차수 추가분 표시
        if (currentSessionSummary && Object.keys(currentSessionSummary).length > 0) {
            const addedItems = Object.entries(currentSessionSummary)
                .map(([key, stat]: [string, any]) => `${key} ${stat.count}개 ${stat.totalPrice.toLocaleString()}원`)
                .join(', ');
            lines.push('');
            lines.push(`(${roundNumber}차 추가 : ${addedItems})`);
        }

        lines.push('');
        lines.push(`총 합계\t\t${grandTotal.toLocaleString()}원`);
        lines.push(`(입금자 ${getBusinessInfo(businessId ?? '')?.senderName || '안군농원'})`);
        return lines.join('\n');
    })();

    // 최종 차수 정산 요약용 누적 텍스트
    const cumulativeDepositText = (() => {
        if (!isLastSession || previousRoundItems.length === 0 || Object.keys(combinedSummary).length === 0) return null;
        const today = new Date();
        const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
        const dateTitle = `${today.getMonth() + 1}/${today.getDate()} (${weekdays[today.getDay()]})`;
        const entries = Object.entries(combinedSummary) as [string, { count: number; totalPrice: number }][];
        const totalCount = entries.reduce((a, [, b]) => a + b.count, 0);
        const grandTotal = entries.reduce((a, [, b]) => a + b.totalPrice, 0);
        const lines: string[] = [];
        const bizShort2 = getBusinessInfo(businessId ?? '')?.shortName || '';
        lines.push(`${dateTitle} (${companyName})${bizShort2 ? ' ' + bizShort2 : ''}`);
        lines.push(`총주문수\t${totalCount}개`);
        lines.push('');
        entries
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
            .forEach(([name, stat]) => {
                lines.push(`${name}\t${stat.count}개\t${stat.totalPrice.toLocaleString()}원`);
            });
        lines.push('');
        lines.push(`총 합계\t\t${grandTotal.toLocaleString()}원`);
        lines.push(`(입금자 ${getBusinessInfo(businessId ?? '')?.senderName || '안군농원'})`);
        return lines.join('\n');
    })();

    const cumulativeDepositExcelText = (() => {
        if (!isLastSession || previousRoundItems.length === 0 || Object.keys(combinedSummary).length === 0) return null;
        const today = new Date();
        const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
        const dateTitle = `${today.getMonth() + 1}/${today.getDate()} (${weekdays[today.getDay()]})`;
        const entries = Object.entries(combinedSummary).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })) as [string, { count: number; totalPrice: number }][];
        const totalCount = entries.reduce((acc, [, s]) => acc + s.count, 0);
        const grandTotal = entries.reduce((acc, [, s]) => acc + s.totalPrice, 0);
        const lines: string[] = [];
        entries.forEach(([name, stat], idx) => {
            let col1 = idx === 0 ? dateTitle : idx === 1 ? `총 ${totalCount}개` : '';
            let line = `${col1}\t${name}\t${stat.count}개\t${stat.totalPrice.toLocaleString()}`;
            if (idx === entries.length - 1) line += `\t${grandTotal.toLocaleString()}`;
            lines.push(line);
        });
        return lines.join('\n');
    })();

    const [copiedCombinedId, setCopiedCombinedId] = useState<string | null>(null);
    const handleCopyCombined = () => {
        navigator.clipboard.writeText(combinedDepositText);
        setCopiedCombinedId(sessionId);
        setTimeout(() => setCopiedCombinedId(null), 2000);
    };

    const lastProcessedMasterRef = useRef<File | null>(null);
    const lastProcessedBatchRef = useRef<File | null>(null);
    const lastFakeOrdersRef = useRef<string>('');
    const lastManualOrdersRef = useRef<string>('');

    // 리셋 직후 Firestore 구독 업데이트 전까지 syncedData 억제
    const suppressSyncRef = useRef(false);
    if (suppressSyncRef.current && !workspace?.sessionResults?.[sessionId]) {
        suppressSyncRef.current = false;
    }

    // Synced data (디바이스 2 - 로컬 처리 없을 때만)
    const syncedData = (!localResult && !isLocalProcessing && !suppressSyncRef.current) ? workspace?.sessionResults?.[sessionId] : undefined;

    const { status: mergeStatus, error: mergeError, processFiles, reset: resetMerge, results: mergeResults } = useInvoiceMerger();
    const { processSingleCompanyFile } = useConsolidatedOrderConverter(pricingConfig, businessId);

    // Firestore 동기화 - 값 비교로 에코 방지
    const lastFirestoreWorkflowRef = useRef('');
    const lastFirestoreAdjRef = useRef('');

    useEffect(() => {
        if (!workspace) return;
        if (workspace.sessionWorkflows?.[sessionId]) {
            const wsStr = JSON.stringify(workspace.sessionWorkflows[sessionId]);
            if (wsStr !== lastFirestoreWorkflowRef.current) {
                setWorkflow(workspace.sessionWorkflows[sessionId]);
                lastFirestoreWorkflowRef.current = wsStr;
            }
        }
        if (workspace.sessionAdjustments?.[sessionId]) {
            const wsStr = JSON.stringify(workspace.sessionAdjustments[sessionId]);
            if (wsStr !== lastFirestoreAdjRef.current) {
                setSessionAdjustments(workspace.sessionAdjustments[sessionId]);
                lastFirestoreAdjRef.current = wsStr;
            }
        }
    }, [workspace, sessionId]);

    // workflow 변경 → Firestore에 저장
    const isInitialWorkflowLoad = useRef(true);
    useEffect(() => {
        if (isInitialWorkflowLoad.current) { isInitialWorkflowLoad.current = false; return; }
        const currentStr = JSON.stringify(workflow);
        if (currentStr === lastFirestoreWorkflowRef.current) return;
        const currentWorkflows = workspace?.sessionWorkflows || {};
        updateField('sessionWorkflows', { ...currentWorkflows, [sessionId]: workflow });
    }, [workflow, sessionId, updateField]);

    // sessionAdjustments 변경 → Firestore에 저장
    const isInitialAdjLoad = useRef(true);
    useEffect(() => {
        if (isInitialAdjLoad.current) { isInitialAdjLoad.current = false; return; }
        const currentStr = JSON.stringify(sessionAdjustments);
        if (currentStr === lastFirestoreAdjRef.current) return;
        const currentAdjs = workspace?.sessionAdjustments || {};
        updateField('sessionAdjustments', { ...currentAdjs, [sessionId]: sessionAdjustments });
    }, [sessionAdjustments, sessionId, updateField]);

    useEffect(() => {
        const manualOrdersStr = JSON.stringify(manualOrders);
        const hasFileChanged = isFirstSession && masterFile && isDetected && masterFile !== lastProcessedMasterRef.current;
        const hasBatchFileChanged = batchFile && batchFile !== lastProcessedBatchRef.current;
        const hasFakeOrdersChanged = fakeOrderNumbers !== lastFakeOrdersRef.current;
        const hasManualOrdersChanged = isFirstSession && manualOrdersStr !== lastManualOrdersRef.current;

        if (hasBatchFileChanged && batchFile) {
            // N차 일괄 업로드: 가구매 제외 포함하여 처리
            lastProcessedBatchRef.current = batchFile;
            lastFakeOrdersRef.current = fakeOrderNumbers;
            handleLocalFileChange(batchFile, false);
        } else if (hasFileChanged) {
            if (masterFile) {
                // isProcessingRef 가드에 의해 스킵될 수 있으므로, ref는 실제 처리 시작 후 업데이트
                if (!isProcessingRef.current) {
                    lastProcessedMasterRef.current = masterFile;
                    lastFakeOrdersRef.current = fakeOrderNumbers;
                    lastManualOrdersRef.current = manualOrdersStr;
                }
                handleLocalFileChange(masterFile, true);
            }
        } else if (hasFakeOrdersChanged && (lastProcessedMasterRef.current || lastProcessedBatchRef.current)) {
            // 가구매 변경: 이미 파일 처리가 된 이후에만 재처리 (1차/N차 모두)
            lastFakeOrdersRef.current = fakeOrderNumbers;
            lastManualOrdersRef.current = manualOrdersStr;
            const fileToReprocess = lastProcessedMasterRef.current || lastProcessedBatchRef.current;
            handleLocalFileChange(fileToReprocess, false);
        } else if (hasManualOrdersChanged) {
            // 수동주문 변경: 파일 유무와 관계없이 처리
            lastFakeOrdersRef.current = fakeOrderNumbers;
            if (lastProcessedMasterRef.current) {
                handleLocalFileChange(lastProcessedMasterRef.current, false);
            } else if (manualOrders.length > 0) {
                // 마스터 파일 없이 수동발주만 있는 경우 - 팝업 표시 후 발주서 생성
                handleLocalFileChange(null, true);
            } else {
                lastManualOrdersRef.current = manualOrdersStr;
            }
        } else {
            // Firestore 초기 로드 등 - ref만 업데이트 (재처리 안함)
            lastFakeOrdersRef.current = fakeOrderNumbers;
            lastManualOrdersRef.current = manualOrdersStr;
        }
    }, [masterFile, batchFile, isDetected, isFirstSession, isLastSession, fakeOrderNumbers, manualOrders, isLocalProcessing]);

    useEffect(() => {
        if (!localResult) {
            // 모든 주문이 가구매(제외)인 경우: localResult는 null이지만 excludedList는 있음
            if (excludedList.length > 0) {
                onResultUpdate(sessionId, 0, excludedList.length, excludedList);
            }
            return;
        }
        const orderTotal = Object.values(localResult.summary).reduce((a: number, b: any) => a + (b.totalPrice || 0), 0);
        const adjTotal = sessionAdjustments.reduce((a, b) => a + b.amount, 0);
        onResultUpdate(sessionId, orderTotal + adjTotal, excludedList.length, excludedList);
        onDataUpdate(sessionId, localResult.rows || [], mergeResults?.rows || [], mergeResults?.uploadRows || [], localResult.depositSummaryExcel || '', mergeResults?.header, localResult.registeredProductNames, localResult.summary, localResult.orderItems);
    }, [localResult, mergeResults, excludedList, sessionId, onResultUpdate, onDataUpdate, sessionAdjustments]);

    // Firestore에 처리 결과 저장 (크로스 디바이스 동기화)
    const saveResultDebounceRef = useRef<ReturnType<typeof setTimeout>>();
    const lastSavedResultRef = useRef('');
    useEffect(() => {
        if (!localResult) return;
        if (saveResultDebounceRef.current) clearTimeout(saveResultDebounceRef.current);
        saveResultDebounceRef.current = setTimeout(() => {
            const orderTotal = Object.values(localResult.summary).reduce((a: number, b: any) => a + (b.totalPrice || 0), 0);
            const adjTotal = sessionAdjustments.reduce((a, b) => a + b.amount, 0);
            const resultData: SessionResultData = {
                orderRows: JSON.stringify(localResult.rows || []) as any,
                invoiceRows: JSON.stringify(mergeResults?.rows || []) as any,
                uploadInvoiceRows: JSON.stringify(mergeResults?.uploadRows || []) as any,
                header: mergeResults?.header || [],
                summaryExcel: localResult.depositSummaryExcel || '',
                depositSummary: localResult.depositSummary || '',
                depositSummaryExcel: localResult.depositSummaryExcel || '',
                totalPrice: orderTotal + adjTotal,
                excludedCount: excludedList.length,
                excludedDetails: excludedList,
                orderCount: (Object.values(localResult.summary) as any[]).reduce((a: number, b: any) => a + (b.count || 0), 0),
                itemSummary: localResult.summary as any,
                registeredProductNames: localResult.registeredProductNames || {},
                orderItems: localResult.orderItems || [],
                unmatchedOrders: unmatchedList.length > 0 ? unmatchedList : [],
            };
            const resultStr = JSON.stringify(resultData);
            if (resultStr === lastSavedResultRef.current) return;
            lastSavedResultRef.current = resultStr;
            const currentResults = workspace?.sessionResults || {};
            updateField('sessionResults', { ...currentResults, [sessionId]: resultData });
        }, 500);
        return () => { if (saveResultDebounceRef.current) clearTimeout(saveResultDebounceRef.current); };
    }, [localResult, mergeResults, excludedList, unmatchedList, sessionAdjustments, sessionId]);

    // Synced data → parent 콜백 (디바이스 2: Firestore에서 로드)
    const lastSyncedCallbackRef = useRef('');
    useEffect(() => {
        if (localResult) { lastSyncedCallbackRef.current = ''; return; }
        if (!syncedData) return;
        const key = `${syncedData.totalPrice}-${syncedData.orderCount}-${syncedData.excludedCount}`;
        if (key === lastSyncedCallbackRef.current) return;
        lastSyncedCallbackRef.current = key;
        onResultUpdate(sessionId, syncedData.totalPrice, syncedData.excludedCount, syncedData.excludedDetails);
        const parseRows = (v: any) => typeof v === 'string' ? JSON.parse(v) : (v || []);
        onDataUpdate(sessionId, parseRows(syncedData.orderRows), parseRows(syncedData.invoiceRows), parseRows(syncedData.uploadInvoiceRows), syncedData.summaryExcel, syncedData.header?.length > 0 ? syncedData.header : undefined, syncedData.registeredProductNames, syncedData.itemSummary, syncedData.orderItems);
        if (syncedData.unmatchedOrders) setUnmatchedList(syncedData.unmatchedOrders);
    }, [workspace, localResult, sessionId]);

    useEffect(() => {
        const activeFile = localFile || (isFirstSession ? masterFile : null);
        if (vendorFile && activeFile && mergeStatus === 'idle') {
            handleRunMerge();
        }
    }, [vendorFile, localFile, masterFile, mergeStatus, isFirstSession]);

    const handleCopy = (id: string, baseText: string, type: 'kakao' | 'excel' = 'kakao') => {
        let finalText = baseText;
        if (sessionAdjustments.length > 0) {
            if (type === 'kakao') {
                const adjText = sessionAdjustments.map(a => `${a.label}\t${a.amount.toLocaleString()}원`).join('\n');
                const orderTotal = localResult ? Object.values(localResult.summary).reduce((a: number, b: any) => a + (b.totalPrice || 0), 0) : 0;
                const adjTotal = sessionAdjustments.reduce((a, b) => a + b.amount, 0);
                finalText = baseText.replace('총 합계', `[추가/차감 내역]\n${adjText}\n\n총 합계`)
                                  .replace(/(총 합계\s+)([\d,]+)(원)/, (match, p1, p2, p3) => {
                                      return `${p1}${(orderTotal + adjTotal).toLocaleString()}${p3}`;
                                  });
            } else {
                // 엑셀용은 기본 텍스트 유지 (필요시 확장 가능)
            }
        }
        
        navigator.clipboard.writeText(finalText);
        if (type === 'kakao') { setCopiedId(id); setTimeout(() => setCopiedId(null), 2000); }
        else { setCopiedExcelId(id); setTimeout(() => setCopiedExcelId(null), 2000); }
    };

    const isProcessingRef = useRef(false);
    const handleLocalFileChange = async (file: File | null, confirmManualOrders = false, overrideFakeOrders?: string) => {
        if (isProcessingRef.current) return;
        isProcessingRef.current = true;
        // 처리 시작 시점에 수동주문 ref 갱신 (race condition 방지)
        lastManualOrdersRef.current = JSON.stringify(manualOrders);
        if (file && file !== masterFile) setLocalFile(file);
        setIsLocalProcessing(true);
        let ordersToInclude = manualOrders;
        if (manualOrders.length > 0) {
            if (confirmManualOrders) {
                // 명시적 트리거 (파일 업로드) - 항상 확인 다이얼로그 표시
                const orderList = manualOrders.map(o => `  • ${o.recipientName} - ${o.productName} x${o.qty}`).join('\n');
                if (!confirm(`[${companyName}] 수동발주 ${manualOrders.length}건을 발주서에 포함할까요?\n\n${orderList}`)) {
                    ordersToInclude = [];
                    onManualOrdersApproval?.(companyName, false);
                } else {
                    onManualOrdersApproval?.(companyName, true);
                }
            } else if (manualOrdersRejected) {
                // 자동 트리거 - 이전에 취소한 경우 수동발주 제외
                ordersToInclude = [];
            }
        }
        try {
            const effectiveFakeOrders = overrideFakeOrders !== undefined ? overrideFakeOrders : fakeOrderNumbers;
            const processResponse = await processSingleCompanyFile(file, companyName, effectiveFakeOrders, ordersToInclude);
            if (processResponse) {
                setLocalResult(processResponse.result);
                setExcludedList(processResponse.excluded);
                setUnmatchedList(processResponse.unmatched || []);
            } else {
                setLocalResult(null);
                setUnmatchedList([]);
            }
        } catch (error) {
            console.error(`[${companyName}] 처리 오류:`, error);
            setLocalResult(null);
        }
        setIsLocalProcessing(false);
        isProcessingRef.current = false;
        resetMerge();
    };

    const handleRunMerge = () => {
        const activeFile = localFile || (isFirstSession ? masterFile : null);
        if (activeFile && vendorFile) {
            processFiles(vendorFile, activeFile, companyName, false, pricingConfig, orderPlatformMap, platformConfigs, businessId);
        }
    };

    const resetLocalFile = () => {
        setLocalFile(null);
        setLocalResult(null);
        setExcludedList([]);
        setUnmatchedList([]);
        resetMerge();
        onResultUpdate(sessionId, 0, 0, []);
        onDataUpdate(sessionId, [], [], [], '', undefined, undefined, undefined);
        // Firestore 구독 업데이트 전까지 syncedData 억제
        suppressSyncRef.current = true;
        // Firestore 세션 결과도 함께 제거
        const currentResults = { ...(workspace?.sessionResults || {}) };
        if (currentResults[sessionId]) {
            delete currentResults[sessionId];
            updateField('sessionResults', currentResults);
        }
    };

    const resetSyncedData = () => {
        const currentResults = { ...(workspace?.sessionResults || {}) };
        delete currentResults[sessionId];
        updateField('sessionResults', currentResults);
        setUnmatchedList([]);
        onResultUpdate(sessionId, 0, 0, []);
        onDataUpdate(sessionId, [], [], [], '', undefined, undefined, undefined);
    };

    const handleDownloadOrder = () => localResult && XLSX.writeFile(localResult.workbook, localResult.fileName);
    const handleDownloadInvoice = (type: 'mgmt' | 'upload') => {
        if (!mergeResults) return;
        if (fakeCourierRows && fakeCourierRows.length > 0) {
            const rows = type === 'mgmt' ? [...(mergeResults.rows || [])] : [...(mergeResults.uploadRows || [])];
            rows.push(...fakeCourierRows);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([mergeResults.header, ...rows]), type === 'mgmt' ? '기록용' : '업로드용');
            XLSX.writeFile(wb, type === 'mgmt' ? mergeResults.mgmtFileName : mergeResults.uploadFileName);
        } else {
            if (type === 'mgmt') XLSX.writeFile(mergeResults.mgmtWorkbook, mergeResults.mgmtFileName);
            else XLSX.writeFile(mergeResults.uploadWorkbook, mergeResults.uploadFileName);
        }
    };
    const handleDownloadPlatformInvoice = (platformName: string) => {
        const pResult = mergeResults?.platformUploadWorkbooks?.[platformName];
        if (pResult) XLSX.writeFile(pResult.workbook, pResult.fileName);
    };

    const handleAddAdj = () => {
        const amount = parseInt(adjAmount);
        if (isNaN(amount)) return;
        const newAdj: SessionAdjustment = {
            id: `adj-${Date.now()}`,
            amount,
            label: adjLabel || (amount < 0 ? '반품/차감' : '수동 추가')
        };
        setSessionAdjustments(prev => [...prev, newAdj]);
        setAdjAmount('');
        setAdjLabel('');
    };

    const removeAdj = (id: string) => {
        setSessionAdjustments(prev => prev.filter(a => a.id !== id));
    };

    const toggleStep = (step: keyof WorkflowStatus) => {
        setWorkflow(prev => ({ ...prev, [step]: !prev[step] }));
    };

    const handleAddKeyword = () => {
        const kw = newKeywordRef.current.trim();
        newKeywordRef.current = '';
        setNewKeyword('');
        setIsAddingKeyword(false);
        if (!kw) return;
        const cfg = pricingConfigRef.current;
        if (!cfg[companyName]) return;
        const newConfig = JSON.parse(JSON.stringify(cfg));
        if (!newConfig[companyName].keywords) newConfig[companyName].keywords = [];
        if (!newConfig[companyName].keywords.includes(kw)) {
            newConfig[companyName].keywords.push(kw);
            onConfigChange(newConfig);
        }
    };

    const handleDeleteKeyword = (kw: string) => {
        const cfg = pricingConfigRef.current;
        if (!cfg[companyName]) return;
        const newConfig = JSON.parse(JSON.stringify(cfg));
        const current = newConfig[companyName].keywords || [];
        newConfig[companyName].keywords = current.filter((k: string) => k !== kw);
        onConfigChange(newConfig);
    };

    const currentStat = mergeResults?.companyStats?.[companyName];
    const keywords = getKeywordsForCompany(companyName, pricingConfig);
    const deadline = pricingConfig[companyName]?.deadline;
    const isAllDone = workflow.order && workflow.deposit && workflow.invoice;

    return (
        <>
            <tr className={`transition-all duration-300 border-none ${isAllDone ? 'bg-emerald-950/20' : (workflow.order || workflow.deposit || workflow.invoice) ? 'bg-zinc-900/40' : 'bg-transparent hover:bg-zinc-800/10'}`}>
                <td className={`px-6 min-w-[360px] ${isFirstSession ? 'py-2' : 'py-1'}`}>
                    <div className="flex flex-col gap-2">
                        {isFirstSession ? (
                            <>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <div
                                        className={`font-black text-xl tracking-tighter whitespace-nowrap transition-colors cursor-grab active:cursor-grabbing select-none ${isAllDone ? 'text-emerald-400' : 'text-white'}`}
                                        {...dragHandle.attributes}
                                        {...dragHandle.listeners}
                                    >
                                        {companyName}
                                    </div>
                                    
                                    <div className="flex items-center bg-zinc-950 p-0.5 rounded-lg border border-zinc-800 gap-0.5">
                                        {(['order', 'deposit', 'invoice'] as const).map((step) => (
                                            <button 
                                                key={step}
                                                onClick={() => toggleStep(step)}
                                                className={`px-1.5 py-0.5 rounded text-[9px] font-black transition-all ${
                                                    workflow[step] 
                                                        ? (step === 'order' ? 'bg-rose-500' : step === 'deposit' ? 'bg-emerald-500' : 'bg-indigo-500') + ' text-white shadow-md' 
                                                        : 'text-zinc-600 hover:text-zinc-400'
                                                }`}
                                            >
                                                {step === 'order' ? '발주' : step === 'deposit' ? '입금' : '송장'}
                                            </button>
                                        ))}
                                    </div>

                                    {deadline && (
                                        <div className="bg-rose-500/10 text-rose-500 px-2 py-0.5 rounded-lg border border-rose-500/30 flex items-center gap-1 shrink-0">
                                            <span className="text-[9px] font-black uppercase opacity-70 tracking-tight">마감</span>
                                            <span className="text-[11px] font-black">{deadline}</span>
                                        </div>
                                    )}
                                </div>

                                <div className="flex flex-col gap-1.5">
                                    <div className="flex items-center gap-2">
                                        <div className="flex items-center gap-1.5 bg-zinc-950/50 px-2 py-1 rounded-lg border border-zinc-800 shrink-0">
                                            <input 
                                                type="text" 
                                                placeholder="사유(반품 등)" 
                                                value={adjLabel}
                                                onChange={e => setAdjLabel(e.target.value)}
                                                className="w-20 bg-transparent border-none text-[10px] font-bold text-zinc-400 placeholder:text-zinc-700 focus:ring-0 p-0"
                                            />
                                            <input 
                                                type="number" 
                                                placeholder="금액(- 가능)" 
                                                value={adjAmount} 
                                                onChange={e => setAdjAmount(e.target.value)} 
                                                onKeyDown={e => e.key === 'Enter' && handleAddAdj()} 
                                                className="w-20 bg-transparent border-none text-[10px] font-black text-rose-500 placeholder:text-zinc-700 focus:ring-0 p-0 text-right" 
                                            />
                                            <button onClick={handleAddAdj} className="text-rose-500 hover:text-white hover:bg-rose-500 rounded p-0.5 transition-all">
                                                <PlusCircleIcon className="w-3 h-3" />
                                            </button>
                                        </div>
                                        <button onClick={onAddSession} className="p-1 bg-zinc-800 text-zinc-500 rounded-lg hover:bg-rose-500 hover:text-white transition-all border border-zinc-700">
                                            <PlusCircleIcon className="w-4 h-4" />
                                        </button>
                                    </div>
                                    
                                    {sessionAdjustments.length > 0 && (
                                        <div className="flex flex-wrap gap-1">
                                            {sessionAdjustments.map(adj => (
                                                <div key={adj.id} className="bg-zinc-900/50 px-2 py-0.5 rounded border border-zinc-800 flex items-center gap-1.5 group animate-pop-in">
                                                    <span className="text-[9px] font-bold text-zinc-500">{adj.label}</span>
                                                    <span className={`text-[9px] font-black ${adj.amount < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>{adj.amount.toLocaleString()}원</span>
                                                    <button onClick={() => removeAdj(adj.id)} className="text-zinc-700 hover:text-rose-500"><TrashIcon className="w-2.5 h-2.5" /></button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <div className="flex flex-wrap gap-1 items-center">
                                    {keywords.map(kw => (
                                        <span key={kw} className="text-[9px] bg-zinc-900/80 text-zinc-500 px-1.5 py-0.5 rounded border border-zinc-800 font-bold tracking-tight group/kw flex items-center gap-1">
                                            {kw}
                                            <button onClick={() => handleDeleteKeyword(kw)} className="text-zinc-700 hover:text-rose-500 hidden group-hover/kw:inline transition-colors"><TrashIcon className="w-2.5 h-2.5" /></button>
                                        </span>
                                    ))}
                                    {isAddingKeyword ? (
                                        <input
                                            autoFocus
                                            type="text"
                                            value={newKeyword}
                                            onChange={e => { setNewKeyword(e.target.value); newKeywordRef.current = e.target.value; }}
                                            onKeyDown={e => { if (e.key === 'Enter') handleAddKeyword(); if (e.key === 'Escape') { newKeywordRef.current = ''; setIsAddingKeyword(false); setNewKeyword(''); } }}
                                            onBlur={() => handleAddKeyword()}
                                            placeholder="키워드 입력"
                                            className="text-[9px] bg-zinc-950 text-zinc-300 px-1.5 py-0.5 rounded border border-zinc-700 font-bold w-20 outline-none focus:border-rose-500/50"
                                        />
                                    ) : (
                                        <button onClick={() => setIsAddingKeyword(true)} className="text-[9px] bg-zinc-900/50 text-zinc-600 hover:text-rose-400 px-1.5 py-0.5 rounded border border-dashed border-zinc-800 hover:border-rose-500/30 font-bold transition-colors">+</button>
                                    )}
                                </div>
                            </>
                        ) : (
                            <div className="pl-4 border-l-2 border-zinc-800 py-1">
                                <div className="flex items-center gap-2">
                                    <span className="text-zinc-700 text-[12px] font-black">ㄴ</span>
                                    <div className="bg-indigo-500/10 text-indigo-400 px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border border-indigo-500/20 whitespace-nowrap">
                                        {roundNumber}차 추가 발주
                                    </div>
                                    {previousRoundItems.length > 0 && (
                                        <button
                                            onClick={() => setShowPrevRoundItems(!showPrevRoundItems)}
                                            className="text-zinc-600 hover:text-indigo-400 text-[9px] font-black flex items-center gap-0.5 transition-colors"
                                        >
                                            {showPrevRoundItems ? <ChevronUpIcon className="w-3 h-3" /> : <ChevronDownIcon className="w-3 h-3" />}
                                            합산 / 추가 내역
                                        </button>
                                    )}
                                    <button onClick={onRemoveSession} className="text-zinc-800 hover:text-red-500 transition-colors p-1">
                                        <TrashIcon className="w-4 h-4" />
                                    </button>
                                </div>
                                {showPrevRoundItems && previousRoundItems.length > 0 && combinedDepositText && (
                                    <div className="mt-1.5 animate-fade-in">
                                        <div className="bg-zinc-950/50 px-2.5 py-1.5 rounded-lg border border-emerald-500/20 relative">
                                            <div className="flex justify-between items-center mb-1">
                                                <div className="text-emerald-400 text-[9px] font-black">1~{roundNumber}차 합산 정산</div>
                                                <button onClick={handleCopyCombined} className={`text-[9px] font-black px-2 py-0.5 rounded border transition-all ${copiedCombinedId ? 'bg-emerald-500 text-white border-emerald-400' : 'bg-zinc-800 text-rose-400 border-zinc-700 hover:text-white'}`}>{copiedCombinedId ? '복사됨!' : '카톡용'}</button>
                                            </div>
                                            <pre className="text-[10px] font-mono text-zinc-300 whitespace-pre-wrap leading-tight">{combinedDepositText}</pre>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </td>

                <td className={`px-6 text-center ${isFirstSession ? 'py-2' : 'py-1'}`}>
                    <div className={`flex flex-col items-center ${isFirstSession ? 'gap-2' : 'gap-1'}`}>
                        {localResult ? (
                            <div className="flex flex-col items-center gap-2 animate-fade-in w-full">
                                <div className="flex items-center justify-center gap-4">
                                    <div className="text-center">
                                        <div className={`font-black ${isFirstSession ? 'text-rose-500 text-xl' : 'text-indigo-400 text-base'}`}>{isFirstSession ? '' : '+'}{Object.values(localResult.summary).reduce((a:any, b:any) => a + b.count, 0)}</div>
                                        <div className="text-zinc-600 font-black text-[9px] uppercase tracking-widest">Orders</div>
                                    </div>
                                    <div className="h-6 w-px bg-zinc-800" />
                                    <button onClick={handleDownloadOrder} className={`${isFirstSession ? 'bg-rose-500 text-white hover:bg-rose-600' : 'bg-indigo-500 text-white hover:bg-indigo-600'} px-3 py-1 rounded font-black text-[10px] shadow-md flex items-center gap-1.5 transition-all`}><ArrowDownTrayIcon className="w-3.5 h-3.5" /><span>받기</span></button>
                                    {onDownloadMergedOrder && isFirstSession && (
                                        <button onClick={onDownloadMergedOrder} className="bg-zinc-800 text-white border border-zinc-700 px-3 py-1 rounded font-black text-[10px] hover:bg-zinc-700 shadow-md flex items-center gap-1.5 transition-all"><ArrowDownTrayIcon className="w-3.5 h-3.5" /><span>합산</span></button>
                                    )}
                                </div>
                                {unmatchedList.length > 0 && (
                                    <div className="bg-amber-500/10 border border-amber-500/40 rounded-lg px-3 py-1.5 w-full animate-fade-in">
                                        <div className="text-amber-400 text-[10px] font-black flex items-center gap-1">
                                            <span>⚠</span> 매칭 실패 {unmatchedList.length}건 누락
                                        </div>
                                        <div className="mt-1 space-y-0.5">
                                            {unmatchedList.map((u, idx) => (
                                                <div key={idx} className="text-[9px] text-amber-300/80 font-mono truncate">
                                                    {u.recipientName} - {u.productName}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {(() => {
                                    const processedCount = Object.values(localResult.summary).reduce((a:any, b:any) => a + b.count, 0) as number;
                                    const excludedQtyTotal = excludedList.reduce((sum: number, e: any) => sum + (e.qty || 1), 0);
                                    const unmatchedQtyTotal = unmatchedList.reduce((sum: number, u: any) => sum + (u.qty || 1), 0);
                                    const workstationTotal = processedCount + excludedQtyTotal + unmatchedQtyTotal;
                                    if (masterExpectedCount > 0 && masterExpectedCount > workstationTotal) {
                                        const diff = masterExpectedCount - workstationTotal;
                                        return (
                                            <div className="bg-red-500/10 border border-red-500/40 rounded-lg px-3 py-1.5 w-full animate-fade-in">
                                                <div className="text-red-400 text-[10px] font-black flex items-center gap-1">
                                                    <span>⚠</span> 마스터 {masterExpectedCount}건 중 {diff}건 누락
                                                </div>
                                                <div className="text-[9px] text-red-300/70 mt-0.5">
                                                    키워드 매칭을 확인하세요 (처리: {workstationTotal}건)
                                                </div>
                                            </div>
                                        );
                                    }
                                    return null;
                                })()}
                                {missingItems.length > 0 && (
                                    <div className="bg-orange-500/10 border border-orange-500/40 rounded-lg px-3 py-1.5 w-full animate-fade-in">
                                        <div className="text-orange-400 text-[10px] font-black flex items-center gap-1">
                                            <span>⚠</span> 누락 항목 {missingItems.reduce((s, m) => s + m.diffQty, 0)}건
                                        </div>
                                        <div className="mt-1 space-y-0.5">
                                            {missingItems.map((m, idx) => (
                                                <div key={idx} className="text-[9px] text-orange-300/80 font-mono truncate">
                                                    {m.groupName}: {m.diffQty}건 부족
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                <div className="flex items-center gap-2">
                                    <button onClick={() => setShowSummary(!showSummary)} className="text-zinc-600 hover:text-rose-400 text-[9px] font-black uppercase flex items-center gap-1 whitespace-nowrap">{showSummary ? <ChevronUpIcon className="w-3 h-3"/> : <ChevronDownIcon className="w-3 h-3"/>}정산</button>
                                    {excludedList.length > 0 && (
                                        <button onClick={() => setShowExcluded(!showExcluded)} className="text-rose-500 hover:text-rose-400 text-[9px] font-black uppercase flex items-center gap-1 whitespace-nowrap">
                                            제외({excludedList.length})
                                        </button>
                                    )}
                                    <button onClick={resetLocalFile} className="p-1 bg-zinc-900 rounded text-zinc-700 hover:text-rose-500 border border-zinc-800 transition-colors"><ArrowPathIcon className="w-3 h-3" /></button>
                                </div>
                            </div>
                        ) : isLocalProcessing ? (
                            <div className="flex flex-col items-center gap-1 text-indigo-400 font-black animate-pulse"><div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" /><span className="text-[9px] uppercase tracking-widest">Analysing...</span></div>
                        ) : syncedData ? (
                            <div className="flex flex-col items-center gap-2 animate-fade-in w-full">
                                <div className="flex items-center justify-center gap-4">
                                    <div className="text-center">
                                        <div className={`font-black ${isFirstSession ? 'text-rose-500 text-xl' : 'text-indigo-400 text-base'}`}>{isFirstSession ? '' : '+'}{syncedData.orderCount}</div>
                                        <div className="text-zinc-600 font-black text-[9px] uppercase tracking-widest">Orders</div>
                                    </div>
                                    <div className="h-6 w-px bg-zinc-800" />
                                    <span className="text-zinc-600 text-[9px] font-black">(복원됨)</span>
                                </div>
                                {unmatchedList.length > 0 && (
                                    <div className="bg-amber-500/10 border border-amber-500/40 rounded-lg px-3 py-1.5 w-full animate-fade-in">
                                        <div className="text-amber-400 text-[10px] font-black flex items-center gap-1">
                                            <span>⚠</span> 매칭 실패 {unmatchedList.length}건 누락
                                        </div>
                                    </div>
                                )}
                                {(() => {
                                    const syncedProcessed = syncedData.itemSummary
                                        ? Object.values(syncedData.itemSummary).reduce((a: number, b: any) => a + (b.count || 0), 0)
                                        : syncedData.orderCount || 0;
                                    const excludedQtyTotal = (syncedData.excludedDetails || excludedList).reduce((sum: number, e: any) => sum + (e.qty || 1), 0);
                                    const unmatchedQtyTotal = unmatchedList.reduce((sum: number, u: any) => sum + (u.qty || 1), 0);
                                    const workstationTotal = syncedProcessed + excludedQtyTotal + unmatchedQtyTotal;
                                    if (masterExpectedCount > 0 && masterExpectedCount > workstationTotal) {
                                        const diff = masterExpectedCount - workstationTotal;
                                        return (
                                            <div className="bg-red-500/10 border border-red-500/40 rounded-lg px-3 py-1.5 w-full animate-fade-in">
                                                <div className="text-red-400 text-[10px] font-black flex items-center gap-1">
                                                    <span>⚠</span> 마스터 {masterExpectedCount}건 중 {diff}건 누락
                                                </div>
                                                <div className="text-[9px] text-red-300/70 mt-0.5">
                                                    키워드 매칭을 확인하세요 (처리: {workstationTotal}건)
                                                </div>
                                            </div>
                                        );
                                    }
                                    return null;
                                })()}
                                {missingItems.length > 0 && (
                                    <div className="bg-orange-500/10 border border-orange-500/40 rounded-lg px-3 py-1.5 w-full animate-fade-in">
                                        <div className="text-orange-400 text-[10px] font-black flex items-center gap-1">
                                            <span>⚠</span> 누락 항목 {missingItems.reduce((s, m) => s + m.diffQty, 0)}건
                                        </div>
                                        <div className="mt-1 space-y-0.5">
                                            {missingItems.map((m, idx) => (
                                                <div key={idx} className="text-[9px] text-orange-300/80 font-mono truncate">
                                                    {m.groupName}: {m.diffQty}건 부족
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                <div className="flex items-center gap-2">
                                    <button onClick={() => setShowSummary(!showSummary)} className="text-zinc-600 hover:text-rose-400 text-[9px] font-black uppercase flex items-center gap-1 whitespace-nowrap">{showSummary ? <ChevronUpIcon className="w-3 h-3"/> : <ChevronDownIcon className="w-3 h-3"/>}정산</button>
                                    {(syncedData.excludedDetails?.length || 0) > 0 && (
                                        <button onClick={() => setShowExcluded(!showExcluded)} className="text-rose-500 hover:text-rose-400 text-[9px] font-black uppercase flex items-center gap-1 whitespace-nowrap">
                                            제외({syncedData.excludedDetails.length})
                                        </button>
                                    )}
                                    <button onClick={resetSyncedData} className="p-1 bg-zinc-900 rounded text-zinc-700 hover:text-rose-500 border border-zinc-800 transition-colors"><ArrowPathIcon className="w-3 h-3" /></button>
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center gap-2">
                                {excludedList.length > 0 ? (
                                    <div className="flex flex-col items-center gap-2 animate-fade-in w-full">
                                        <div className="text-zinc-500 font-black text-[10px]">{(() => {
                                            const fakeCount = excludedList.filter((e: any) => String(e.orderNumber || '').includes('(제외)')).length;
                                            const parts: string[] = [];
                                            if (fakeCount > 0) parts.push(`가구매 제외 ${fakeCount}건`);
                                            if (parts.length === 0) parts.push(`제외 ${excludedList.length}건`);
                                            return `모두 ${parts.join(' / ')}`;
                                        })()}</div>
                                        <div className="flex items-center gap-2">
                                            <button onClick={() => setShowExcluded(!showExcluded)} className="text-rose-500 hover:text-rose-400 text-[9px] font-black uppercase flex items-center gap-1 whitespace-nowrap">
                                                제외({excludedList.length})
                                            </button>
                                            <button onClick={resetLocalFile} className="p-1 bg-zinc-900 rounded text-zinc-700 hover:text-rose-500 border border-zinc-800 transition-colors"><ArrowPathIcon className="w-3 h-3" /></button>
                                        </div>
                                    </div>
                                ) : (
                                    <label className="flex items-center gap-2 cursor-pointer px-4 py-1.5 rounded-lg text-[10px] font-black border border-zinc-800 bg-zinc-900/30 text-zinc-500 hover:border-indigo-500/40 hover:text-indigo-400 transition-all shadow-inner whitespace-nowrap">
                                        <DocumentArrowUpIcon className="w-4 h-4 text-zinc-700" />
                                        <span>발주서 업로드</span>
                                        <input type="file" className="sr-only" accept=".xlsx,.xls" onChange={(e) => e.target.files?.[0] && handleLocalFileChange(e.target.files[0], true)} />
                                    </label>
                                )}
                                {(() => {
                                    const exQty = excludedList.reduce((sum: number, e: any) => sum + (e.qty || 1), 0);
                                    const unQty = unmatchedList.reduce((sum: number, u: any) => sum + (u.qty || 1), 0);
                                    const totalProcessed = exQty + unQty;
                                    if (masterExpectedCount > 0 && masterExpectedCount > totalProcessed) {
                                        return (
                                            <div className="bg-red-500/10 border border-red-500/40 rounded-lg px-3 py-1.5 w-full animate-fade-in">
                                                <div className="text-red-400 text-[10px] font-black flex items-center gap-1">
                                                    <span>⚠</span> 마스터 {masterExpectedCount}건 중 {masterExpectedCount - totalProcessed}건 누락
                                                </div>
                                                <div className="text-[9px] text-red-300/70 mt-0.5">
                                                    키워드 매칭을 확인하세요 (처리: {totalProcessed}건)
                                                </div>
                                            </div>
                                        );
                                    }
                                    return null;
                                })()}
                                {missingItems.length > 0 && (
                                    <div className="bg-orange-500/10 border border-orange-500/40 rounded-lg px-3 py-1.5 w-full animate-fade-in">
                                        <div className="text-orange-400 text-[10px] font-black flex items-center gap-1">
                                            <span>⚠</span> 누락 항목 {missingItems.reduce((s, m) => s + m.diffQty, 0)}건
                                        </div>
                                        <div className="mt-1 space-y-0.5">
                                            {missingItems.map((m, idx) => (
                                                <div key={idx} className="text-[9px] text-orange-300/80 font-mono truncate">
                                                    {m.groupName}: {m.diffQty}건 부족
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </td>

                <td className={`px-6 ${isFirstSession ? 'py-2' : 'py-1'}`}>
                    <div className={`flex flex-col items-center ${isFirstSession ? 'gap-2' : 'gap-1'}`}>
                        {!mergeResults ? (
                            <div className="flex flex-col items-center gap-2">
                                <label className={`flex items-center gap-2 cursor-pointer px-4 py-1.5 rounded-lg text-[10px] font-black border transition-all shadow-md whitespace-nowrap ${mergeStatus === 'error' ? 'bg-rose-950/20 border-rose-500/30 text-rose-400' : vendorFile ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-400' : 'bg-zinc-800/40 border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300'}`}>
                                    <UploadIcon className="w-4 h-4" />
                                    <span>{mergeStatus === 'processing' ? '매칭 중...' : mergeStatus === 'error' ? '송장 오류' : vendorFile ? '송장 업로드됨' : '송장 선택'}</span>
                                    <input type="file" className="sr-only" accept=".xlsx,.xls" onChange={(e) => { const file = e.target.files?.[0]; if (file) { resetMerge(); onVendorFileChange(file); } }} />
                                </label>
                                {mergeStatus === 'error' && mergeError && (
                                    <div className="text-rose-400 text-[9px] font-bold text-center max-w-[200px] leading-tight">{mergeError}</div>
                                )}
                                {vendorFile && mergeStatus === 'idle' && !(localFile || (isFirstSession ? masterFile : null)) && (
                                    <div className="text-amber-400 text-[9px] font-bold text-center max-w-[200px] leading-tight">발주서를 먼저 업로드해주세요</div>
                                )}
                            </div>
                        ) : (
                            <div className="flex flex-col items-center gap-2 animate-fade-in w-full">
                                <div className="flex items-center justify-center gap-3">
                                    <div className="flex flex-col items-center gap-1">
                                        <div className="text-emerald-400 font-black text-[9px] uppercase tracking-widest">{currentStat?.mgmt || 0}건</div>
                                        <button onClick={() => handleDownloadInvoice('mgmt')} className="bg-emerald-600 text-white px-2 py-1 rounded font-black text-[9px] hover:bg-emerald-700 shadow-md">기록용</button>
                                    </div>
                                    <div className="flex flex-col items-center gap-1 relative">
                                        <div className="text-rose-400 font-black text-[9px] uppercase tracking-widest">{currentStat?.upload || 0}건</div>
                                        <div className="flex items-center gap-1.5">
                                            <button onClick={() => handleDownloadInvoice('upload')} className="bg-rose-500 text-white px-2 py-1 rounded font-black text-[9px] hover:bg-rose-600 shadow-md">업로드용</button>
                                            <button 
                                                onClick={() => onSelectToggle?.(sessionId)}
                                                className={`w-6 h-6 rounded border flex items-center justify-center transition-all ${isSelected ? 'bg-rose-500 border-rose-400 text-white shadow-md' : 'bg-zinc-900 border-zinc-700 text-transparent hover:border-rose-500/50'}`}
                                            >
                                                <CheckIcon className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                    <div className="pt-2">
                                        <button onClick={() => { onVendorFileChange(null); resetMerge(); }} className="p-1 bg-zinc-900 rounded text-zinc-700 hover:text-rose-500 border border-zinc-800 transition-colors shadow-sm"><ArrowPathIcon className="w-3.5 h-3.5" /></button>
                                    </div>
                                </div>
                                {mergeResults?.platformUploadWorkbooks && (
                                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                                        {(Object.entries(mergeResults.platformUploadWorkbooks) as [string, PlatformUploadResult][]).map(([pName, pResult]) => (
                                            <button key={pName} onClick={() => handleDownloadPlatformInvoice(pName)}
                                                className="bg-violet-500 text-white px-2 py-1 rounded font-black text-[9px] hover:bg-violet-600 shadow-md flex items-center gap-1">
                                                <ArrowDownTrayIcon className="w-3 h-3" /><span>{pName} {pResult.count}건</span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                                {onDownloadMergedInvoice && isFirstSession && (
                                    <div className="flex items-center gap-2 mt-1">
                                        <button onClick={() => onDownloadMergedInvoice('mgmt')} className="bg-indigo-500 text-white px-2 py-1 rounded font-black text-[9px] hover:bg-indigo-600 shadow-md flex items-center gap-1"><ArrowDownTrayIcon className="w-3 h-3" /><span>합산 기록용</span></button>
                                        <button onClick={() => onDownloadMergedInvoice('upload')} className="bg-indigo-500 text-white px-2 py-1 rounded font-black text-[9px] hover:bg-indigo-600 shadow-md flex items-center gap-1"><ArrowDownTrayIcon className="w-3 h-3" /><span>합산 업로드용</span></button>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </td>
            </tr>

            {showExcluded && (excludedList.length > 0 || (syncedData?.excludedDetails?.length || 0) > 0) && (
                <tr className="bg-rose-950/10 border-none animate-fade-in">
                    <td colSpan={3} className="px-6 py-4">
                        <div className="bg-zinc-900/80 p-4 rounded-xl border border-rose-900/30 shadow-xl">
                            <h5 className="text-rose-500 font-black text-[10px] uppercase tracking-widest mb-3">제외된 주문</h5>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                {(excludedList.length > 0 ? excludedList : syncedData?.excludedDetails || []).map((f: any, idx: number) => (
                                    <div key={idx} className="bg-zinc-950/80 p-2.5 rounded-lg border border-rose-900/20 flex flex-col gap-1">
                                        <div className="flex justify-between items-center">
                                            <span className="text-zinc-200 font-bold text-[12px]">{f.recipientName}</span>
                                            <span className="text-[8px] px-1.5 py-0.5 rounded font-black bg-rose-500/20 text-rose-400">EXCLUDED</span>
                                        </div>
                                        <div className="text-zinc-500 text-[10px] font-mono truncate">{f.productName}{f.qty > 1 ? ` ×${f.qty}` : ''}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </td>
                </tr>
            )}

            {showSummary && (localResult || syncedData) && (
                <tr className="bg-zinc-950/40 border-none animate-fade-in">
                    <td colSpan={3} className="px-6 py-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="bg-zinc-900/60 p-4 rounded-xl border border-zinc-800 shadow-xl relative">
                                <div className="flex justify-between items-center mb-3">
                                    <h5 className="text-zinc-500 font-black text-[10px] uppercase tracking-widest">정산 요약</h5>
                                    <div className="flex gap-1.5">
                                        <button onClick={() => handleCopy(sessionId, cumulativeDepositText || localResult?.depositSummary || syncedData?.depositSummary || '', 'kakao')} className={`text-[9px] font-black px-2 py-1 rounded border transition-all ${copiedId === sessionId ? 'bg-emerald-500 text-white border-emerald-400' : 'bg-zinc-800 text-rose-400 border-zinc-700 hover:text-white'}`}>{copiedId === sessionId ? '복사됨!' : '카톡용'}</button>
                                        <button onClick={() => handleCopy(sessionId, cumulativeDepositExcelText || localResult?.depositSummaryExcel || syncedData?.depositSummaryExcel || '', 'excel')} className={`text-[9px] font-black px-2 py-1 rounded border transition-all ${copiedExcelId === sessionId ? 'bg-emerald-500 text-white border-emerald-400' : 'bg-zinc-800 text-indigo-400 border-zinc-700 hover:text-white'}`}>{copiedExcelId === sessionId ? '복사됨!' : '엑셀용'}</button>
                                    </div>
                                </div>
                                <pre className="text-[12px] font-mono text-zinc-200 whitespace-pre-wrap leading-tight bg-zinc-950/50 p-4 rounded-lg border border-zinc-800/50 max-h-[300px] overflow-auto custom-scrollbar">
                                    {(() => {
                                        const isCumulative = cumulativeDepositText !== null;
                                        const baseTotal = isCumulative
                                            ? (Object.values(combinedSummary) as { count: number; totalPrice: number }[]).reduce((a, b) => a + b.totalPrice, 0)
                                            : (localResult ? Object.values(localResult.summary).reduce((a: number, b: any) => a + (b.totalPrice || 0), 0)
                                               : (syncedData ? Object.values(syncedData.itemSummary).reduce((a: number, b: any) => a + (b.totalPrice || 0), 0) : 0));
                                        const adjTotal = sessionAdjustments.reduce((a, b) => a + b.amount, 0);
                                        let text = isCumulative ? cumulativeDepositText : (localResult?.depositSummary || syncedData?.depositSummary || '');
                                        if (sessionAdjustments.length > 0) {
                                            const adjRows = sessionAdjustments.map(a => `${a.label}\t${a.amount.toLocaleString()}원`).join('\n');
                                            text = text.replace('총 합계', `[추가/차감 내역]\n${adjRows}\n\n총 합계`)
                                                       .replace(/(총 합계\s+)([\d,]+)(원)/, (match, p1, p2, p3) => {
                                                           return `${p1}${(baseTotal + adjTotal).toLocaleString()}${p3}`;
                                                       });
                                        }
                                        return text;
                                    })()}
                                </pre>
                            </div>
                            <div className="bg-zinc-900/60 p-4 rounded-xl border border-zinc-800 shadow-xl">
                                <h5 className="text-zinc-500 font-black text-[10px] uppercase tracking-widest mb-3">원본 품목 검증 <span className="text-zinc-600">({(cumulativeDepositText !== null ? (Object.values(combinedSummary) as { count: number }[]).reduce((a, b) => a + b.count, 0) : (localResult?.orderItems || syncedData?.orderItems || []).length)}건)</span></h5>
                                <div className="bg-zinc-950/50 p-4 rounded-lg border border-zinc-800/50 max-h-[300px] overflow-auto custom-scrollbar">
                                    {(() => {
                                        const isCumulative = cumulativeDepositText !== null;
                                        const items = localResult?.orderItems || syncedData?.orderItems || [];
                                        const summary = isCumulative ? combinedSummary : (localResult?.summary || syncedData?.itemSummary || {});
                                        const extractSizes = (s: string) => {
                                            const matches = s.match(/(\d+(?:\.\d+)?)\s*kg/gi) || [];
                                            return matches.map(m => m.replace(/\s/g, '').toLowerCase());
                                        };
                                        // matchedProductKey별로 원본 옵션 그룹핑
                                        const grouped: Record<string, Record<string, number>> = {};
                                        items.forEach(item => {
                                            const mk = item.matchedProductKey || 'unknown';
                                            if (!grouped[mk]) grouped[mk] = {};
                                            const rawKey = `${item.registeredProductName} ${item.registeredOptionName}`.trim();
                                            grouped[mk][rawKey] = (grouped[mk][rawKey] || 0) + item.qty;
                                        });
                                        const summaryKeys = Object.keys(summary);
                                        let totalItems = 0;
                                        let grandTotalMargin = 0;
                                        return (
                                            <div className="space-y-2">
                                                {summaryKeys.map((key, idx) => {
                                                    const expectedCount = summary[key]?.count || 0;
                                                    const rawEntries = grouped[key] || {};
                                                    const matchedSizes = extractSizes(key);
                                                    const entryList = Object.entries(rawEntries);
                                                    const actualTotal = entryList.reduce((a, [, c]) => a + c, 0);
                                                    totalItems += isCumulative ? expectedCount : actualTotal;
                                                    const productConfig = pricingConfig[companyName]?.products?.[key];
                                                    const unitSupply = summary[key]?.totalPrice ? Math.round(summary[key].totalPrice / summary[key].count) : 0;
                                                    const unitMargin = (productConfig as any)?.margin || 0;
                                                    const totalMargin = unitMargin * expectedCount;
                                                    grandTotalMargin += totalMargin;
                                                    return (
                                                        <div key={idx}>
                                                            <div className="flex justify-between text-[12px] font-mono text-zinc-200 font-bold gap-2">
                                                                <span className="shrink-0">{key}{unitSupply ? ` (${unitSupply.toLocaleString()})` : ''}</span>
                                                                <div className="flex items-center gap-2 shrink-0">
                                                                    {unitMargin > 0 && (
                                                                        <span className="text-emerald-400 text-[10px] font-black">+{unitMargin.toLocaleString()} × {expectedCount} = {totalMargin.toLocaleString()}</span>
                                                                    )}
                                                                    {unitMargin < 0 && (
                                                                        <span className="text-red-400 text-[10px] font-black">{unitMargin.toLocaleString()} × {expectedCount}</span>
                                                                    )}
                                                                    <span>{expectedCount}개</span>
                                                                </div>
                                                            </div>
                                                            {entryList.map(([rawName, cnt], j) => {
                                                                const rawSizes = extractSizes(rawName);
                                                                const isBad = matchedSizes.length > 0 && rawSizes.length > 0 && !rawSizes.some(rs => matchedSizes.includes(rs));
                                                                return (
                                                                    <div key={j} className={`flex justify-between text-[11px] font-mono pl-3 ${isBad ? 'text-red-400 font-bold' : 'text-zinc-500'}`}>
                                                                        <span>{isBad ? '! ' : '  '}{rawName}</span>
                                                                        <span>{cnt}개</span>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    );
                                                })}
                                                <div className="border-t border-zinc-800 pt-2 mt-2 space-y-1">
                                                    <div className="flex justify-between text-[12px] font-mono text-zinc-200 font-bold">
                                                        <span>총 주문수</span>
                                                        <span>{totalItems}개</span>
                                                    </div>
                                                    {grandTotalMargin !== 0 && (
                                                        <div className="flex justify-between text-[12px] font-mono font-bold">
                                                            <span className="text-emerald-400">총 마진</span>
                                                            <span className={grandTotalMargin > 0 ? 'text-emerald-400' : 'text-red-400'}>{grandTotalMargin > 0 ? '+' : ''}{grandTotalMargin.toLocaleString()}원</span>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })()}
                                </div>
                            </div>
                        </div>
                    </td>
                </tr>
            )}
        </>
    );
};

export default CompanyWorkstationRow;
