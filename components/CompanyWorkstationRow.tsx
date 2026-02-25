
import React, { useState, useEffect, useRef } from 'react';
import { useInvoiceMerger } from '../hooks/useInvoiceMerger';
import { useConsolidatedOrderConverter, ProcessedResult, getKeywordsForCompany } from '../hooks/useConsolidatedOrderConverter';
import {
    ArrowDownTrayIcon, CheckIcon, UploadIcon, BoltIcon,
    ChevronDownIcon, ChevronUpIcon, ArrowPathIcon, DocumentArrowUpIcon,
    PlusCircleIcon, TrashIcon
} from './icons';
import type { PricingConfig, ExcludedOrder, ManualOrder } from '../types';
import { useDailyWorkspace } from '../hooks/useFirestore';

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
    pricingConfig: PricingConfig;
    vendorFile: File | null;
    masterFile: File | null;
    isDetected: boolean;
    fakeOrderNumbers: string;
    manualOrders?: ManualOrder[];
    isSelected?: boolean;
    onSelectToggle?: (sessionId: string) => void;
    onVendorFileChange: (file: File | null) => void;
    onResultUpdate: (sessionId: string, totalPrice: number, excludedCount?: number, excludedDetails?: ExcludedOrder[]) => void;
    onDataUpdate: (sessionId: string, orderRows: any[][], invoiceRows: any[][], uploadInvoiceRows: any[][], summaryExcel: string, header?: any[]) => void;
    onAddSession: () => void;
    onRemoveSession: () => void;
    onAddAdjustment: (companyName: string, amount: string) => void;
}

