
import React, { useState, useEffect, useRef, useContext } from 'react';
import { createPortal } from 'react-dom';
import { useInvoiceMerger, type PlatformUploadResult } from '../hooks/useInvoiceMerger';
import { useConsolidatedOrderConverter, ProcessedResult, getKeywordsForCompany, getHeaderForCompany } from '../hooks/useConsolidatedOrderConverter';
import {
    ArrowDownTrayIcon, CheckIcon, UploadIcon, BoltIcon,
    ChevronDownIcon, ChevronUpIcon, ArrowPathIcon, DocumentArrowUpIcon,
    PlusCircleIcon, TrashIcon, EyeIcon
} from './icons';
import type { PricingConfig, ExcludedOrder, ManualOrder, UnmatchedOrder, PlatformConfigs } from '../types';
import { DragHandleContext } from './DragHandleContext';
import { getBusinessInfo } from '../types';
import { deleteField } from 'firebase/firestore';
import type { SessionResultData, DailyWorkspaceData } from '../services/firestoreService';

declare var XLSX: any;

const platformAbbr = (p: string) => {
    const n = p.replace(/\s/g, '');
    if (n === '쿠팡') return 'C';
    if (n.startsWith('토스') || n === 'toss') return 'T';
    if (n.startsWith('지마켓') || n === 'gmarket') return 'G';
    if (n.startsWith('옥션') || n === 'auction') return 'A';
    if (n.startsWith('네이버') || n === 'naver') return 'N';
    if (n.startsWith('11번가') || n === '11st') return '11';
    if (n.startsWith('위메프') || n === 'wemakeprice') return 'W';
    if (n.startsWith('인터파크') || n === 'interpark') return 'I';
    return p.charAt(0).toUpperCase();
};
const platformColorClass = (p: string) => {
    const n = p.replace(/\s/g, '');
    if (n === '쿠팡') return 'text-rose-400';
    if (n.startsWith('토스') || n === 'toss') return 'text-blue-400';
    if (n.startsWith('지마켓') || n === 'gmarket') return 'text-green-400';
    return 'text-purple-400';
};

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
    companySummaryBar?: React.ReactNode;
    vendorFiles: File[];
    masterFile: File | null;
    batchFile?: File | null;
    isDetected: boolean;
    fakeOrderNumbers: string;
    manualOrders?: ManualOrder[];
    isSelected?: boolean;
    onSelectToggle?: (sessionId: string) => void;
    onVendorFileChange: (files: File[]) => void;
    onResultUpdate: (sessionId: string, totalPrice: number, excludedCount?: number, excludedDetails?: ExcludedOrder[]) => void;
    onDataUpdate: (sessionId: string, orderRows: any[][], invoiceRows: any[][], uploadInvoiceRows: any[][], summaryExcel: string, header?: any[], registeredProductNames?: Record<string, string>, itemSummary?: Record<string, { count: number; totalPrice: number }>, orderItems?: { registeredProductName: string; registeredOptionName: string; matchedProductKey: string; qty: number; recipientName: string }[], preConsolidationByGroup?: Record<string, number>) => void;
    onAddSession: () => void;
    onRemoveSession: () => void;
    onAddAdjustment: (companyName: string, amount: string) => void;
    isClosed?: boolean;
    onToggleClosed?: () => void;
    isActive?: boolean;
    onDownloadMergedOrder?: () => void;
    onDownloadMergedInvoice?: (type: 'mgmt' | 'upload') => void;
    previousRoundItems?: { round: number; summary: Record<string, { count: number; totalPrice: number }> }[];
    previousSessionIds?: string[];
    manualOrdersRejected?: boolean; // deprecated: 체크박스 선택으로 대체
    onManualOrdersApproval?: (companyName: string, approved: boolean) => void; // deprecated
    businessId?: string;
    onConfigChange: (newConfig: PricingConfig) => void;
    masterExpectedCount?: number;
    missingItems?: { groupName: string; diffQty: number; names?: string[] }[];
    orderPlatformMap?: Map<string, string>;
    platformConfigs?: PlatformConfigs;
    fakeCourierRows?: any[][];
    roundPlatform?: string;          // 이 세션의 플랫폼명
    companyTotalOrders?: number;     // 업체 전체 합계 (1차+2차+...)
    roundOrderCounts?: { round: number; count: number; platform: string }[]; // 라운드별 수량+플랫폼
    fakeMismatch?: boolean;
    companyChecked?: boolean;
    isRecorded?: boolean;
    onRecord?: () => void;
    workDate?: string;
    workspace: DailyWorkspaceData | null;
    updateField: (field: string, value: any) => Promise<void>;
    updateSessionField: (dotPath: string, value: any) => Promise<void>;
    sessionResults: Record<string, SessionResultData> | null;
    onSaveSessionResult: (sessionId: string, data: SessionResultData) => void;
    onDeleteSessionResult: (sessionId: string) => void;
    pendingOrderLight?: boolean;
    pendingInvoiceLight?: boolean;
    onOrderDownloaded?: () => void;
    onInvoiceDownloaded?: () => void;
    mergedDownloaded?: boolean;
    onWarningUpdate?: (sessionId: string, hasWarning: boolean) => void;
    onEffectiveTextChange?: (kakaoText: string, excelText: string) => void;
}

const CompanyWorkstationRow: React.FC<CompanyWorkstationRowProps> = ({
    sessionId, companyName, roundNumber, isFirstSession, isLastSession, pricingConfig, vendorFiles, masterFile, batchFile, isDetected, fakeOrderNumbers, manualOrders = [],
    isSelected, onSelectToggle, onVendorFileChange, onResultUpdate, onDataUpdate, onAddSession, onRemoveSession, onAddAdjustment, onDownloadMergedOrder, onDownloadMergedInvoice,
    companySummaryBar,
    previousRoundItems = [],
    previousSessionIds = [],
    manualOrdersRejected = false, onManualOrdersApproval,
    businessId, onConfigChange, masterExpectedCount = 0,
    missingItems = [],
    orderPlatformMap, platformConfigs,
    fakeCourierRows,
    roundPlatform = '쿠팡', companyTotalOrders = 0, roundOrderCounts = [],
    fakeMismatch = false,
    companyChecked = false,
    isRecorded = false,
    isClosed = false, onToggleClosed, isActive = true,
    onRecord,
    workDate,
    workspace, updateField, updateSessionField, sessionResults, onSaveSessionResult, onDeleteSessionResult,
    pendingOrderLight = false, pendingInvoiceLight = false,
    onOrderDownloaded, onInvoiceDownloaded,
    mergedDownloaded = false,
    onWarningUpdate,
    onEffectiveTextChange,
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

    // 수동 차감/추가 내역 상태
    const [adjAmount, setAdjAmount] = useState('');
    const [adjLabel, setAdjLabel] = useState('');
    const [sessionAdjustments, setSessionAdjustments] = useState<SessionAdjustment[]>([]);

    const [summaryOverride, setSummaryOverride] = useState<Record<string, { count: number; totalPrice: number }> | null>(null);
    const [isEditingSummary, setIsEditingSummary] = useState(false);
    const [editValues, setEditValues] = useState<Record<string, { count: string; totalPrice: string }>>({});

    const [workflow, setWorkflow] = useState<WorkflowStatus>({ order: false, deposit: false, invoice: false });
    const [showPrevRoundItems, setShowPrevRoundItems] = useState(false);
    const [sessionMemo, setSessionMemo] = useState('');
    const [showConsolidationLog, setShowConsolidationLog] = useState(false);
    const [showSizeMismatch, setShowSizeMismatch] = useState(false);
    const [showOrderPreview, setShowOrderPreview] = useState(false);
    const [orderDownloaded, setOrderDownloaded] = useState(false);
    const [mergedOrderDownloaded, setMergedOrderDownloaded] = useState(false);

    useEffect(() => { setOrderDownloaded(false); setMergedOrderDownloaded(false); }, [localResult]);

    // 사이즈 불일치 감지: 매칭된 품목 키의 kg와 원본 옵션명의 kg가 다른 항목
    const sizeMismatchItems = (() => {
        const items = localResult?.orderItems || [];
        const extractSizes = (s: string) => {
            const matches = s.match(/(\d+(?:\.\d+)?)\s*kg/gi) || [];
            return matches.map(m => m.replace(/\s/g, '').toLowerCase());
        };
        return items.filter(item => {
            const matchedSizes = extractSizes(item.matchedProductKey);
            const rawSizes = extractSizes(`${item.registeredProductName} ${item.registeredOptionName}`);
            return matchedSizes.length > 0 && rawSizes.length > 0 && !rawSizes.some(rs => matchedSizes.includes(rs));
        });
    })();

    // 새 결과 생성 시 패널 접기 + 푸시 알림
    const prevResultRef = useRef<ProcessedResult | null>(null);
    useEffect(() => {
        if (!localResult || localResult === prevResultRef.current) return;
        prevResultRef.current = localResult;
        setShowConsolidationLog(false);
        setShowSizeMismatch(false);
        const consolidationCount = (localResult as any).consolidationLog?.length || 0;
        const mismatchCount = sizeMismatchItems.length;
        if (consolidationCount === 0 && mismatchCount === 0) return;
        const sendNotif = (title: string, body: string) => {
            if (Notification.permission === 'granted') {
                new Notification(title, { body });
            } else if (Notification.permission !== 'denied') {
                Notification.requestPermission().then(p => {
                    if (p === 'granted') new Notification(title, { body });
                });
            }
        };
        if (consolidationCount > 0) sendNotif(`자동 합산 ${consolidationCount}건 변환`, `${companyName} 발주서 확인`);
        if (mismatchCount > 0) sendNotif(`사이즈 불일치 ${mismatchCount}건`, `${companyName} 발주서 확인 필요`);
    }, [localResult]);

    // 가구매 주문번호가 발주서에 포함된 경우 경고
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
        let sessionSummary: Record<string, { count: number; totalPrice: number }> | null = summaryOverride
            || localResult?.summary
            || ((!localResult && !isLocalProcessing) ? sessionResults?.[sessionId]?.itemSummary : undefined)
            || null;
        // 이전 차수가 있을 때, sessionSummary 수량이 실제 발주 수량(orderItems)보다 많으면
        // 누적 데이터가 잘못 저장된 것으로 판단 → orderItems에서 역산한 값 사용
        if (previousRoundItems.length > 0 && !localResult) {
            const savedItems = sessionResults?.[sessionId]?.orderItems || [];
            if (savedItems.length > 0) {
                const products = pricingConfig[companyName]?.products || {};
                const recomputed: Record<string, { count: number; totalPrice: number }> = {};
                for (const item of savedItems) {
                    const key = item.matchedProductKey;
                    if (!recomputed[key]) recomputed[key] = { count: 0, totalPrice: 0 };
                    recomputed[key].count += item.qty;
                    recomputed[key].totalPrice += item.qty * ((products[key] as any)?.supplyPrice || 0);
                }
                const recomputedTotal = Object.values(recomputed).reduce((a, b) => a + b.count, 0);
                const currentTotal = (Object.values(sessionSummary || {}) as { count: number; totalPrice: number }[]).reduce((a, b) => a + b.count, 0);
                if (currentTotal > recomputedTotal && Object.keys(recomputed).length > 0) {
                    sessionSummary = recomputed;
                }
            }
        }
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

    // 저장된 summary key를 현재 품목 설정의 orderFormName || displayName으로 변환
    const resolveProductDisplayName = (key: string): string => {
        const product = pricingConfig[companyName]?.products?.[key];
        const name = product?.orderFormName || product?.displayName;

        // name이 있고 "_숫자" suffix가 없으면 바로 사용
        if (name && !/_\d+$/.test(name)) return name;

        // displayName 자체가 "_숫자"로 끝나거나 product가 없는 경우:
        // suffix 제거 후 기본 키로 재탐색 (예: "포기김치 3kg_2" → "포기김치 3kg")
        const baseKey = key.replace(/_\d+$/, '');
        if (baseKey !== key) {
            const baseProduct = pricingConfig[companyName]?.products?.[baseKey];
            const baseName = baseProduct?.orderFormName || baseProduct?.displayName;
            if (baseName) return baseName;
        }

        return name || key;
    };

    // 같은 displayName으로 resolve되는 key들을 합산 (Firestore에 중복 키가 있는 경우 방지)
    const mergeByDisplayName = (summary: Record<string, { count: number; totalPrice: number }>): [string, { count: number; totalPrice: number }][] => {
        const merged = new Map<string, { count: number; totalPrice: number }>();
        for (const [key, stat] of Object.entries(summary) as [string, { count: number; totalPrice: number }][]) {
            const displayName = resolveProductDisplayName(key);
            const existing = merged.get(displayName);
            if (existing) {
                existing.count += stat.count;
                existing.totalPrice += stat.totalPrice;
            } else {
                merged.set(displayName, { count: stat.count, totalPrice: stat.totalPrice });
            }
        }
        return [...merged.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
    };

    // depositSummaryExcel 텍스트를 파싱해 itemSummary(productKey→{count,totalPrice}) 재구성
    // stale Firestore itemSummary 대신 항상 최신 표시 텍스트 기반으로 복원하기 위한 역변환
    const parseSummaryFromExcelText = (excelText: string): Record<string, { count: number; totalPrice: number }> => {
        const result: Record<string, { count: number; totalPrice: number }> = {};
        if (!excelText) return result;
        const companyProducts = pricingConfig[companyName]?.products || {};
        for (const line of excelText.split('\n')) {
            const parts = line.split('\t');
            const displayName = parts[1]?.trim();
            const countMatch = parts[2]?.trim().match(/^(\d+)개$/);
            if (!displayName || !countMatch) continue;
            const count = parseInt(countMatch[1]);
            if (!count) continue;
            const totalPrice = parseInt(parts[3]?.replace(/,/g, '') || '0') || 0;
            // displayName(orderFormName||displayName||key) → productKey 역추적
            const entry = Object.entries(companyProducts).find(
                ([k, p]: [string, any]) => (p.orderFormName || p.displayName || k) === displayName
            );
            result[entry?.[0] || displayName] = { count, totalPrice };
        }
        return result;
    };

    // 합산 정산 텍스트
    const combinedDepositText = (() => {
        if (Object.keys(combinedSummary).length === 0) return '';
        const today = workDate ? new Date(workDate + 'T00:00:00') : new Date();
        const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
        const dateTitle = `${today.getMonth() + 1}/${today.getDate()} (${weekdays[today.getDay()]})`;
        const mergedEntries = mergeByDisplayName(combinedSummary as Record<string, { count: number; totalPrice: number }>);
        const totalCount = mergedEntries.reduce((a, [, b]) => a + b.count, 0);
        const grandTotal = mergedEntries.reduce((a, [, b]) => a + b.totalPrice, 0);

        const lines: string[] = [];
        const bizShort = getBusinessInfo(businessId ?? '')?.shortName || '';
        lines.push(`${dateTitle} (${companyName})${bizShort ? ' ' + bizShort : ''} - 1~${roundNumber}차 합산`);
        lines.push(`총주문수\t${totalCount}개`);
        lines.push('');
        mergedEntries.forEach(([displayName, stat]) => {
            lines.push(`${displayName}\t${stat.count}개\t${stat.totalPrice.toLocaleString()}원`);
        });

        // 현재 차수 추가분 표시
        if (currentSessionSummary && Object.keys(currentSessionSummary).length > 0) {
            const addedItems = mergeByDisplayName(currentSessionSummary as Record<string, { count: number; totalPrice: number }>)
                .map(([displayName, stat]) => `${displayName} ${stat.count}개 ${stat.totalPrice.toLocaleString()}원`)
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
        const today = workDate ? new Date(workDate + 'T00:00:00') : new Date();
        const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
        const dateTitle = `${today.getMonth() + 1}/${today.getDate()} (${weekdays[today.getDay()]})`;
        const mergedEntries = mergeByDisplayName(combinedSummary as Record<string, { count: number; totalPrice: number }>);
        const totalCount = mergedEntries.reduce((a, [, b]) => a + b.count, 0);
        const grandTotal = mergedEntries.reduce((a, [, b]) => a + b.totalPrice, 0);
        const lines: string[] = [];
        const bizShort2 = getBusinessInfo(businessId ?? '')?.shortName || '';
        lines.push(`${dateTitle} (${companyName})${bizShort2 ? ' ' + bizShort2 : ''}`);
        lines.push(`총주문수\t${totalCount}개`);
        lines.push('');
        mergedEntries.forEach(([displayName, stat]) => {
            lines.push(`${displayName}\t${stat.count}개\t${stat.totalPrice.toLocaleString()}원`);
        });
        lines.push('');
        lines.push(`총 합계\t\t${grandTotal.toLocaleString()}원`);
        lines.push(`(입금자 ${getBusinessInfo(businessId ?? '')?.senderName || '안군농원'})`);
        return lines.join('\n');
    })();

    const cumulativeDepositExcelText = (() => {
        if (!isLastSession || previousRoundItems.length === 0 || Object.keys(combinedSummary).length === 0) return null;
        const today = workDate ? new Date(workDate + 'T00:00:00') : new Date();
        const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
        const dateTitle = `${today.getMonth() + 1}/${today.getDate()} (${weekdays[today.getDay()]})`;
        const mergedEntries = mergeByDisplayName(combinedSummary as Record<string, { count: number; totalPrice: number }>);
        const totalCount = mergedEntries.reduce((acc, [, s]) => acc + s.count, 0);
        const grandTotal = mergedEntries.reduce((acc, [, s]) => acc + s.totalPrice, 0);
        const lines: string[] = [];
        mergedEntries.forEach(([displayName, stat], idx) => {
            let col1 = idx === 0 ? dateTitle : idx === 1 ? `총 ${totalCount}개` : '';
            let line = `${col1}\t${displayName}\t${stat.count}개\t${stat.totalPrice.toLocaleString()}`;
            if (idx === mergedEntries.length - 1) line += `\t${grandTotal.toLocaleString()}`;
            lines.push(line);
        });
        return lines.join('\n');
    })();

    const buildDepositTextFromSummary = (summary: Record<string, { count: number; totalPrice: number }>, originalText: string | null | undefined): string => {
        const senderName = getBusinessInfo(businessId ?? '')?.senderName || '안군농원';
        const firstLine = originalText?.split('\n')[0] || '';
        const mergedEntries = mergeByDisplayName(summary);
        const totalCount = mergedEntries.reduce((a, [, b]) => a + b.count, 0);
        const grandTotal = mergedEntries.reduce((a, [, b]) => a + b.totalPrice, 0);
        const lines = [firstLine, `총주문수\t${totalCount}개`, ''];
        mergedEntries.forEach(([displayName, stat]) => {
            lines.push(`${displayName}\t${stat.count}개\t${stat.totalPrice.toLocaleString()}원`);
        });
        lines.push('', `총 합계\t\t${grandTotal.toLocaleString()}원`, `(입금자 ${senderName})`);
        return lines.join('\n');
    };

    const buildDepositExcelFromSummary = (summary: Record<string, { count: number; totalPrice: number }>, originalExcel: string | null | undefined): string => {
        const mergedEntries = mergeByDisplayName(summary);
        const totalCount = mergedEntries.reduce((a, [, s]) => a + s.count, 0);
        const grandTotal = mergedEntries.reduce((a, [, s]) => a + s.totalPrice, 0);
        const firstLineTitle = originalExcel?.split('\t')[0] || '';
        const lines: string[] = [];
        mergedEntries.forEach(([displayName, stat], idx) => {
            let col1 = idx === 0 ? firstLineTitle : idx === 1 ? `총 ${totalCount}개` : '';
            let line = `${col1}\t${displayName}\t${stat.count}개\t${stat.totalPrice.toLocaleString()}`;
            if (idx === mergedEntries.length - 1) line += `\t${grandTotal.toLocaleString()}`;
            lines.push(line);
        });
        return lines.join('\n');
    };

    const [copiedCombinedId, setCopiedCombinedId] = useState<string | null>(null);
    const handleCopyCombined = () => {
        let finalText = combinedDepositText;
        if (allSessionAdjustments.length > 0) {
            const adjText = allSessionAdjustments.map(a => `${a.label}\t${a.amount.toLocaleString()}원`).join('\n');
            const orderTotal = Object.values(combinedSummary as Record<string, { count: number; totalPrice: number }>).reduce((a, b) => a + b.totalPrice, 0);
            const adjTotal = allSessionAdjustments.reduce((a, b) => a + b.amount, 0);
            finalText = finalText
                .replace('총 합계', `[추가/차감 내역]\n${adjText}\n\n총 합계`)
                .replace(/(총 합계\s+)([\d,]+)(원)/, (_match, p1, _p2, p3) => `${p1}${(orderTotal + adjTotal).toLocaleString()}${p3}`);
        }
        navigator.clipboard.writeText(finalText);
        setCopiedCombinedId(sessionId);
        setTimeout(() => setCopiedCombinedId(null), 2000);
    };

    const lastProcessedMasterRef = useRef<File | null>(null);
    const lastProcessedBatchRef = useRef<File | null>(null);
    const lastFakeOrdersRef = useRef<string>('');
    const lastManualOrdersRef = useRef<string>('');
    const lastGoodMergeRef = useRef<{ rows: any[][], uploadRows: any[][], header: any[] } | null>(null);

    // 리셋 직후 Firestore 구독 업데이트 전까지 syncedData 억제
    const suppressSyncRef = useRef(false);
    if (suppressSyncRef.current && !sessionResults?.[sessionId]) {
        suppressSyncRef.current = false;
    }

    // Synced data (디바이스 2 - 로컬 처리 없을 때만)
    const syncedData = (!localResult && !isLocalProcessing && !suppressSyncRef.current) ? sessionResults?.[sessionId] : undefined;

    // 가구매 주문번호가 발주서에 포함된 경우 경고
    const fakeOrderWarnings = (() => {
        const fakeNums = new Set<string>();
        fakeOrderNumbers.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;
            const matches = trimmed.match(/[A-Za-z0-9-]{5,}/g);
            if (matches) matches.forEach(m => fakeNums.add(m.trim()));
        });
        if (fakeNums.size === 0) return [];
        const included = localResult?.includedOrderNumbers
            || syncedData?.includedOrderNumbers
            || [];
        return included.filter(n => fakeNums.has(n));
    })();

    const hasWarning = (() => {
        if (fakeOrderWarnings.length > 0) return true;
        if (unmatchedList.length > 0) return true;
        if (sizeMismatchItems.length > 0) return true;
        if (missingItems.length > 0) return true;
        if (masterExpectedCount > 0) {
            const processedCount = (localResult as any)?.originalOrderCount
                || Object.values(localResult?.summary || {}).reduce((a: number, b: any) => a + b.count, 0) as number
                || (syncedData?.orderCount ?? 0);
            const exQty = excludedList.reduce((s: number, e: any) => s + (e.qty || 1), 0);
            const unQty = unmatchedList.reduce((s: number, u: any) => s + (u.qty || 1), 0);
            if (masterExpectedCount > processedCount + exQty + unQty) return true;
        }
        return false;
    })();

    const onWarningUpdateRef = useRef(onWarningUpdate);
    onWarningUpdateRef.current = onWarningUpdate;
    useEffect(() => {
        onWarningUpdateRef.current?.(sessionId, hasWarning);
    }, [sessionId, hasWarning]);

    // 누적 표시 시 이전 세션 포함 전체 조정 내역 (반품/차감이 1차에 있어도 2차+ 정산요약에 반영)
    const isCumulativeView = cumulativeDepositText !== null;
    const allSessionAdjustments: typeof sessionAdjustments = isCumulativeView && previousSessionIds.length > 0
        ? [...previousSessionIds.flatMap(id => workspace?.sessionAdjustments?.[id] || []), ...sessionAdjustments]
        : sessionAdjustments;

    // override 적용된 최종 정산 텍스트 (카톡용/엑셀용)
    const effectiveDisplayText = (() => {
        if (cumulativeDepositText !== null) return cumulativeDepositText;
        if (summaryOverride) {
            const origText = localResult?.depositSummary || syncedData?.depositSummary;
            return buildDepositTextFromSummary(summaryOverride, origText);
        }
        return localResult?.depositSummary || syncedData?.depositSummary || '';
    })();
    const effectiveDisplayExcelText = (() => {
        if (cumulativeDepositExcelText !== null) return cumulativeDepositExcelText;
        if (summaryOverride) {
            const origExcel = localResult?.depositSummaryExcel || syncedData?.depositSummaryExcel;
            return buildDepositExcelFromSummary(summaryOverride, origExcel);
        }
        return localResult?.depositSummaryExcel || syncedData?.depositSummaryExcel || '';
    })();

    const onEffectiveTextChangeRef = useRef(onEffectiveTextChange);
    onEffectiveTextChangeRef.current = onEffectiveTextChange;
    useEffect(() => {
        if (!effectiveDisplayText) return;
        const baseTotal = isCumulativeView
            ? Object.values(combinedSummary as Record<string, { count: number; totalPrice: number }>).reduce((a, b) => a + b.totalPrice, 0)
            : Object.values((summaryOverride || localResult?.summary || syncedData?.itemSummary || {}) as Record<string, { count: number; totalPrice: number }>).reduce((a, b) => a + b.totalPrice, 0);
        const adjTotal = allSessionAdjustments.reduce((a, b) => a + b.amount, 0);
        let kakaoText = effectiveDisplayText;
        if (allSessionAdjustments.length > 0) {
            const adjRows = allSessionAdjustments.map(a => `${a.label}\t${a.amount.toLocaleString()}원`).join('\n');
            kakaoText = effectiveDisplayText
                .replace('총 합계', `[추가/차감 내역]\n${adjRows}\n\n총 합계`)
                .replace(/(총 합계\s+)([\d,]+)(원)/, (_m, p1, _p2, p3) => `${p1}${(baseTotal + adjTotal).toLocaleString()}${p3}`);
        }
        onEffectiveTextChangeRef.current?.(kakaoText, effectiveDisplayExcelText);
    }, [effectiveDisplayText, effectiveDisplayExcelText, allSessionAdjustments]);

    const { status: mergeStatus, error: mergeError, processFiles, reset: resetMerge, results: mergeResults } = useInvoiceMerger();
    const { processSingleCompanyFile } = useConsolidatedOrderConverter(pricingConfig, businessId);

    // Firestore 동기화 - 값 비교로 에코 방지
    const lastFirestoreWorkflowRef = useRef('');
    const lastFirestoreAdjRef = useRef('');
    const lastFirestoreOverrideRef = useRef('');

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
        if (workspace.summaryOverrides?.[sessionId]) {
            const overrideStr = JSON.stringify(workspace.summaryOverrides[sessionId]);
            if (overrideStr !== lastFirestoreOverrideRef.current) {
                setSummaryOverride(workspace.summaryOverrides[sessionId]);
                lastFirestoreOverrideRef.current = overrideStr;
            }
        }
    }, [workspace, sessionId]);

    // pricingConfig에서 메모 초기화 (한 번만, isFirstSession만)
    const memoInitializedRef = useRef(false);
    useEffect(() => {
        if (!isFirstSession || memoInitializedRef.current) return;
        memoInitializedRef.current = true;
        const saved = pricingConfig[companyName]?.memo;
        if (saved !== undefined) {
            setSessionMemo(saved);
        }
    }, [pricingConfig, companyName, isFirstSession]);

    // workflow 변경 → Firestore에 저장
    const isInitialWorkflowLoad = useRef(true);
    useEffect(() => {
        if (isInitialWorkflowLoad.current) { isInitialWorkflowLoad.current = false; return; }
        const currentStr = JSON.stringify(workflow);
        if (currentStr === lastFirestoreWorkflowRef.current) return;
        lastFirestoreWorkflowRef.current = currentStr;
        updateSessionField(`sessionWorkflows.${sessionId}`, workflow);
    }, [workflow, sessionId, updateSessionField]);

    // sessionAdjustments 변경 → Firestore에 저장
    const isInitialAdjLoad = useRef(true);
    useEffect(() => {
        if (isInitialAdjLoad.current) { isInitialAdjLoad.current = false; return; }
        const currentStr = JSON.stringify(sessionAdjustments);
        if (currentStr === lastFirestoreAdjRef.current) return;
        lastFirestoreAdjRef.current = currentStr;
        updateSessionField(`sessionAdjustments.${sessionId}`, sessionAdjustments);
    }, [sessionAdjustments, sessionId, updateSessionField]);

    // sessionMemo 변경 → pricingConfig에 디바운스 저장 (영구 유지, 삭제 전까지 유지)
    const memoDebounceRef = useRef<ReturnType<typeof setTimeout>>();
    useEffect(() => {
        if (!isFirstSession || !memoInitializedRef.current) return;
        if (memoDebounceRef.current) clearTimeout(memoDebounceRef.current);
        memoDebounceRef.current = setTimeout(() => {
            const cfg = pricingConfigRef.current;
            if (!cfg[companyName]) return;
            const saved = cfg[companyName].memo || '';
            if (sessionMemo.trim() === saved.trim()) return;
            const newConfig = JSON.parse(JSON.stringify(cfg));
            if (sessionMemo.trim()) {
                newConfig[companyName].memo = sessionMemo;
            } else {
                delete newConfig[companyName].memo;
            }
            onConfigChange(newConfig);
        }, 1000);
        return () => { if (memoDebounceRef.current) clearTimeout(memoDebounceRef.current); };
    }, [sessionMemo, companyName, isFirstSession]);

    // summaryOverride 변경 → Firestore에 저장
    const isInitialOverrideLoad = useRef(true);
    useEffect(() => {
        if (isInitialOverrideLoad.current) { isInitialOverrideLoad.current = false; return; }
        const currentStr = summaryOverride ? JSON.stringify(summaryOverride) : '';
        if (currentStr === lastFirestoreOverrideRef.current) return;
        lastFirestoreOverrideRef.current = currentStr;
        if (summaryOverride) {
            updateSessionField(`summaryOverrides.${sessionId}`, summaryOverride);
        } else {
            updateSessionField(`summaryOverrides.${sessionId}`, deleteField());
        }
    }, [summaryOverride, sessionId, updateSessionField]);

    useEffect(() => {
        const manualOrdersStr = JSON.stringify(manualOrders);
        const hasFileChanged = isFirstSession && masterFile && isDetected && masterFile !== lastProcessedMasterRef.current;
        const hasBatchFileChanged = batchFile && batchFile !== lastProcessedBatchRef.current;
        const hasFakeOrdersChanged = fakeOrderNumbers !== lastFakeOrdersRef.current;
        const hasManualOrdersChanged = isFirstSession && manualOrdersStr !== lastManualOrdersRef.current;
        // 마스터 파일이 바뀌었는데 이 업체가 더 이상 감지되지 않으면 이전 세션 자동 초기화
        const hasFileChangedButEvicted = isFirstSession && masterFile && !isDetected
            && lastProcessedMasterRef.current !== null && masterFile !== lastProcessedMasterRef.current;
        if (companyName === '초록') {
            console.log(`[DEBUG-초록] effect: isFirstSession=${isFirstSession} masterFile=${!!masterFile} isDetected=${isDetected} sameFile=${masterFile === lastProcessedMasterRef.current} hasFileChanged=${hasFileChanged} isProcessing=${isProcessingRef.current} pendingReprocess=${!!pendingReprocessFileRef.current}`);
        }

        if (hasBatchFileChanged && batchFile) {
            // N차 일괄 업로드: 가구매 제외 포함하여 처리
            lastProcessedBatchRef.current = batchFile;
            lastFakeOrdersRef.current = fakeOrderNumbers;
            handleLocalFileChange(batchFile);
        } else if (hasFileChanged) {
            if (masterFile) {
                lastFakeOrdersRef.current = fakeOrderNumbers;
                lastManualOrdersRef.current = manualOrdersStr;

                if (!isProcessingRef.current) {
                    // ref는 실제 처리가 시작될 때만 업데이트 (처리 중 파일 교체 시 재트리거 허용)
                    lastProcessedMasterRef.current = masterFile;
                    // 수동발주가 있고 아직 선택 안 했으면 모달로 선택 후 처리, 아니면 바로 처리
                    if (isFirstSession && manualOrders.length > 0 && confirmedManualOrderIdsRef.current === null) {
                        pendingFileRef.current = masterFile;
                        setModalSelectedIds(new Set(manualOrders.map(o => o.id)));
                        setShowManualOrderModal(true);
                    } else {
                        const ordersToUse = confirmedManualOrderIdsRef.current !== null
                            ? manualOrders.filter(o => confirmedManualOrderIdsRef.current!.has(o.id))
                            : [];
                        handleLocalFileChange(masterFile, ordersToUse);
                    }
                } else {
                    // 처리 중 파일 교체 → 완료 후 handleLocalFileChange에서 직접 재실행
                    pendingReprocessFileRef.current = masterFile;
                }
            }
        } else if (hasFakeOrdersChanged && (lastProcessedMasterRef.current || lastProcessedBatchRef.current)) {
            // 가구매 변경: 이미 파일 처리가 된 이후에만 재처리 (1차/N차 모두)
            lastFakeOrdersRef.current = fakeOrderNumbers;
            lastManualOrdersRef.current = manualOrdersStr;
            const fileToReprocess = lastProcessedMasterRef.current || lastProcessedBatchRef.current;
            handleLocalFileChange(fileToReprocess);
        } else if (hasManualOrdersChanged) {
            // 수동주문 변경: 이미 팝업으로 확인한 경우에만 재처리 (확인 전이면 무시)
            lastFakeOrdersRef.current = fakeOrderNumbers;
            lastManualOrdersRef.current = manualOrdersStr;
            if (confirmedManualOrderIdsRef.current !== null && lastProcessedMasterRef.current) {
                handleLocalFileChange(lastProcessedMasterRef.current);
            }
        } else if (hasFileChangedButEvicted) {
            // K열 교체 등으로 이 업체가 마스터에서 제거됨 → 이전 세션 자동 초기화
            lastProcessedMasterRef.current = masterFile;
            resetSyncedData();
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
        const effectiveSummary = summaryOverride || localResult.summary;
        const orderTotal = Object.values(effectiveSummary).reduce((a: number, b: any) => a + (b.totalPrice || 0), 0);
        const adjTotal = sessionAdjustments.reduce((a, b) => a + b.amount, 0);
        onResultUpdate(sessionId, orderTotal + adjTotal, excludedList.length, excludedList);
        const effectiveExcel = summaryOverride ? buildDepositExcelFromSummary(summaryOverride, localResult.depositSummaryExcel) : localResult.depositSummaryExcel || '';
        // 정산내역 텍스트를 역파싱해 itemSummary 도출 (공통 업로드 경로의 매칭 오류 방지)
        const parsedFromExcel = parseSummaryFromExcelText(effectiveExcel);
        const itemSummaryForUpdate = Object.keys(parsedFromExcel).length > 0 ? parsedFromExcel : effectiveSummary;
        onDataUpdate(sessionId, localResult.rows || [], mergeResults?.rows || [], mergeResults?.uploadRows || [], effectiveExcel, mergeResults?.header, localResult.registeredProductNames, itemSummaryForUpdate, localResult.orderItems, localResult.preConsolidationByGroup);
    }, [localResult, mergeResults, excludedList, sessionId, onResultUpdate, onDataUpdate, sessionAdjustments, summaryOverride]);

    // Firestore에 처리 결과 저장 (크로스 디바이스 동기화)
    const saveResultDebounceRef = useRef<ReturnType<typeof setTimeout>>();
    const lastSavedResultRef = useRef('');
    useEffect(() => {
        if (!localResult) return;
        if (saveResultDebounceRef.current) clearTimeout(saveResultDebounceRef.current);
        saveResultDebounceRef.current = setTimeout(() => {
            const effectiveSummary = summaryOverride || localResult.summary;
            const orderTotal = Object.values(effectiveSummary).reduce((a: number, b: any) => a + (b.totalPrice || 0), 0);
            const adjTotal = sessionAdjustments.reduce((a, b) => a + b.amount, 0);
            const effectiveDepositText = summaryOverride ? buildDepositTextFromSummary(summaryOverride, localResult.depositSummary) : localResult.depositSummary || '';
            const effectiveDepositExcel = summaryOverride ? buildDepositExcelFromSummary(summaryOverride, localResult.depositSummaryExcel) : localResult.depositSummaryExcel || '';
            // mergeResults가 null이면(리셋/처리중) 마지막으로 저장된 병합 데이터 사용
            if (mergeResults) lastGoodMergeRef.current = { rows: mergeResults.rows || [], uploadRows: mergeResults.uploadRows || [], header: mergeResults.header || [] };
            const effectiveMerge = mergeResults ? lastGoodMergeRef.current! : (lastGoodMergeRef.current || { rows: [], uploadRows: [], header: [] });
            const resultData: SessionResultData = {
                orderRows: JSON.stringify(localResult.rows || []) as any,
                invoiceRows: JSON.stringify(effectiveMerge.rows) as any,
                uploadInvoiceRows: JSON.stringify(effectiveMerge.uploadRows) as any,
                header: effectiveMerge.header,
                summaryExcel: effectiveDepositExcel,
                depositSummary: effectiveDepositText,
                depositSummaryExcel: effectiveDepositExcel,
                totalPrice: orderTotal + adjTotal,
                excludedCount: excludedList.length,
                excludedDetails: excludedList,
                orderCount: (Object.values(effectiveSummary) as any[]).reduce((a: number, b: any) => a + (b.count || 0), 0),
                itemSummary: (() => { const p = parseSummaryFromExcelText(effectiveDepositExcel); return Object.keys(p).length > 0 ? p : effectiveSummary; })() as any,
                registeredProductNames: localResult.registeredProductNames || {},
                orderItems: localResult.orderItems || [],
                includedOrderNumbers: localResult.includedOrderNumbers || [],
                unmatchedOrders: unmatchedList.length > 0 ? unmatchedList : [],
            };
            const resultStr = JSON.stringify(resultData);
            if (resultStr === lastSavedResultRef.current) return;
            lastSavedResultRef.current = resultStr;
            onSaveSessionResult(sessionId, resultData);
            updateField('sessionSummary', { ...(workspace?.sessionSummary || {}), [sessionId]: { orderCount: resultData.orderCount } });
        }, 500);
        return () => { if (saveResultDebounceRef.current) clearTimeout(saveResultDebounceRef.current); };
    }, [localResult, mergeResults, excludedList, unmatchedList, sessionAdjustments, summaryOverride, sessionId]);

    // Synced data → parent 콜백 (디바이스 2: Firestore에서 로드)
    const lastSyncedCallbackRef = useRef('');
    // localResult 처리 후 이 ref에 itemSummary를 보관 → 리셋 후 Firestore가 덮어쓰지 않도록
    const localResultItemSummaryRef = useRef<Record<string, { count: number; totalPrice: number }> | null>(null);
    useEffect(() => {
        if (localResult) {
            // localResult 처리 완료 시 itemSummary 보관 (리셋 후 Firestore 덮어쓰기 방지용)
            const effectiveSummary = summaryOverride || localResult.summary;
            if (effectiveSummary && Object.keys(effectiveSummary).length > 0) {
                localResultItemSummaryRef.current = effectiveSummary;
            }
            return;
        }
        if (!syncedData) return;
        const key = `${syncedData.totalPrice}-${syncedData.orderCount}-${syncedData.excludedCount}-${syncedData.summaryExcel?.slice(0, 80) || ''}`;
        if (key === lastSyncedCallbackRef.current) return;
        lastSyncedCallbackRef.current = key;
        onResultUpdate(sessionId, syncedData.totalPrice, syncedData.excludedCount, syncedData.excludedDetails);
        const parseRows = (v: any) => typeof v === 'string' ? JSON.parse(v) : (v || []);
        const syncedUploadRows = parseRows(syncedData.uploadInvoiceRows);
        const syncedInvoiceRows = parseRows(syncedData.invoiceRows);
        const syncedHeader = syncedData.header?.length > 0 ? syncedData.header : [];
        // Firestore에서 유효한 병합 데이터가 있으면 ref 복원 (page-refresh 후 재저장 시 덮어쓰기 방지)
        if (syncedUploadRows.length > 0 || syncedInvoiceRows.length > 0) {
            lastGoodMergeRef.current = { rows: syncedInvoiceRows, uploadRows: syncedUploadRows, header: syncedHeader };
        }
        // localResult 처리 결과 → 없으면 depositSummaryExcel 파싱 → 그것도 없으면 Firestore itemSummary
        // (Firestore itemSummary는 품목 추가 전 저장된 스테일 데이터일 수 있음)
        const effectiveItemSummary = (() => {
            if (localResultItemSummaryRef.current) return localResultItemSummaryRef.current;
            const parsed = parseSummaryFromExcelText(syncedData.depositSummaryExcel || syncedData.summaryExcel || '');
            if (Object.keys(parsed).length > 0) return parsed;
            return syncedData.itemSummary;
        })();
        onDataUpdate(sessionId, parseRows(syncedData.orderRows), syncedInvoiceRows, syncedUploadRows, syncedData.summaryExcel, syncedHeader.length > 0 ? syncedHeader : undefined, syncedData.registeredProductNames, effectiveItemSummary, syncedData.orderItems, syncedData.preConsolidationByGroup);
        if (syncedData.unmatchedOrders) setUnmatchedList(syncedData.unmatchedOrders);
    }, [workspace, localResult, sessionId]);

    // 송장 merge 자동 트리거: vendorFiles가 새로 업로드될 때만 1회 실행
    const vendorFilesKeyRef = useRef('');
    useEffect(() => {
        const newKey = vendorFiles.map(f => f.name + f.size).join('|');
        if (newKey && newKey !== vendorFilesKeyRef.current) {
            vendorFilesKeyRef.current = newKey;
            const activeFile = localFile || batchFile || masterFile;
            if (activeFile && mergeStatus !== 'processing') {
                handleRunMerge();
            }
        }
        if (!vendorFiles.length) vendorFilesKeyRef.current = '';
    }, [vendorFiles, localFile, masterFile, mergeStatus]);

    const handleCopy = (id: string, baseText: string, type: 'kakao' | 'excel' = 'kakao') => {
        let finalText = baseText;
        if (allSessionAdjustments.length > 0) {
            if (type === 'kakao') {
                const adjText = allSessionAdjustments.map(a => `${a.label}\t${a.amount.toLocaleString()}원`).join('\n');
                const orderTotal = isCumulativeView
                    ? Object.values(combinedSummary as Record<string, { count: number; totalPrice: number }>).reduce((a, b) => a + b.totalPrice, 0)
                    : (localResult ? Object.values(localResult.summary).reduce((a: number, b: any) => a + (b.totalPrice || 0), 0)
                       : Object.values((syncedData?.itemSummary || {}) as Record<string, { count: number; totalPrice: number }>).reduce((a, b) => a + b.totalPrice, 0));
                const adjTotal = allSessionAdjustments.reduce((a, b) => a + b.amount, 0);
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
    const pendingReprocessFileRef = useRef<File | null>(null); // 처리 중 파일 교체 시 완료 후 재처리할 파일
    const latestMasterFileRef = useRef<File | null>(masterFile); // 항상 최신 masterFile 참조
    latestMasterFileRef.current = masterFile;
    // 수동발주 선택 모달 상태
    const [showManualOrderModal, setShowManualOrderModal] = useState(false);
    const [modalSelectedIds, setModalSelectedIds] = useState<Set<string>>(new Set());
    const pendingFileRef = useRef<File | null>(null);
    const confirmedManualOrderIdsRef = useRef<Set<string> | null>(null); // null = 아직 확인 안 함

    const handleManualOrderModalConfirm = () => {
        confirmedManualOrderIdsRef.current = new Set(modalSelectedIds);
        setShowManualOrderModal(false);
        const selectedOrders = manualOrders.filter(o => modalSelectedIds.has(o.id));
        handleLocalFileChange(pendingFileRef.current, selectedOrders);
    };

    const handleManualOrderModalCancel = () => {
        confirmedManualOrderIdsRef.current = new Set(); // 전부 제외
        setShowManualOrderModal(false);
        handleLocalFileChange(pendingFileRef.current, []);
    };

    const handleLocalFileChange = async (file: File | null, overrideManualOrders?: ManualOrder[], overrideFakeOrders?: string) => {
        if (isProcessingRef.current) return;
        isProcessingRef.current = true;
        // 처리 시작 시점에 수동주문 ref 갱신 (race condition 방지)
        lastManualOrdersRef.current = JSON.stringify(manualOrders);
        if (file && file !== masterFile) setLocalFile(file);
        setIsLocalProcessing(true);
        // overrideManualOrders가 주어지면 사용, 아니면 확인된 선택 기준으로 필터
        const ordersToInclude = overrideManualOrders !== undefined
            ? overrideManualOrders
            : (confirmedManualOrderIdsRef.current !== null
                ? manualOrders.filter(o => confirmedManualOrderIdsRef.current!.has(o.id))
                : []);
        try {
            const effectiveFakeOrders = overrideFakeOrders !== undefined ? overrideFakeOrders : fakeOrderNumbers;
            const processResponse = await processSingleCompanyFile(file, companyName, effectiveFakeOrders, ordersToInclude, workDate);
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
        // 처리 중 파일이 교체됐으면 최신 파일로 즉시 재처리
        const pendingFile = pendingReprocessFileRef.current;
        if (pendingFile && pendingFile !== file) {
            pendingReprocessFileRef.current = null;
            lastProcessedMasterRef.current = pendingFile;
            handleLocalFileChange(pendingFile, []);
            return;
        }
        pendingReprocessFileRef.current = null;
        // 송장 파일이 있으면 merge 결과 보존 (resetMerge가 results를 null로 밀어버림 방지)
        if (vendorFiles.length === 0) {
            resetMerge();
        }
    };

    const handleRunMerge = () => {
        // batchFile: localFile이 아직 null일 때(첫 렌더 타이밍) masterFile 대신 batchFile 사용
        const activeFile = localFile || batchFile || masterFile;
        if (activeFile && vendorFiles.length > 0) {
            processFiles(vendorFiles, activeFile, companyName, false, pricingConfig, orderPlatformMap, platformConfigs, businessId);
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
        onDeleteSessionResult(sessionId);
        const currentSummary = { ...(workspace?.sessionSummary || {}) };
        if (currentSummary[sessionId]) {
            delete currentSummary[sessionId];
            updateField('sessionSummary', currentSummary);
        }
    };

    const resetSyncedData = () => {
        suppressSyncRef.current = true;
        onDeleteSessionResult(sessionId);
        const currentSummary = { ...(workspace?.sessionSummary || {}) };
        delete currentSummary[sessionId];
        updateField('sessionSummary', currentSummary);
        setUnmatchedList([]);
        onResultUpdate(sessionId, 0, 0, []);
        onDataUpdate(sessionId, [], [], [], '', undefined, undefined, undefined);
    };

    const handleDownloadOrder = () => {
        if (fakeMismatch) alert('미매칭(수량)을 확인하세요.');
        if (localResult) {
            // 미리보기에서 수정한 내용을 반영해 워크북을 새로 생성 (원본 워크북은 수정 전 상태로 고정되어 있음)
            const headers = getHeaderForCompany(companyName, pricingConfig[companyName] || {} as any);
            const ws = XLSX.utils.aoa_to_sheet([headers, ...localResult.rows]);
            ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: Math.max(headers.length - 1, 0), r: 0 } }) };
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, '발주서');
            XLSX.writeFile(wb, localResult.fileName);
            onOrderDownloaded?.();
            setOrderDownloaded(true);
        }
    };
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
        onInvoiceDownloaded?.();
    };
    const handleDownloadPlatformInvoice = (platformName: string) => {
        const pResult = mergeResults?.platformUploadWorkbooks?.[platformName];
        if (pResult) XLSX.writeFile(pResult.workbook, pResult.fileName);
    };
    const handleDownloadAllPlatformInvoices = () => {
        if (!mergeResults?.platformUploadWorkbooks) return;
        // 쿠팡(기본) 업로드용도 함께 다운로드
        handleDownloadInvoice('upload');
        // 각 플랫폼별 파일 순차 다운로드 (브라우저 차단 방지용 딜레이)
        const entries = Object.entries(mergeResults.platformUploadWorkbooks) as [string, PlatformUploadResult][];
        entries.forEach(([, pResult], idx) => {
            setTimeout(() => XLSX.writeFile(pResult.workbook, pResult.fileName), (idx + 1) * 300);
        });
    };
    const [showPlatformDropdown, setShowPlatformDropdown] = useState(false);
    const platformDropdownRef = useRef<HTMLDivElement>(null);

    // 발주서 다운로드 전 메모 팝업
    const [pendingDownloadAction, setPendingDownloadAction] = useState<(() => void) | null>(null);

    const triggerDownloadWithMemoCheck = (action: () => void) => {
        if (sessionMemo.trim()) {
            setPendingDownloadAction(() => action);
        } else {
            action();
        }
    };
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (platformDropdownRef.current && !platformDropdownRef.current.contains(e.target as Node)) {
                setShowPlatformDropdown(false);
            }
        };
        if (showPlatformDropdown) document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [showPlatformDropdown]);

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
            <tr id={`session-${sessionId}`} className={`transition-all duration-500 border-none ${isActive ? (isAllDone ? 'bg-emerald-950/20' : (workflow.order || workflow.deposit || workflow.invoice) ? 'bg-zinc-900/40' : 'bg-transparent hover:bg-zinc-800/10') : 'opacity-20'}`}>
                <td className={`px-6 min-w-[360px] ${isFirstSession ? 'py-2' : 'py-0.5'}`}>
                    <div className="flex flex-col gap-2">
                        {isFirstSession ? (
                            <>
                                {companySummaryBar}
                                <div className="flex items-center gap-2 flex-wrap">
                                    <div
                                        className={`font-black text-xl tracking-tighter whitespace-nowrap transition-colors cursor-grab active:cursor-grabbing select-none ${isClosed ? 'opacity-30' : ''} ${companyChecked ? 'text-indigo-300/60' : isAllDone ? 'text-emerald-400' : 'text-white'}`}
                                        {...dragHandle.attributes}
                                        {...dragHandle.listeners}
                                    >
                                        {companyName}
                                    </div>
                                    {pendingOrderLight && (
                                        <span title="발주서 미다운로드" className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shadow-[0_0_6px_3px_rgba(251,191,36,0.5)] shrink-0" />
                                    )}
                                    {pendingInvoiceLight && (
                                        <span title="송장 미다운로드" className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_6px_3px_rgba(52,211,153,0.5)] shrink-0" />
                                    )}
                                    <button
                                        onClick={onToggleClosed}
                                        title={isClosed ? '마감 해제' : '마감 처리'}
                                        className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-black tracking-tight border transition-all ${
                                            isClosed
                                                ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                                                : 'bg-transparent text-zinc-700 border-zinc-800 hover:text-zinc-500 hover:border-zinc-600'
                                        }`}
                                    >
                                        마감
                                    </button>
                                    {onRecord && (
                                        <button
                                            onClick={onRecord}
                                            title={isRecorded ? '기록 해제' : `${companyName} 기록하기`}
                                            className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-black tracking-tight border transition-all ${
                                                isRecorded
                                                    ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                                                    : 'bg-transparent text-zinc-600 border-zinc-700 hover:text-zinc-500 hover:border-zinc-600'
                                            }`}
                                        >
                                            기록
                                        </button>
                                    )}
                                    <div className={`flex items-center gap-2 flex-wrap ${isClosed ? 'opacity-30' : ''}`}>
                                        <div className="flex items-center bg-zinc-950 p-0.5 rounded-lg border border-zinc-800 gap-0.5">
                                            {(['order', 'deposit', 'invoice'] as const).map((step) => (
                                                <button
                                                    key={step}
                                                    onClick={() => toggleStep(step)}
                                                    className={`px-1.5 py-0.5 rounded text-[9px] font-black transition-all ${
                                                        workflow[step]
                                                            ? (step === 'order' ? 'bg-pink-500' : step === 'deposit' ? 'bg-emerald-500' : 'bg-indigo-500') + ' text-white shadow-md'
                                                            : 'text-zinc-600 hover:text-zinc-400'
                                                    }`}
                                                >
                                                    {step === 'order' ? '발주' : step === 'deposit' ? '입금' : '송장'}
                                                </button>
                                            ))}
                                        </div>

                                        {deadline && (
                                            <div className="bg-pink-500/10 text-pink-500 px-2 py-0.5 rounded-lg border border-pink-500/30 flex items-center gap-1 shrink-0">
                                                <span className="text-[9px] font-black uppercase opacity-70 tracking-tight">마감</span>
                                                <span className="text-[11px] font-black">{deadline}</span>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className={`flex flex-col gap-1.5 ${isClosed ? 'opacity-30 pointer-events-none' : ''}`}>
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
                                                className="w-20 bg-transparent border-none text-[10px] font-black text-pink-400 placeholder:text-zinc-700 focus:ring-0 p-0 text-right"
                                            />
                                            <button onClick={handleAddAdj} className="text-pink-500 hover:text-white hover:bg-pink-500 rounded p-0.5 transition-all">
                                                <PlusCircleIcon className="w-3 h-3" />
                                            </button>
                                        </div>
                                        {!isClosed && (
                                            <button onClick={onAddSession} className="p-1 bg-zinc-800 text-zinc-500 rounded-lg hover:bg-pink-500 hover:text-white transition-all border border-zinc-700">
                                                <PlusCircleIcon className="w-4 h-4" />
                                            </button>
                                        )}
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

                                <div className={`flex flex-wrap gap-1 items-center mb-3 ${isClosed ? 'opacity-30 pointer-events-none' : ''}`}>
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
                                            className="text-[9px] bg-zinc-950 text-zinc-300 px-1.5 py-0.5 rounded border border-zinc-700 font-bold w-20 outline-none focus:border-pink-500/50"
                                        />
                                    ) : (
                                        <button onClick={() => setIsAddingKeyword(true)} className="text-[9px] bg-zinc-900/50 text-zinc-600 hover:text-pink-400 px-1.5 py-0.5 rounded border border-dashed border-zinc-800 hover:border-pink-500/30 font-bold transition-colors">+</button>
                                    )}
                                </div>
                            </>
                        ) : (
                            <div className={`pl-4 border-l-2 border-zinc-800 py-0.5 ${isClosed ? 'opacity-30 pointer-events-none' : ''}`}>
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
                                                <button onClick={handleCopyCombined} className={`text-[9px] font-black px-2 py-0.5 rounded border transition-all ${copiedCombinedId ? 'bg-emerald-500 text-white border-emerald-400' : 'bg-zinc-800 text-pink-400 border-zinc-700 hover:text-white'}`}>{copiedCombinedId ? '복사됨!' : '카톡용'}</button>
                                            </div>
                                            <pre className="text-[10px] font-mono text-zinc-300 whitespace-pre-wrap leading-tight">{(() => {
                                                let text = combinedDepositText;
                                                if (allSessionAdjustments.length > 0) {
                                                    const adjRows = allSessionAdjustments.map(a => `${a.label}\t${a.amount.toLocaleString()}원`).join('\n');
                                                    const orderTotal = Object.values(combinedSummary as Record<string, { count: number; totalPrice: number }>).reduce((a, b) => a + b.totalPrice, 0);
                                                    const adjTotal = allSessionAdjustments.reduce((a, b) => a + b.amount, 0);
                                                    text = text.replace('총 합계', `[추가/차감 내역]\n${adjRows}\n\n총 합계`)
                                                               .replace(/(총 합계\s+)([\d,]+)(원)/, (_match, p1, _p2, p3) => `${p1}${(orderTotal + adjTotal).toLocaleString()}${p3}`);
                                                }
                                                return text;
                                            })()}</pre>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </td>

                <td className={`px-6 text-center ${isFirstSession ? 'py-2' : 'py-0.5'}`}>
                    <div className={`flex flex-col items-center ${isFirstSession ? 'gap-2' : 'gap-1'} ${isClosed ? 'opacity-30 pointer-events-none' : ''}`}>
                        {localResult ? (
                            <div className="flex flex-col items-center gap-1 animate-fade-in w-full">
                                {isFirstSession && (
                                    <textarea
                                        value={sessionMemo}
                                        onChange={e => setSessionMemo(e.target.value)}
                                        placeholder="메모"
                                        rows={2}
                                        className="w-full text-sm bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-amber-300 placeholder-zinc-700 resize-none focus:outline-none focus:border-zinc-600 leading-tight font-medium"
                                    />
                                )}
                                {isFirstSession && (
                                    <div className="flex items-center justify-center gap-4">
                                        <div className={`font-black text-xl ${(orderDownloaded || mergedOrderDownloaded) ? 'text-zinc-700' : 'text-pink-400'}`}>{companyTotalOrders || Object.values(localResult.summary).reduce((a:any, b:any) => a + b.count, 0)}</div>
                                        <div className="h-6 w-px bg-zinc-800" />
                                        {onDownloadMergedOrder ? (
                                            <button onClick={() => triggerDownloadWithMemoCheck(() => { onDownloadMergedOrder(); setMergedOrderDownloaded(true); })} className={`px-2 py-0.5 rounded font-black text-[9px] flex items-center border transition-all ${mergedOrderDownloaded ? 'bg-zinc-800 text-zinc-600 border-transparent' : 'bg-cyan-900/50 text-cyan-300 hover:bg-cyan-800/70 hover:text-cyan-100 border-cyan-700/50 shadow-md'}`}><ArrowDownTrayIcon className="w-3 h-3" /></button>
                                        ) : (
                                            <button onClick={() => triggerDownloadWithMemoCheck(handleDownloadOrder)} className={`px-2 py-0.5 rounded font-black text-[9px] flex items-center border transition-all ${orderDownloaded ? 'bg-zinc-800 text-zinc-600 border-transparent' : 'bg-violet-900/40 text-violet-300 hover:bg-violet-800/60 hover:text-violet-100 border-violet-700/40 shadow-md'}`}><ArrowDownTrayIcon className="w-3 h-3" /></button>
                                        )}
                                    </div>
                                )}
                                {isFirstSession ? (
                                    <div className="flex items-center justify-center gap-4">
                                        <div className={`font-black text-base ${(orderDownloaded || mergedOrderDownloaded) ? 'text-zinc-700' : 'text-indigo-400'}`}>{Object.values(localResult.summary).reduce((a:any, b:any) => a + b.count, 0)}</div>
                                        <div className="h-6 w-px bg-zinc-800" />
                                        <button onClick={() => setShowOrderPreview(true)} className="p-1 text-zinc-500 hover:text-indigo-400 transition-colors" title="발주서 미리보기"><EyeIcon className="w-3.5 h-3.5" /></button>
                                        <button onClick={() => triggerDownloadWithMemoCheck(handleDownloadOrder)} className={`px-2 py-0.5 rounded font-black text-[9px] flex items-center border transition-all ${(orderDownloaded || mergedOrderDownloaded) ? 'bg-zinc-800 text-zinc-600 border-transparent' : 'bg-violet-900/40 text-violet-300 hover:bg-violet-800/60 hover:text-violet-100 border-violet-700/40 shadow-md'}`}><ArrowDownTrayIcon className="w-3 h-3" /></button>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2 w-full">
                                        {(localResult as any).consolidationLog?.length > 0 && (
                                            <button onClick={() => setShowConsolidationLog(v => !v)} className="text-blue-400 text-[9px] font-black hover:text-blue-300 whitespace-nowrap">자{(localResult as any).consolidationLog.length}</button>
                                        )}
                                        {sizeMismatchItems.length > 0 && (
                                            <button onClick={() => setShowSizeMismatch(v => !v)} className="text-red-400 text-[9px] font-black hover:text-red-300 whitespace-nowrap">발{sizeMismatchItems.length}</button>
                                        )}
                                        <button onClick={() => setShowSummary(!showSummary)} className="text-zinc-600 hover:text-pink-400 text-[9px] font-black uppercase flex items-center gap-1 whitespace-nowrap">{showSummary ? <ChevronUpIcon className="w-3 h-3"/> : <ChevronDownIcon className="w-3 h-3"/>}정산</button>
                                        {excludedList.length > 0 && (
                                            <button onClick={() => setShowExcluded(!showExcluded)} className="text-pink-500 hover:text-pink-400 text-[9px] font-black uppercase flex items-center gap-1 whitespace-nowrap">
                                                제외({excludedList.length})
                                            </button>
                                        )}
                                        <div className="ml-auto flex items-center gap-2">
                                            <button onClick={resetLocalFile} className="p-1 bg-zinc-900 rounded text-zinc-700 hover:text-pink-500 border border-zinc-800 transition-colors"><ArrowPathIcon className="w-3 h-3" /></button>
                                            <div className="h-5 w-px bg-zinc-700" />
                                            <div className={`font-black text-base ${(orderDownloaded || mergedDownloaded) ? 'text-zinc-700' : 'text-indigo-400'}`}>+{Object.values(localResult.summary).reduce((a:any, b:any) => a + b.count, 0)}</div>
                                            <div className="h-6 w-px bg-zinc-800" />
                                            <button onClick={() => setShowOrderPreview(true)} className="p-1 text-zinc-500 hover:text-indigo-400 transition-colors" title="발주서 미리보기"><EyeIcon className="w-3.5 h-3.5" /></button>
                                            <button onClick={() => triggerDownloadWithMemoCheck(handleDownloadOrder)} className={`px-2 py-0.5 rounded font-black text-[9px] flex items-center border transition-all ${(orderDownloaded || mergedDownloaded) ? 'bg-zinc-800 text-zinc-600 border-transparent' : roundNumber === 1 ? 'bg-violet-900/40 text-violet-300 hover:bg-violet-800/60 hover:text-violet-100 border-violet-700/40 shadow-md' : roundNumber === 2 ? 'bg-sky-900/40 text-sky-300 hover:bg-sky-800/60 hover:text-sky-100 border-sky-700/40 shadow-md' : roundNumber === 3 ? 'bg-emerald-900/40 text-emerald-300 hover:bg-emerald-800/60 hover:text-emerald-100 border-emerald-700/40 shadow-md' : roundNumber === 4 ? 'bg-amber-900/40 text-amber-300 hover:bg-amber-800/60 hover:text-amber-100 border-amber-700/40 shadow-md' : 'bg-rose-900/40 text-rose-300 hover:bg-rose-800/60 hover:text-rose-100 border-rose-700/40 shadow-md'}`}><ArrowDownTrayIcon className="w-3 h-3" /></button>
                                        </div>
                                    </div>
                                )}
                                {showConsolidationLog && (localResult as any).consolidationLog?.length > 0 && (
                                    <div className="bg-blue-500/10 border border-blue-500/40 rounded-lg px-2.5 py-1.5 w-full animate-fade-in">
                                        <div className="space-y-0.5">
                                            {(localResult as any).consolidationLog.map((entry: any, idx: number) => (
                                                <div key={idx} className="text-[9px] text-blue-300/80 font-mono truncate">
                                                    {entry.recipientName}: {entry.before.map((b: any) => `${b.displayName} x${b.qty}`).join(' + ')} → {entry.after.map((a: any) => `${a.displayName} x${a.qty}`).join(' + ')}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {fakeOrderWarnings.length > 0 && (
                                    <div className="bg-yellow-500/10 border border-yellow-500/40 rounded-lg px-3 py-1.5 w-full animate-fade-in">
                                        <div className="text-yellow-400 text-[10px] font-black flex items-center gap-1">
                                            <span>⚠</span> 가구매 주문번호 {fakeOrderWarnings.length}건이 발주서에 포함됨
                                        </div>
                                        <div className="mt-1 space-y-0.5">
                                            {fakeOrderWarnings.map((n, idx) => (
                                                <div key={idx} className="text-[9px] text-yellow-300/80 font-mono truncate">{n}</div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {unmatchedList.length > 0 && (
                                    <div className="bg-pink-500/10 border border-pink-500/40 rounded-lg px-3 py-1.5 w-full animate-fade-in">
                                        <div className="text-pink-400 text-[10px] font-black flex items-center gap-1">
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
                                {showSizeMismatch && sizeMismatchItems.length > 0 && (
                                    <div className="bg-red-500/10 border border-red-500/40 rounded-lg px-2.5 py-1.5 w-full animate-fade-in">
                                        <div className="space-y-0.5">
                                            {sizeMismatchItems.map((item, idx) => (
                                                <div key={idx} className="text-[9px] text-red-300/80 font-mono truncate">
                                                    {item.recipientName}: {item.registeredProductName} {item.registeredOptionName} → {item.matchedProductKey}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {(() => {
                                    const processedCount = (localResult as any).originalOrderCount
                                        || Object.values(localResult.summary).reduce((a:any, b:any) => a + b.count, 0) as number;
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
                                                <div key={idx} className="text-[9px] text-orange-300/80 font-mono">
                                                    <div className="truncate">{m.groupName}: {m.diffQty}건 부족</div>
                                                    {m.names && m.names.length > 0 && (
                                                        <div className="text-[8px] text-orange-200/60 mt-0.5 flex flex-wrap gap-x-1">
                                                            {m.names.map((n, ni) => <span key={ni} className="bg-orange-500/10 px-1 rounded">{n}</span>)}
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {isFirstSession && (
                                    <div className="flex items-center gap-2">
                                        {(localResult as any).consolidationLog?.length > 0 && (
                                            <button onClick={() => setShowConsolidationLog(v => !v)} className="text-blue-400 text-[9px] font-black hover:text-blue-300 whitespace-nowrap">자{(localResult as any).consolidationLog.length}</button>
                                        )}
                                        {sizeMismatchItems.length > 0 && (
                                            <button onClick={() => setShowSizeMismatch(v => !v)} className="text-red-400 text-[9px] font-black hover:text-red-300 whitespace-nowrap">발{sizeMismatchItems.length}</button>
                                        )}
                                        <button onClick={() => setShowSummary(!showSummary)} className="text-zinc-600 hover:text-pink-400 text-[9px] font-black uppercase flex items-center gap-1 whitespace-nowrap">{showSummary ? <ChevronUpIcon className="w-3 h-3"/> : <ChevronDownIcon className="w-3 h-3"/>}정산</button>
                                        {excludedList.length > 0 && (
                                            <button onClick={() => setShowExcluded(!showExcluded)} className="text-pink-500 hover:text-pink-400 text-[9px] font-black uppercase flex items-center gap-1 whitespace-nowrap">
                                                제외({excludedList.length})
                                            </button>
                                        )}
                                        <button onClick={resetLocalFile} className="p-1 bg-zinc-900 rounded text-zinc-700 hover:text-pink-500 border border-zinc-800 transition-colors"><ArrowPathIcon className="w-3 h-3" /></button>
                                    </div>
                                )}
                            </div>
                        ) : isLocalProcessing ? (
                            <div className="flex flex-col items-center gap-1 text-indigo-400 font-black animate-pulse"><div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" /><span className="text-[9px] uppercase tracking-widest">Analysing...</span></div>
                        ) : syncedData ? (
                            <div className="flex flex-col items-center gap-1 animate-fade-in w-full">
                                {isFirstSession && (
                                    <textarea
                                        value={sessionMemo}
                                        onChange={e => setSessionMemo(e.target.value)}
                                        placeholder="메모"
                                        rows={2}
                                        className="w-full text-sm bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-amber-300 placeholder-zinc-700 resize-none focus:outline-none focus:border-zinc-600 leading-tight font-medium"
                                    />
                                )}
                                {isFirstSession ? (
                                    <div className="flex items-center justify-center gap-4">
                                        <div className="text-center">
                                            {roundOrderCounts.length > 1 ? (
                                                <>
                                                    <div className="text-pink-400 font-black text-xl">{companyTotalOrders}</div>
                                                    <div className="flex items-center justify-center gap-1.5 mt-0.5">
                                                        {roundOrderCounts.map((r, i) => (
                                                            <span key={i} className={`text-[10px] font-black ${platformColorClass(r.platform)}`}>
                                                                {platformAbbr(r.platform)}{r.count}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </>
                                            ) : (
                                                <div className="font-black text-pink-400 text-xl">{syncedData.orderCount}</div>
                                            )}
                                        </div>
                                        <div className="h-6 w-px bg-zinc-800" />
                                        <span className="text-zinc-600 text-[9px] font-black">(복원됨)</span>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2 w-full">
                                        <button onClick={() => setShowSummary(!showSummary)} className="text-zinc-600 hover:text-pink-400 text-[9px] font-black uppercase flex items-center gap-1 whitespace-nowrap">{showSummary ? <ChevronUpIcon className="w-3 h-3"/> : <ChevronDownIcon className="w-3 h-3"/>}정산</button>
                                        {(syncedData.excludedDetails?.length || 0) > 0 && (
                                            <button onClick={() => setShowExcluded(!showExcluded)} className="text-pink-500 hover:text-pink-400 text-[9px] font-black uppercase flex items-center gap-1 whitespace-nowrap">
                                                제외({syncedData.excludedDetails.length})
                                            </button>
                                        )}
                                        <div className="ml-auto flex items-center gap-2">
                                            <button onClick={resetSyncedData} className="p-1 bg-zinc-900 rounded text-zinc-700 hover:text-pink-500 border border-zinc-800 transition-colors"><ArrowPathIcon className="w-3 h-3" /></button>
                                            <div className="h-5 w-px bg-zinc-700" />
                                            <div className="font-black text-indigo-400 text-base">+{syncedData.orderCount}</div>
                                            <div className="h-6 w-px bg-zinc-800" />
                                            <span className="text-zinc-600 text-[9px] font-black">(복원됨)</span>
                                        </div>
                                    </div>
                                )}
                                {fakeOrderWarnings.length > 0 && (
                                    <div className="bg-yellow-500/10 border border-yellow-500/40 rounded-lg px-3 py-1.5 w-full animate-fade-in">
                                        <div className="text-yellow-400 text-[10px] font-black flex items-center gap-1">
                                            <span>⚠</span> 가구매 주문번호 {fakeOrderWarnings.length}건이 발주서에 포함됨
                                        </div>
                                        <div className="mt-1 space-y-0.5">
                                            {fakeOrderWarnings.map((n, idx) => (
                                                <div key={idx} className="text-[9px] text-yellow-300/80 font-mono truncate">{n}</div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {unmatchedList.length > 0 && (
                                    <div className="bg-pink-500/10 border border-pink-500/40 rounded-lg px-3 py-1.5 w-full animate-fade-in">
                                        <div className="text-pink-400 text-[10px] font-black flex items-center gap-1">
                                            <span>⚠</span> 매칭 실패 {unmatchedList.length}건 누락
                                        </div>
                                    </div>
                                )}
                                {(() => {
                                    const syncedProcessed = syncedData.originalOrderCount
                                        || (syncedData.itemSummary
                                            ? Object.values(syncedData.itemSummary).reduce((a: number, b: any) => a + (b.count || 0), 0)
                                            : syncedData.orderCount || 0);
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
                                                <div key={idx} className="text-[9px] text-orange-300/80 font-mono">
                                                    <div className="truncate">{m.groupName}: {m.diffQty}건 부족</div>
                                                    {m.names && m.names.length > 0 && (
                                                        <div className="text-[8px] text-orange-200/60 mt-0.5 flex flex-wrap gap-x-1">
                                                            {m.names.map((n, ni) => <span key={ni} className="bg-orange-500/10 px-1 rounded">{n}</span>)}
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {isFirstSession && (
                                    <div className="flex items-center gap-2">
                                        <button onClick={() => setShowSummary(!showSummary)} className="text-zinc-600 hover:text-pink-400 text-[9px] font-black uppercase flex items-center gap-1 whitespace-nowrap">{showSummary ? <ChevronUpIcon className="w-3 h-3"/> : <ChevronDownIcon className="w-3 h-3"/>}정산</button>
                                        {(syncedData.excludedDetails?.length || 0) > 0 && (
                                            <button onClick={() => setShowExcluded(!showExcluded)} className="text-pink-500 hover:text-pink-400 text-[9px] font-black uppercase flex items-center gap-1 whitespace-nowrap">
                                                제외({syncedData.excludedDetails.length})
                                            </button>
                                        )}
                                        <button onClick={resetSyncedData} className="p-1 bg-zinc-900 rounded text-zinc-700 hover:text-pink-500 border border-zinc-800 transition-colors"><ArrowPathIcon className="w-3 h-3" /></button>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="flex flex-col items-center gap-2 w-full">
                                {isFirstSession && (
                                    <textarea
                                        value={sessionMemo}
                                        onChange={e => setSessionMemo(e.target.value)}
                                        placeholder="메모"
                                        rows={2}
                                        className="w-full text-sm bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-amber-300 placeholder-zinc-700 resize-none focus:outline-none focus:border-zinc-600 leading-tight font-medium"
                                    />
                                )}
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
                                            <button onClick={() => setShowExcluded(!showExcluded)} className="text-pink-500 hover:text-pink-400 text-[9px] font-black uppercase flex items-center gap-1 whitespace-nowrap">
                                                제외({excludedList.length})
                                            </button>
                                            <button onClick={resetLocalFile} className="p-1 bg-zinc-900 rounded text-zinc-700 hover:text-pink-500 border border-zinc-800 transition-colors"><ArrowPathIcon className="w-3 h-3" /></button>
                                        </div>
                                    </div>
                                ) : (
                                    <label className="flex items-center gap-2 cursor-pointer px-4 py-1.5 rounded-lg text-[10px] font-black border border-zinc-800 bg-zinc-900/30 text-zinc-500 hover:border-indigo-500/40 hover:text-indigo-400 transition-all shadow-inner whitespace-nowrap">
                                        <DocumentArrowUpIcon className="w-4 h-4 text-zinc-700" />
                                        <span>발주서 업로드</span>
                                        <input type="file" className="sr-only" accept=".xlsx,.xls" onChange={(e) => {
                                            const f = e.target.files?.[0];
                                            if (!f) return;
                                            if (isFirstSession && manualOrders.length > 0) {
                                                pendingFileRef.current = f;
                                                lastProcessedMasterRef.current = f;
                                                setModalSelectedIds(new Set(manualOrders.map(o => o.id)));
                                                setShowManualOrderModal(true);
                                            } else {
                                                handleLocalFileChange(f, []);
                                            }
                                        }} />
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
                                                <div key={idx} className="text-[9px] text-orange-300/80 font-mono">
                                                    <div className="truncate">{m.groupName}: {m.diffQty}건 부족</div>
                                                    {m.names && m.names.length > 0 && (
                                                        <div className="text-[8px] text-orange-200/60 mt-0.5 flex flex-wrap gap-x-1">
                                                            {m.names.map((n, ni) => <span key={ni} className="bg-orange-500/10 px-1 rounded">{n}</span>)}
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </td>

                <td className={`px-3 ${isFirstSession ? 'py-2' : 'py-0.5'}`}>
                    <div className={`flex flex-col items-center ${isFirstSession ? 'gap-2' : 'gap-1'} ${isClosed ? 'opacity-30 pointer-events-none' : ''}`}>
                        {!mergeResults ? (
                            <div className="flex flex-col items-center gap-2">
                                <label className={`flex items-center cursor-pointer px-2 py-1 rounded-lg text-[9px] font-black border transition-all shadow-md ${mergeStatus === 'error' ? 'bg-rose-950/20 border-rose-500/30 text-rose-400' : vendorFiles.length > 0 ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-400' : 'bg-zinc-800/40 border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300'}`}>
                                    <UploadIcon className="w-3 h-3" />
                                    <input type="file" className="sr-only" accept=".xlsx,.xls" multiple onChange={(e) => { const files = e.target.files; if (files && files.length > 0) { resetMerge(); onVendorFileChange(Array.from(files)); } }} />
                                </label>
                                {mergeStatus === 'error' && mergeError && (
                                    <div className="text-rose-400 text-[9px] font-bold text-center max-w-[200px] leading-tight">{mergeError}</div>
                                )}
                                {vendorFiles.length > 0 && mergeStatus === 'idle' && !(localFile || batchFile || masterFile) && (
                                    <div className="text-pink-400 text-[9px] font-bold text-center max-w-[200px] leading-tight">발주서를 먼저 업로드해주세요</div>
                                )}
                            </div>
                        ) : (
                            <div className="flex items-center gap-1.5 animate-fade-in flex-nowrap">
                                <div className="relative shrink-0" ref={platformDropdownRef}>
                                    <button onClick={() => setShowPlatformDropdown(!showPlatformDropdown)}
                                        className="bg-zinc-700 text-white px-2 py-0.5 rounded font-black text-[9px] hover:bg-zinc-600 shadow-md flex items-center gap-1 whitespace-nowrap">
                                        <ArrowDownTrayIcon className="w-3 h-3" />
                                        <span>{currentStat?.mgmt || 0}건</span>
                                        <ChevronDownIcon className={`w-3 h-3 transition-transform ${showPlatformDropdown ? 'rotate-180' : ''}`} />
                                    </button>
                                    {showPlatformDropdown && (
                                        <div className="absolute top-full right-0 mt-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-50 min-w-[140px] py-1 animate-fade-in">
                                            <button onClick={() => { handleDownloadInvoice('mgmt'); setShowPlatformDropdown(false); }}
                                                className="w-full px-3 py-1.5 text-left text-[9px] font-black text-emerald-400 hover:bg-emerald-500/20 flex items-center gap-1.5 transition-colors">
                                                <ArrowDownTrayIcon className="w-3 h-3" /> 기록용
                                            </button>
                                            <button onClick={() => { handleDownloadInvoice('upload'); setShowPlatformDropdown(false); }}
                                                className="w-full px-3 py-1.5 text-left text-[9px] font-black text-rose-400 hover:bg-rose-500/20 flex items-center gap-1.5 transition-colors">
                                                <ArrowDownTrayIcon className="w-3 h-3" /> 업로드용
                                            </button>
                                            {mergeResults?.platformUploadWorkbooks && Object.keys(mergeResults.platformUploadWorkbooks).length > 0 && (
                                                <>
                                                    <div className="border-t border-zinc-800 my-0.5" />
                                                    <button onClick={() => { handleDownloadAllPlatformInvoices(); setShowPlatformDropdown(false); }}
                                                        className="w-full px-3 py-1.5 text-left text-[9px] font-black text-violet-400 hover:bg-violet-500/20 flex items-center gap-1.5 transition-colors">
                                                        <ArrowDownTrayIcon className="w-3 h-3" /> 통합 다운로드
                                                    </button>
                                                    {(Object.entries(mergeResults.platformUploadWorkbooks) as [string, PlatformUploadResult][]).map(([pName, pResult]) => (
                                                        <button key={pName} onClick={() => { handleDownloadPlatformInvoice(pName); setShowPlatformDropdown(false); }}
                                                            className="w-full px-3 py-1.5 text-left text-[9px] font-black text-violet-400 hover:bg-violet-500/20 flex items-center gap-1.5 transition-colors">
                                                            <ArrowDownTrayIcon className="w-3 h-3" /> {pName} {pResult.count}건
                                                        </button>
                                                    ))}
                                                </>
                                            )}
                                            {onDownloadMergedInvoice && isFirstSession && (
                                                <>
                                                    <div className="border-t border-zinc-800 my-0.5" />
                                                    <button onClick={() => { onDownloadMergedInvoice('mgmt'); setShowPlatformDropdown(false); }}
                                                        className="w-full px-3 py-1.5 text-left text-[9px] font-black text-indigo-400 hover:bg-indigo-500/20 flex items-center gap-1.5 transition-colors">
                                                        <ArrowDownTrayIcon className="w-3 h-3" /> 합산 기록용
                                                    </button>
                                                    <button onClick={() => { onDownloadMergedInvoice('upload'); setShowPlatformDropdown(false); }}
                                                        className="w-full px-3 py-1.5 text-left text-[9px] font-black text-indigo-400 hover:bg-indigo-500/20 flex items-center gap-1.5 transition-colors">
                                                        <ArrowDownTrayIcon className="w-3 h-3" /> 합산 업로드용
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    )}
                                </div>
                                <button onClick={() => { onVendorFileChange([]); resetMerge(); }} className="p-1 bg-zinc-900 rounded text-zinc-700 hover:text-pink-500 border border-zinc-800 transition-colors shadow-sm shrink-0"><ArrowPathIcon className="w-3 h-3" /></button>
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
                                    <div className="flex items-center gap-2">
                                        <h5 className="text-zinc-500 font-black text-[10px] uppercase tracking-widest">정산 요약</h5>
                                        {summaryOverride && !isEditingSummary && (
                                            <span className="text-[9px] text-amber-400 font-bold border border-amber-700 rounded px-1">수정됨</span>
                                        )}
                                    </div>
                                    <div className="flex gap-1.5">
                                        {!isEditingSummary && (
                                            <>
                                                <button onClick={() => handleCopy(sessionId, effectiveDisplayText, 'kakao')} className={`text-[9px] font-black px-2 py-1 rounded border transition-all ${copiedId === sessionId ? 'bg-emerald-500 text-white border-emerald-400' : 'bg-zinc-800 text-pink-400 border-zinc-700 hover:text-white'}`}>{copiedId === sessionId ? '복사됨!' : '카톡용'}</button>
                                                <button onClick={() => handleCopy(sessionId, effectiveDisplayExcelText, 'excel')} className={`text-[9px] font-black px-2 py-1 rounded border transition-all ${copiedExcelId === sessionId ? 'bg-emerald-500 text-white border-emerald-400' : 'bg-zinc-800 text-indigo-400 border-zinc-700 hover:text-white'}`}>{copiedExcelId === sessionId ? '복사됨!' : '엑셀용'}</button>
                                                <button
                                                    onClick={() => {
                                                        // summaryOverride > localResult.summary > 발주 품목 역산 > Firestore itemSummary
                                                        // effectiveDisplayExcelText는 마지막 차수에서 누적텍스트일 수 있으므로 사용 금지
                                                        const currentSummary = summaryOverride || localResult?.summary || (() => {
                                                            const savedItems = syncedData?.orderItems || [];
                                                            if (savedItems.length > 0) {
                                                                const products = pricingConfig[companyName]?.products || {};
                                                                const result: Record<string, { count: number; totalPrice: number }> = {};
                                                                for (const item of savedItems) {
                                                                    const key = item.matchedProductKey;
                                                                    if (!result[key]) result[key] = { count: 0, totalPrice: 0 };
                                                                    result[key].count += item.qty;
                                                                    result[key].totalPrice += item.qty * ((products[key] as any)?.supplyPrice || 0);
                                                                }
                                                                if (Object.keys(result).length > 0) return result;
                                                            }
                                                            return syncedData?.itemSummary || {};
                                                        })();
                                                        const vals: Record<string, { count: string; totalPrice: string }> = {};
                                                        Object.entries(currentSummary).forEach(([key, stat]: [string, any]) => {
                                                            vals[key] = { count: String(stat.count), totalPrice: String(stat.totalPrice) };
                                                        });
                                                        setEditValues(vals);
                                                        setIsEditingSummary(true);
                                                    }}
                                                    className="text-[9px] font-black px-2 py-1 rounded border transition-all bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-white"
                                                >수정</button>
                                                {summaryOverride && (
                                                    <button
                                                        onClick={() => setSummaryOverride(null)}
                                                        className="text-[9px] font-black px-2 py-1 rounded border transition-all bg-zinc-800 text-zinc-500 border-zinc-700 hover:text-red-400"
                                                    >초기화</button>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>
                                {isEditingSummary ? (
                                    <div className="bg-zinc-950/50 p-3 rounded-lg border border-zinc-800/50">
                                        <div className="space-y-1.5 mb-3">
                                            {(Object.entries(editValues) as [string, { count: string; totalPrice: string }][]).map(([key, val]) => (
                                                <div key={key} className="flex items-center gap-2">
                                                    <span className="text-zinc-300 font-mono text-[12px] min-w-0 shrink-0 max-w-[160px] truncate" title={key}>{resolveProductDisplayName(key)}</span>
                                                    <div className="flex items-center gap-1">
                                                        <input
                                                            type="number"
                                                            value={val.count}
                                                            onChange={e => setEditValues(prev => ({ ...prev, [key]: { ...prev[key], count: e.target.value } }))}
                                                            className="w-14 bg-zinc-900 border border-zinc-700 rounded px-2 py-0.5 text-zinc-200 text-[11px] font-mono text-right focus:outline-none focus:border-zinc-500"
                                                        />
                                                        <span className="text-zinc-500 text-[10px]">개</span>
                                                    </div>
                                                    <div className="flex items-center gap-1">
                                                        <input
                                                            type="number"
                                                            value={val.totalPrice}
                                                            onChange={e => setEditValues(prev => ({ ...prev, [key]: { ...prev[key], totalPrice: e.target.value } }))}
                                                            className="w-28 bg-zinc-900 border border-zinc-700 rounded px-2 py-0.5 text-zinc-200 text-[11px] font-mono text-right focus:outline-none focus:border-zinc-500"
                                                        />
                                                        <span className="text-zinc-500 text-[10px]">원</span>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                        <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
                                            <span className="text-zinc-400 font-mono text-[11px]">
                                                총 {(Object.values(editValues) as { count: string; totalPrice: string }[]).reduce((a, v) => a + (parseInt(v.count) || 0), 0)}개 &nbsp;
                                                {(Object.values(editValues) as { count: string; totalPrice: string }[]).reduce((a, v) => a + (parseInt(v.totalPrice) || 0), 0).toLocaleString()}원
                                            </span>
                                            <div className="flex gap-1.5">
                                                <button
                                                    onClick={() => {
                                                        const newOverride: Record<string, { count: number; totalPrice: number }> = {};
                                                        (Object.entries(editValues) as [string, { count: string; totalPrice: string }][]).forEach(([key, val]) => {
                                                            const count = parseInt(val.count, 10) || 0;
                                                            const totalPrice = parseInt(val.totalPrice, 10) || 0;
                                                            if (count > 0) newOverride[key] = { count, totalPrice };
                                                        });
                                                        setSummaryOverride(Object.keys(newOverride).length > 0 ? newOverride : null);
                                                        setIsEditingSummary(false);
                                                    }}
                                                    className="text-[9px] font-black px-2 py-1 rounded border bg-emerald-900 text-emerald-300 border-emerald-700 hover:bg-emerald-800"
                                                >저장</button>
                                                <button
                                                    onClick={() => setIsEditingSummary(false)}
                                                    className="text-[9px] font-black px-2 py-1 rounded border bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-white"
                                                >취소</button>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <pre className="text-[12px] font-mono text-zinc-200 whitespace-pre-wrap leading-tight bg-zinc-950/50 p-4 rounded-lg border border-zinc-800/50 max-h-[300px] overflow-auto custom-scrollbar">
                                        {(() => {
                                            const baseTotal = isCumulativeView
                                                ? Object.values(combinedSummary as Record<string, { count: number; totalPrice: number }>).reduce((a, b) => a + b.totalPrice, 0)
                                                : Object.values((summaryOverride || (localResult?.summary) || (syncedData?.itemSummary) || {}) as Record<string, { count: number; totalPrice: number }>).reduce((a, b) => a + b.totalPrice, 0);
                                            const adjTotal = allSessionAdjustments.reduce((a, b) => a + b.amount, 0);
                                            let text = effectiveDisplayText;
                                            if (allSessionAdjustments.length > 0) {
                                                const adjRows = allSessionAdjustments.map(a => `${a.label}\t${a.amount.toLocaleString()}원`).join('\n');
                                                text = text.replace('총 합계', `[추가/차감 내역]\n${adjRows}\n\n총 합계`)
                                                           .replace(/(총 합계\s+)([\d,]+)(원)/, (match, p1, _p2, p3) => {
                                                               return `${p1}${(baseTotal + adjTotal).toLocaleString()}${p3}`;
                                                           });
                                            }
                                            return text;
                                        })()}
                                    </pre>
                                )}
                            </div>
                            <div className="bg-zinc-900/60 p-4 rounded-xl border border-zinc-800 shadow-xl">
                                <h5 className="text-zinc-500 font-black text-[10px] uppercase tracking-widest mb-3">원본 품목 검증 <span className="text-zinc-600">({(cumulativeDepositText !== null ? (Object.values(combinedSummary) as { count: number }[]).reduce((a, b) => a + b.count, 0) : (localResult?.orderItems || syncedData?.orderItems || []).length)}건)</span></h5>
                                <div className="bg-zinc-950/50 p-4 rounded-lg border border-zinc-800/50 max-h-[300px] overflow-auto custom-scrollbar">
                                    {(() => {
                                        const isCumulative = cumulativeDepositText !== null;
                                        const items = localResult?.orderItems || syncedData?.orderItems || [];
                                        const summary = isCumulative ? combinedSummary : (summaryOverride || localResult?.summary || syncedData?.itemSummary || {});
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
                                                    const manualCount = localResult?.manualOrderCounts?.[key] || 0;
                                                    const marginCount = expectedCount - manualCount;
                                                    const totalMargin = unitMargin * marginCount;
                                                    grandTotalMargin += totalMargin;
                                                    return (
                                                        <div key={idx}>
                                                            <div className="flex justify-between text-[12px] font-mono text-zinc-200 font-bold gap-2">
                                                                <span className="shrink-0">{resolveProductDisplayName(key)}{unitSupply ? ` (${unitSupply.toLocaleString()})` : ''}</span>
                                                                <div className="flex items-center gap-2 shrink-0">
                                                                    {unitMargin > 0 && marginCount > 0 && (
                                                                        <span className="text-emerald-400 text-[10px] font-black">+{unitMargin.toLocaleString()} × {marginCount} = {totalMargin.toLocaleString()}</span>
                                                                    )}
                                                                    {unitMargin < 0 && marginCount > 0 && (
                                                                        <span className="text-red-400 text-[10px] font-black">{unitMargin.toLocaleString()} × {marginCount}</span>
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

            {/* 발주서 미리보기 모달 */}
            {showOrderPreview && localResult && createPortal(
                <div
                    style={{ position:'fixed', top:0, left:0, right:0, bottom:0, zIndex:99999, display:'flex', alignItems:'center', justifyContent:'center', backgroundColor:'rgba(0,0,0,0.75)' }}
                    onClick={() => setShowOrderPreview(false)}
                >
                    <div
                        style={{ background:'#18181b', borderRadius:'16px', padding:'20px', width:'92vw', maxWidth:'1200px', maxHeight:'85vh', display:'flex', flexDirection:'column', border:'1px solid #3f3f46', boxShadow:'0 25px 60px rgba(0,0,0,0.6)' }}
                        onClick={e => e.stopPropagation()}
                    >
                        {(() => {
                            const previewHeaders = getHeaderForCompany(companyName, pricingConfig[companyName] || {} as any);
                            const updateOrderCell = (ri: number, ci: number, value: string) => {
                                setLocalResult(prev => {
                                    if (!prev) return prev;
                                    const newRows = prev.rows.map((row, idx) => idx === ri ? row.map((cell, cidx) => cidx === ci ? value : cell) : row);
                                    return { ...prev, rows: newRows };
                                });
                            };
                            const addOrderRow = () => {
                                setLocalResult(prev => prev ? { ...prev, rows: [...prev.rows, new Array(previewHeaders.length).fill('')] } : prev);
                            };
                            const removeOrderRow = (ri: number) => {
                                setLocalResult(prev => prev ? { ...prev, rows: prev.rows.filter((_, idx) => idx !== ri) } : prev);
                            };
                            return (
                                <>
                                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'12px', flexShrink:0 }}>
                                        <div>
                                            <div style={{ color:'#fff', fontWeight:800, fontSize:'14px' }}>{companyName} 발주서 미리보기</div>
                                            <div style={{ color:'#71717a', fontSize:'11px', marginTop:'2px' }}>{localResult.fileName} · {localResult.rows.length}건 · 셀을 클릭해 직접 수정할 수 있습니다</div>
                                        </div>
                                        <div style={{ display:'flex', gap:'8px', alignItems:'center' }}>
                                            <button onClick={addOrderRow} style={{ background:'#16a34a', color:'#fff', fontWeight:700, fontSize:'11px', padding:'6px 14px', borderRadius:'8px', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:'4px' }}>
                                                <PlusCircleIcon className="w-3.5 h-3.5" /> 행 추가
                                            </button>
                                            <button onClick={handleDownloadOrder} style={{ background:'#6366f1', color:'#fff', fontWeight:700, fontSize:'11px', padding:'6px 14px', borderRadius:'8px', border:'none', cursor:'pointer' }}>
                                                다운로드
                                            </button>
                                            <button onClick={() => setShowOrderPreview(false)} style={{ background:'#27272a', color:'#a1a1aa', fontWeight:700, fontSize:'11px', padding:'6px 14px', borderRadius:'8px', border:'1px solid #3f3f46', cursor:'pointer' }}>
                                                닫기
                                            </button>
                                        </div>
                                    </div>
                                    <div style={{ overflowX:'auto', overflowY:'auto', flex:1, borderRadius:'8px', border:'1px solid #27272a' }}>
                                        <table style={{ borderCollapse:'collapse', fontSize:'11px', whiteSpace:'nowrap', width:'100%' }}>
                                            <thead>
                                                <tr style={{ background:'#27272a', position:'sticky', top:0 }}>
                                                    <th style={{ padding:'6px 10px', color:'#71717a', fontWeight:700, borderRight:'1px solid #3f3f46', textAlign:'center', minWidth:'32px' }}>#</th>
                                                    {previewHeaders.map((h, i) => (
                                                        <th key={i} style={{ padding:'6px 10px', color:'#a1a1aa', fontWeight:700, borderRight:'1px solid #3f3f46', textAlign:'left' }}>{h}</th>
                                                    ))}
                                                    <th style={{ padding:'6px 10px', color:'#71717a', fontWeight:700, textAlign:'center', minWidth:'32px' }}></th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {localResult.rows.map((row, ri) => (
                                                    <tr key={ri} style={{ borderBottom:'1px solid #27272a', background: ri % 2 === 0 ? 'transparent' : 'rgba(39,39,42,0.4)' }}>
                                                        <td style={{ padding:'5px 10px', color:'#52525b', textAlign:'center', borderRight:'1px solid #27272a' }}>{ri + 1}</td>
                                                        {previewHeaders.map((_, ci) => (
                                                            <td key={ci} style={{ padding:0, borderRight:'1px solid #27272a', maxWidth:'220px' }}>
                                                                <input
                                                                    value={row[ci] ?? ''}
                                                                    onChange={e => updateOrderCell(ri, ci, e.target.value)}
                                                                    style={{ width:'100%', boxSizing:'border-box', background:'transparent', border:'none', outline:'none', color:'#e4e4e7', padding:'5px 10px', fontSize:'11px', fontFamily:'inherit' }}
                                                                />
                                                            </td>
                                                        ))}
                                                        <td style={{ padding:'5px 6px', textAlign:'center' }}>
                                                            <button onClick={() => removeOrderRow(ri)} title="행 삭제" style={{ background:'transparent', border:'none', cursor:'pointer', color:'#ef4444', display:'inline-flex', alignItems:'center' }}>
                                                                <TrashIcon className="w-3.5 h-3.5" />
                                                            </button>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </>
                            );
                        })()}
                    </div>
                </div>,
                document.body
            )}

            {/* 업체 영구 메모 팝업 (발주서 다운로드 전 확인) */}
            {pendingDownloadAction && createPortal(
                <div
                    style={{ position:'fixed', top:0, left:0, right:0, bottom:0, zIndex:99999, display:'flex', alignItems:'center', justifyContent:'center', backgroundColor:'rgba(0,0,0,0.75)' }}
                    onClick={() => setPendingDownloadAction(null)}
                >
                    <div
                        style={{ background:'#1c1c1e', borderRadius:'16px', padding:'28px 28px 20px', maxWidth:'420px', width:'90%', border:'2px solid rgba(251,146,60,0.5)', boxShadow:'0 25px 60px rgba(0,0,0,0.6)' }}
                        onClick={e => e.stopPropagation()}
                    >
                        <div style={{ color:'#fb923c', fontWeight:900, fontSize:'11px', letterSpacing:'0.08em', textTransform:'uppercase', marginBottom:'6px', opacity:0.7 }}>
                            [{companyName}] 업체 메모
                        </div>
                        <pre style={{ color:'#fed7aa', fontSize:'14px', fontWeight:600, whiteSpace:'pre-wrap', lineHeight:1.6, margin:'0 0 20px', fontFamily:'inherit' }}>
                            {sessionMemo}
                        </pre>
                        <div style={{ display:'flex', gap:'10px' }}>
                            <button
                                onClick={() => { const action = pendingDownloadAction; setPendingDownloadAction(null); action(); }}
                                style={{ flex:1, background:'rgba(251,146,60,0.2)', color:'#fb923c', fontWeight:900, fontSize:'12px', padding:'10px', borderRadius:'10px', border:'1px solid rgba(251,146,60,0.4)', cursor:'pointer' }}
                            >
                                확인 후 다운로드
                            </button>
                            <button
                                onClick={() => setPendingDownloadAction(null)}
                                style={{ padding:'10px 18px', color:'#71717a', fontSize:'12px', fontWeight:700, background:'transparent', border:'none', cursor:'pointer' }}
                            >
                                취소
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}

            {/* 수동발주 선택 모달 */}
            {showManualOrderModal && createPortal(
                <div
                    style={{ position:'fixed', top:0, left:0, right:0, bottom:0, zIndex:99999, display:'flex', alignItems:'center', justifyContent:'center', backgroundColor:'rgba(0,0,0,0.7)' }}
                    onClick={handleManualOrderModalCancel}
                >
                    <div
                        style={{ background:'#27272a', borderRadius:'16px', padding:'24px', maxWidth:'400px', width:'90%', border:'2px solid #f43f5e', boxShadow:'0 25px 50px rgba(0,0,0,0.5)' }}
                        onClick={e => e.stopPropagation()}
                    >
                        <div style={{ color:'#fff', fontWeight:700, fontSize:'14px', marginBottom:'4px' }}>[{companyName}] 수동발주 포함</div>
                        <div style={{ color:'#a1a1aa', fontSize:'11px', marginBottom:'16px' }}>발주서에 포함할 수동발주를 선택하세요</div>
                        <div style={{ maxHeight:'240px', overflowY:'auto', marginBottom:'16px', display:'flex', flexDirection:'column', gap:'6px' }}>
                            {manualOrders.map(o => (
                                <label
                                    key={o.id}
                                    style={{ display:'flex', alignItems:'center', gap:'10px', padding:'10px 12px', borderRadius:'12px', cursor:'pointer', border: modalSelectedIds.has(o.id) ? '1px solid rgba(244,63,94,0.4)' : '1px solid #3f3f46', background: modalSelectedIds.has(o.id) ? 'rgba(244,63,94,0.1)' : 'rgba(63,63,70,0.3)', opacity: modalSelectedIds.has(o.id) ? 1 : 0.6 }}
                                >
                                    <input type="checkbox" checked={modalSelectedIds.has(o.id)} onChange={() => setModalSelectedIds(prev => { const next = new Set(prev); if (next.has(o.id)) next.delete(o.id); else next.add(o.id); return next; })} style={{ width:'16px', height:'16px', accentColor:'#f43f5e', cursor:'pointer', flexShrink:0 }} />
                                    <div style={{ display:'flex', flexDirection:'column', minWidth:0 }}>
                                        <span style={{ fontSize:'12px', fontWeight:700, color:'#fff' }}>{o.recipientName}</span>
                                        <span style={{ fontSize:'10px', color:'#a1a1aa' }}>{o.productName} x{o.qty}</span>
                                    </div>
                                </label>
                            ))}
                        </div>
                        <div style={{ display:'flex', gap:'8px' }}>
                            <button onClick={handleManualOrderModalConfirm} style={{ flex:1, background:'#f43f5e', color:'#fff', fontWeight:700, fontSize:'12px', padding:'10px', borderRadius:'12px', border:'none', cursor:'pointer' }}>
                                {modalSelectedIds.size}건 포함
                            </button>
                            <button onClick={handleManualOrderModalCancel} style={{ padding:'10px 16px', color:'#a1a1aa', fontSize:'12px', fontWeight:700, background:'transparent', border:'none', cursor:'pointer' }}>
                                제외
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </>
    );
};

export default CompanyWorkstationRow;