const CompanyWorkstationRow: React.FC<CompanyWorkstationRowProps> = ({ 
    sessionId, companyName, roundNumber, isFirstSession, pricingConfig, vendorFile, masterFile, isDetected, fakeOrderNumbers, manualOrders = [],
    isSelected, onSelectToggle, onVendorFileChange, onResultUpdate, onDataUpdate, onAddSession, onRemoveSession, onAddAdjustment
}) => {
    const [showSummary, setShowSummary] = useState(false);
    const [showExcluded, setShowExcluded] = useState(false);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [copiedExcelId, setCopiedExcelId] = useState<string | null>(null);
    const [localResult, setLocalResult] = useState<ProcessedResult | null>(null);
    const [excludedList, setExcludedList] = useState<ExcludedOrder[]>([]);
    const [isLocalProcessing, setIsLocalProcessing] = useState(false);
    const [localFile, setLocalFile] = useState<File | null>(null);
    
    const { workspace, updateField } = useDailyWorkspace();

    // 수동 차감/추가 내역 상태
    const [adjAmount, setAdjAmount] = useState('');
    const [adjLabel, setAdjLabel] = useState('');
    const [sessionAdjustments, setSessionAdjustments] = useState<SessionAdjustment[]>([]);

    const [workflow, setWorkflow] = useState<WorkflowStatus>({ order: false, deposit: false, invoice: false });

    const lastProcessedMasterRef = useRef<File | null>(null);
    const lastFakeOrdersRef = useRef<string>('');
    const lastManualOrdersRef = useRef<string>('');

    const { status: mergeStatus, error: mergeError, processFiles, reset: resetMerge, results: mergeResults } = useInvoiceMerger();
    const { processSingleCompanyFile } = useConsolidatedOrderConverter(pricingConfig);

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
    }, [workflow, sessionId]);

    // sessionAdjustments 변경 → Firestore에 저장
    const isInitialAdjLoad = useRef(true);
    useEffect(() => {
        if (isInitialAdjLoad.current) { isInitialAdjLoad.current = false; return; }
        const currentStr = JSON.stringify(sessionAdjustments);
        if (currentStr === lastFirestoreAdjRef.current) return;
        const currentAdjs = workspace?.sessionAdjustments || {};
        updateField('sessionAdjustments', { ...currentAdjs, [sessionId]: sessionAdjustments });
    }, [sessionAdjustments, sessionId]);

    const [debugInfo, setDebugInfo] = useState<string>('');

    useEffect(() => {
        const manualOrdersStr = JSON.stringify(manualOrders);
        const hasFileChanged = isFirstSession && masterFile && isDetected && masterFile !== lastProcessedMasterRef.current;
        const hasFakeOrdersChanged = isFirstSession && fakeOrderNumbers !== lastFakeOrdersRef.current;
        const hasManualOrdersChanged = isFirstSession && manualOrdersStr !== lastManualOrdersRef.current;

        const debugMsg = `[${companyName}] isFirst=${isFirstSession}, masterFile=${!!masterFile}, isDetected=${isDetected}, fileChanged=${!!hasFileChanged}, fakeChanged=${hasFakeOrdersChanged}, manualChanged=${hasManualOrdersChanged}, lastRef=${!!lastProcessedMasterRef.current}`;
        console.log(`[DEBUG] 자동트리거: ${debugMsg}`);
        setDebugInfo(`감지=${isDetected ? '✓' : '✗'} | 파일=${!!masterFile ? '✓' : '✗'} | 트리거=${(hasFileChanged || hasFakeOrdersChanged || hasManualOrdersChanged) ? '✓' : '✗'}`);

        if (hasFileChanged) {
            if (masterFile) {
                lastProcessedMasterRef.current = masterFile;
                lastFakeOrdersRef.current = fakeOrderNumbers;
                lastManualOrdersRef.current = manualOrdersStr;
                handleLocalFileChange(masterFile);
            }
        } else if ((hasFakeOrdersChanged || hasManualOrdersChanged) && lastProcessedMasterRef.current) {
            // 가구매/수동주문 변경: 이미 파일 처리가 된 이후에만 재처리
            lastFakeOrdersRef.current = fakeOrderNumbers;
            lastManualOrdersRef.current = manualOrdersStr;
            handleLocalFileChange(lastProcessedMasterRef.current);
        } else {
            // Firestore 초기 로드 등 - ref만 업데이트 (재처리 안함)
            lastFakeOrdersRef.current = fakeOrderNumbers;
            lastManualOrdersRef.current = manualOrdersStr;
        }
    }, [masterFile, isDetected, isFirstSession, fakeOrderNumbers, manualOrders]);

    useEffect(() => {
        if (onResultUpdate) {
            const orderTotal = localResult ? Object.values(localResult.summary).reduce((a: number, b: any) => a + (b.totalPrice || 0), 0) : 0;
            const adjTotal = sessionAdjustments.reduce((a, b) => a + b.amount, 0);
            onResultUpdate(sessionId, orderTotal + adjTotal, excludedList.length, excludedList);
        }
        if (onDataUpdate) {
            onDataUpdate(
                sessionId, 
                localResult?.rows || [], 
                mergeResults?.rows || [], 
                mergeResults?.uploadRows || [], 
                localResult?.depositSummaryExcel || '',
                mergeResults?.header
            );
        }
    }, [localResult, mergeResults, excludedList, sessionId, onResultUpdate, onDataUpdate, sessionAdjustments]);

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
    const handleLocalFileChange = async (file: File) => {
        if (isProcessingRef.current) return;
        isProcessingRef.current = true;
        if (file && file !== masterFile) setLocalFile(file);
        setIsLocalProcessing(true);
        try {
            const processResponse = await processSingleCompanyFile(file, companyName, fakeOrderNumbers, manualOrders);
            if (processResponse) {
                setLocalResult(processResponse.result);
                setExcludedList(processResponse.excluded);
            } else {
                setLocalResult(null);
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
            processFiles(vendorFile, activeFile, companyName, false);
        }
    };

    const resetLocalFile = () => { 
        setLocalFile(null); 
        setLocalResult(null); 
        setExcludedList([]);
        resetMerge(); 
        onResultUpdate(sessionId, 0, 0, []);
    };

    const handleDownloadOrder = () => localResult && XLSX.writeFile(localResult.workbook, localResult.fileName);
    const handleDownloadInvoice = (type: 'mgmt' | 'upload') => {
        if (!mergeResults) return;
        if (type === 'mgmt') XLSX.writeFile(mergeResults.mgmtWorkbook, mergeResults.mgmtFileName);
        else XLSX.writeFile(mergeResults.uploadWorkbook, mergeResults.uploadFileName);
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

    const currentStat = mergeResults?.companyStats?.[companyName];
    const keywords = getKeywordsForCompany(companyName);
    const deadline = pricingConfig[companyName]?.deadline;
    const isAllDone = workflow.order && workflow.deposit && workflow.invoice;

    return (
        <>
            <tr className={`transition-all duration-300 border-none ${isAllDone ? 'bg-emerald-950/20' : (workflow.order || workflow.deposit || workflow.invoice) ? 'bg-zinc-900/40' : 'bg-transparent hover:bg-zinc-800/10'}`}>
                <td className="px-6 py-4 min-w-[360px]">
                    <div className="flex flex-col gap-2">
                        {isFirstSession ? (
                            <>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <div className={`font-black text-xl tracking-tighter whitespace-nowrap transition-colors ${isAllDone ? 'text-emerald-400' : 'text-white'}`}>
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

                                <div className="flex flex-wrap gap-1">
                                    {keywords.map(kw => (
                                        <span key={kw} className="text-[9px] bg-zinc-900/80 text-zinc-500 px-1.5 py-0.5 rounded border border-zinc-800 font-bold tracking-tight">
                                            {kw}
                                        </span>
                                    ))}
                                </div>
                                {debugInfo && (
                                    <div className="text-[8px] text-amber-600 font-mono bg-amber-950/20 px-2 py-0.5 rounded border border-amber-900/30">
                                        {debugInfo}
                                    </div>
                                )}
                            </>
                        ) : (
                            <div className="flex items-center gap-2 pl-4 border-l-2 border-zinc-800 py-1">
                                <span className="text-zinc-700 text-[12px] font-black">ㄴ</span>
                                <div className="bg-indigo-500/10 text-indigo-400 px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border border-indigo-500/20 whitespace-nowrap">
                                    {roundNumber}차 추가 발주
                                </div>
                                <button onClick={onRemoveSession} className="text-zinc-800 hover:text-red-500 transition-colors p-1">
                                    <TrashIcon className="w-4 h-4" />
                                </button>
                            </div>
                        )}
                    </div>
                </td>

                <td className="px-6 py-4 text-center">
                    <div className="flex flex-col items-center gap-2">
                        {localResult ? (
                            <div className="flex flex-col items-center gap-2 animate-fade-in w-full">
                                <div className="flex items-center justify-center gap-4">
                                    <div className="text-center">
                                        <div className="text-rose-500 font-black text-xl">{Object.values(localResult.summary).reduce((a:any, b:any) => a + b.count, 0)}</div>
                                        <div className="text-zinc-600 font-black text-[9px] uppercase tracking-widest">Orders</div>
                                    </div>
                                    <div className="h-6 w-px bg-zinc-800" />
                                    <button onClick={handleDownloadOrder} className="bg-white text-zinc-950 px-3 py-1 rounded font-black text-[10px] hover:bg-rose-50 shadow-md flex items-center gap-1.5 transition-all"><ArrowDownTrayIcon className="w-3.5 h-3.5" /><span>받기</span></button>
                                </div>
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
                        ) : (
                            <label className="flex items-center gap-2 cursor-pointer px-4 py-1.5 rounded-lg text-[10px] font-black border border-zinc-800 bg-zinc-900/30 text-zinc-500 hover:border-indigo-500/40 hover:text-indigo-400 transition-all shadow-inner whitespace-nowrap">
                                <DocumentArrowUpIcon className="w-4 h-4 text-zinc-700" />
                                <span>발주서 업로드</span>
                                <input type="file" className="sr-only" accept=".xlsx,.xls" onChange={(e) => e.target.files?.[0] && handleLocalFileChange(e.target.files[0])} />
                            </label>
                        )}
                    </div>
                </td>

                <td className="px-6 py-4">
                    <div className="flex flex-col items-center gap-2">
                        {!mergeResults ? (
                            <div className="flex flex-col items-center gap-2">
                                <label className={`flex items-center gap-2 cursor-pointer px-4 py-1.5 rounded-lg text-[10px] font-black border transition-all shadow-md whitespace-nowrap ${vendorFile ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-400' : 'bg-zinc-800/40 border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300'}`}>
                                    <UploadIcon className="w-4 h-4" />
                                    <span>{mergeStatus === 'processing' ? '매칭 중...' : vendorFile ? '송장 업로드됨' : '송장 선택'}</span>
                                    <input type="file" className="sr-only" accept=".xlsx,.xls" onChange={(e) => { const file = e.target.files?.[0]; if (file) { resetMerge(); onVendorFileChange(file); } }} />
                                </label>
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
                            </div>
                        )}
                    </div>
                </td>
            </tr>

            {showExcluded && excludedList.length > 0 && (
                <tr className="bg-rose-950/10 border-none animate-fade-in">
                    <td colSpan={3} className="px-6 py-4">
                        <div className="bg-zinc-900/80 p-4 rounded-xl border border-rose-900/30 shadow-xl">
                            <h5 className="text-rose-500 font-black text-[10px] uppercase tracking-widest mb-3">제외된 주문</h5>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                {excludedList.map((f, idx) => (
                                    <div key={idx} className="bg-zinc-950/80 p-2.5 rounded-lg border border-rose-900/20 flex flex-col gap-1">
                                        <div className="flex justify-between items-center">
                                            <span className="text-zinc-200 font-bold text-[12px]">{f.recipientName}</span>
                                            <span className="text-[8px] bg-rose-500/20 text-rose-400 px-1.5 py-0.5 rounded font-black">EXCLUDED</span>
                                        </div>
                                        <div className="text-zinc-500 text-[10px] font-mono truncate">{f.productName}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </td>
                </tr>
            )}

            {showSummary && localResult && (
                <tr className="bg-zinc-950/40 border-none animate-fade-in">
                    <td colSpan={3} className="px-6 py-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="bg-zinc-900/60 p-4 rounded-xl border border-zinc-800 shadow-xl relative">
                                <div className="flex justify-between items-center mb-3">
                                    <h5 className="text-zinc-500 font-black text-[10px] uppercase tracking-widest">정산 요약</h5>
                                    <div className="flex gap-1.5">
                                        <button onClick={() => handleCopy(sessionId, localResult.depositSummary, 'kakao')} className={`text-[9px] font-black px-2 py-1 rounded border transition-all ${copiedId === sessionId ? 'bg-emerald-500 text-white border-emerald-400' : 'bg-zinc-800 text-rose-400 border-zinc-700 hover:text-white'}`}>{copiedId === sessionId ? '복사됨!' : '카톡용'}</button>
                                        <button onClick={() => handleCopy(sessionId, localResult.depositSummaryExcel, 'excel')} className={`text-[9px] font-black px-2 py-1 rounded border transition-all ${copiedExcelId === sessionId ? 'bg-emerald-500 text-white border-emerald-400' : 'bg-zinc-800 text-indigo-400 border-zinc-700 hover:text-white'}`}>{copiedExcelId === sessionId ? '복사됨!' : '엑셀용'}</button>
                                    </div>
                                </div>
                                <pre className="text-[12px] font-mono text-zinc-200 whitespace-pre-wrap leading-tight bg-zinc-950/50 p-4 rounded-lg border border-zinc-800/50 max-h-[300px] overflow-auto custom-scrollbar">
                                    {(() => {
                                        const orderTotal = localResult ? Object.values(localResult.summary).reduce((a: number, b: any) => a + (b.totalPrice || 0), 0) : 0;
                                        const adjTotal = sessionAdjustments.reduce((a, b) => a + b.amount, 0);
                                        let text = localResult.depositSummary;
                                        if (sessionAdjustments.length > 0) {
                                            const adjRows = sessionAdjustments.map(a => `${a.label}\t${a.amount.toLocaleString()}원`).join('\n');
                                            text = text.replace('총 합계', `[추가/차감 내역]\n${adjRows}\n\n총 합계`)
                                                       .replace(/(총 합계\s+)([\d,]+)(원)/, (match, p1, p2, p3) => {
                                                           return `${p1}${(orderTotal + adjTotal).toLocaleString()}${p3}`;
                                                       });
                                        }
                                        return text;
                                    })()}
                                </pre>
                            </div>
                            <div className="bg-zinc-900/60 p-4 rounded-xl border border-zinc-800 shadow-xl">
                                <h5 className="text-zinc-500 font-black text-[10px] uppercase tracking-widest mb-3">품목별 합계</h5>
                                <div className="space-y-1.5 max-h-[300px] overflow-auto custom-scrollbar pr-1.5">
                                    {Object.entries(localResult.summary).map(([key, val]: any) => (
                                        <div key={key} className="flex justify-between items-center bg-zinc-950/80 p-2.5 rounded border border-zinc-800/50">
                                            <span className="text-zinc-300 font-bold text-sm">{key}</span>
                                            <div className="flex gap-4">
                                                <span className="text-zinc-500 font-black text-[11px]">{val.count}건</span>
                                                <span className="text-rose-500 font-black text-[11px]">{val.totalPrice.toLocaleString()}원</span>
                                            </div>
                                        </div>
                                    ))}
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
