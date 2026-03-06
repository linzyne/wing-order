
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import CompanyWorkstationRow from './CompanyWorkstationRow';
import FileUpload from './FileUpload';
import type { PricingConfig, ManualOrder, ExcludedOrder } from '../types';
import { BuildingStorefrontIcon, ArrowDownTrayIcon, TrashIcon, PlusCircleIcon, BoltIcon, ClipboardDocumentCheckIcon, ArrowPathIcon, ChevronDownIcon, ChevronUpIcon, CheckIcon, PhoneIcon, DocumentCheckIcon } from './icons';
import { getKeywordsForCompany } from '../hooks/useConsolidatedOrderConverter';
import { saveDailySales } from '../hooks/useSalesTracker';
import { useDailyWorkspace } from '../hooks/useFirestore';

declare var XLSX: any;

const getTimeScore = (timeStr?: string): number => {
    if (!timeStr) return 9999;
    const [hh, mm] = timeStr.split(':').map(Number);
    return hh * 60 + mm;
};

const PREFERRED_ORDER = ['연두', '웰그린', '고랭지김치', '답도', '제이제이', '신선마켓', '귤_제주', '귤_초록', '홍게', '꽃게', '황금향', '귤'];

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

interface CompanySelectorProps { pricingConfig: PricingConfig; }

const CompanySelector: React.FC<CompanySelectorProps> = ({ pricingConfig }) => {
    const { workspace, updateField, isReady } = useDailyWorkspace();

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

    const [masterOrderFile, setMasterOrderFile] = useState<File | null>(null);
    const [detectedCompanies, setDetectedCompanies] = useState<Set<string>>(new Set());

    const [isBulkMode, setIsBulkMode] = useState(false);
    const [bulkText, setBulkText] = useState('');

    const [manualOrders, setManualOrders] = useState<ManualOrder[]>([]);
    const [manualInput, setManualInput] = useState({
        companyName: '', recipientName: '', phone: '', address: '', productName: '', qty: '1'
    });

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

    const [manualTransfers, setManualTransfers] = useState<ManualTransfer[]>([]);

    const [newTransfer, setNewTransfer] = useState({ label: '', bankName: '', accountNumber: '', amount: '' });

    // Firestore 동기화 - 값 비교로 에코 방지
    const lastWrittenFakeRef = useRef('');
    const lastWrittenTransfersRef = useRef('[]');

    useEffect(() => {
        if (!workspace) return;
        if (workspace.fakeOrderInput !== undefined && workspace.fakeOrderInput !== lastWrittenFakeRef.current) {
            setFakeOrderInput(workspace.fakeOrderInput);
            lastWrittenFakeRef.current = workspace.fakeOrderInput;
        }
        if (workspace.manualTransfers !== undefined) {
            const wsStr = JSON.stringify(workspace.manualTransfers);
            if (wsStr !== lastWrittenTransfersRef.current) {
                setManualTransfers(workspace.manualTransfers);
                lastWrittenTransfersRef.current = wsStr;
            }
        }
    }, [workspace]);

    // fakeOrderInput 변경 → Firestore에 debounce로 저장
    const fakeOrderDebounceRef = useRef<ReturnType<typeof setTimeout>>();
    useEffect(() => {
        if (!isReady) return;
        if (fakeOrderInput === lastWrittenFakeRef.current) return;
        if (fakeOrderDebounceRef.current) clearTimeout(fakeOrderDebounceRef.current);
        fakeOrderDebounceRef.current = setTimeout(() => {
            lastWrittenFakeRef.current = fakeOrderInput;
            updateField('fakeOrderInput', fakeOrderInput);
        }, 300);
        return () => { if (fakeOrderDebounceRef.current) clearTimeout(fakeOrderDebounceRef.current); };
    }, [fakeOrderInput, isReady]);

    // manualTransfers 변경 → Firestore에 저장
    useEffect(() => {
        if (!isReady) return;
        const currentStr = JSON.stringify(manualTransfers);
        if (currentStr === lastWrittenTransfersRef.current) return;
        lastWrittenTransfersRef.current = currentStr;
        updateField('manualTransfers', manualTransfers);
    }, [manualTransfers, isReady]);

    // 가구매 명단 분석 (입력된 번호 vs 실제 발견된 번호)
    const fakeOrderAnalysis = useMemo(() => {
        const inputNumbers = new Set<string>();
        fakeOrderInput.split('\n').forEach(line => {
            const matches = line.match(/[A-Z0-9-]{5,}/g);
            if (matches) matches.forEach(m => inputNumbers.add(m.trim()));
        });

        const foundDetails: Record<string, ExcludedOrder> = {};
        (Object.values(allExcludedDetails).flat() as ExcludedOrder[]).forEach(ex => {
            const cleanNum = ex.orderNumber.replace(' (제외)', '').trim();
            foundDetails[cleanNum] = ex;
        });

        const matched = Array.from(inputNumbers).filter(num => !!foundDetails[num]);
        const missing = Array.from(inputNumbers).filter(num => !foundDetails[num]);

        return { inputNumbers, matched, missing, foundDetails };
    }, [fakeOrderInput, allExcludedDetails]);

    const handleMasterUpload = async (file: File) => {
        setMasterOrderFile(file);
        try {
            const data = await file.arrayBuffer();
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
            if (!json || json.length < 2) return;
            const groupColIdx = 10;
            const companiesInFile = new Set<string>();
            const companyKeywordsMap = new Map<string, string[]>();
            Object.keys(pricingConfig).forEach(name => companyKeywordsMap.set(name, getKeywordsForCompany(name)));
            for (let i = 1; i < json.length; i++) {
                const groupVal = String(json[i][groupColIdx] || '').replace(/\s+/g, '');
                if (!groupVal) continue;
                for (const [name, keywords] of companyKeywordsMap.entries()) {
                    const isMatched = keywords.some(k => groupVal.includes(k.replace(/\s+/g, '')));
                    if (isMatched) { companiesInFile.add(name); break; }
                }
            }
            // 디버그: Column 10 고유값 수집
            const uniqueGroupVals = new Set<string>();
            for (let i = 1; i < json.length; i++) {
                const v = String(json[i][groupColIdx] || '').trim();
                if (v) uniqueGroupVals.add(v);
            }
            console.log(`[DEBUG][감지] Column 10 고유값: ${JSON.stringify([...uniqueGroupVals])}`);
            console.log(`[DEBUG][감지] 업체-키워드 맵: ${JSON.stringify([...companyKeywordsMap.entries()])}`);
            console.log(`[DEBUG][감지] 감지된 업체: ${JSON.stringify([...companiesInFile])}`);
            setDetectedCompanies(companiesInFile);
        } catch (error) { console.error("Master upload analysis failed:", error); }
    };

    const clearMasterFile = () => { setMasterOrderFile(null); setDetectedCompanies(new Set()); };

    const handleLotteFileUpload = async (file: File) => {
        if (!masterOrderFile) { alert('원본 주문서를 먼저 업로드해주세요.'); return; }
        setLotteFile(file);
        setLotteResult(null);
        try {
            // 가구매 명단에서 주문번호 추출
            const fakeOrderNums = new Set<string>();
            fakeOrderInput.split('\n').forEach(line => {
                const matches = line.match(/[A-Z0-9-]{5,}/g);
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
            let matchedCount = 0;
            const notFoundOrders: string[] = [];
            for (let i = 1; i < masterAoa.length; i++) {
                const row = masterAoa[i];
                if (!row) continue;
                const orderNum = String(row[2] || '').trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
                if (!fakeOrderNums.has(orderNum)) continue;
                const tracking = trackingMap.get(orderNum);
                if (tracking) {
                    while (row.length < 5) row.push('');
                    row[3] = '롯데택배';
                    row[4] = tracking;
                    matchedCount++;
                } else {
                    notFoundOrders.push(String(row[2] || ''));
                }
            }

            setLotteResult({ matched: matchedCount, total: fakeOrderNums.size, notFound: notFoundOrders });

            // 수정된 원본 주문서 다운로드
            const newWs = XLSX.utils.aoa_to_sheet(masterAoa);
            const newWb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(newWb, newWs, '주문서');
            const dateStr = new Date().toISOString().slice(0, 10);
            XLSX.writeFile(newWb, `${dateStr}_가구매_운송장입력완료.xlsx`);
        } catch (err: any) {
            console.error('롯데택배 처리 오류:', err);
            alert('롯데택배 파일 처리 중 오류가 발생했습니다: ' + err.message);
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
        setVendorFiles(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
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
        setVendorFiles(prev => { const n = { ...prev }; delete n[sessionId]; return n; });
        setSelectedSessionIds(prev => { const next = new Set(prev); next.delete(sessionId); return next; });
    };

    const handleVendorFileChange = (sessionId: string, file: File | null) => {
        setVendorFiles(prev => {
            const newState = { ...prev };
            if (file) newState[sessionId] = file; else delete newState[sessionId];
            return newState;
        });
    };

    const handleResultUpdate = useCallback((sessionId: string, totalPrice: number, excludedCount: number = 0, excludedDetails: ExcludedOrder[] = []) => {
        setTotalsMap(prev => ({ ...prev, [sessionId]: totalPrice }));
        setExcludedCountsMap(prev => ({ ...prev, [sessionId]: excludedCount }));
        setAllExcludedDetails(prev => ({ ...prev, [sessionId]: excludedDetails }));
    }, []);

    const handleDataUpdate = useCallback((sessionId: string, orderRows: any[][], invoiceRows: any[][], uploadInvoiceRows: any[][], summaryExcel: string, header?: any[]) => {
        setAllOrderRows(prev => ({ ...prev, [sessionId]: orderRows }));
        setAllInvoiceRows(prev => ({ ...prev, [sessionId]: invoiceRows }));
        setAllUploadInvoiceRows(prev => ({ ...prev, [sessionId]: uploadInvoiceRows }));
        if (header) setAllHeaders(prev => ({ ...prev, [sessionId]: header }));
        setAllSummaries(prev => ({ ...prev, [sessionId]: summaryExcel }));
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
        const sortedCompanyNames = Object.keys(pricingConfig).sort((a, b) => {
            const deadlineA = pricingConfig[a]?.deadline;
            const deadlineB = pricingConfig[b]?.deadline;
            if (deadlineA || deadlineB) return getTimeScore(deadlineA) - getTimeScore(deadlineB);
            const indexA = PREFERRED_ORDER.indexOf(a), indexB = PREFERRED_ORDER.indexOf(b);
            if (indexA !== -1 && indexB !== -1) return indexA - indexB;
            return indexA !== -1 ? -1 : indexB !== -1 ? 1 : a.localeCompare(b);
        });
        sortedCompanyNames.forEach(name => {
            const sessions = companySessions[name] || [];
            const config = pricingConfig[name];
            sessions.forEach(s => {
                if (!selectedSessionIds.has(s.id)) return;
                const amount = totalsMap[s.id] || 0;
                if (amount > 0) { depositRows.push([config?.bankName || '은행미지정', config?.accountNumber || '계좌미지정', amount, `${name}(${s.round}차)`]); total += amount; }
            });
        });
        manualTransfers.forEach(t => { depositRows.push([t.bankName, t.accountNumber, t.amount, t.label]); total += t.amount; });
        if (depositRows.length === 0) { alert('선택된 업체 중 입금할 내역이 없습니다.'); return; }
        depositRows.push([], ['', '합계', total]);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(depositRows), "입금내역");
        XLSX.writeFile(wb, `${new Date().toISOString().slice(0, 10)}_입금목록.xlsx`);
    };

    const handleDownloadWorkLog = () => {
        const wb = XLSX.utils.book_new();
        const summarySheetData: any[][] = [];
        const sortedCompanyNames = Object.keys(pricingConfig).sort((a, b) => {
            const deadlineA = pricingConfig[a]?.deadline;
            const deadlineB = pricingConfig[b]?.deadline;
            if (deadlineA || deadlineB) return getTimeScore(deadlineA) - getTimeScore(deadlineB);
            const indexA = PREFERRED_ORDER.indexOf(a), indexB = PREFERRED_ORDER.indexOf(b);
            if (indexA !== -1 && indexB !== -1) return indexA - indexB;
            return indexA !== -1 ? -1 : indexB !== -1 ? 1 : a.localeCompare(b);
        });
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
        const marginSheetData: any[][] = [['업체명', '품목명', '수량', '판매가', '공급가', '마진(개당)', '총마진']];
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
                        marginSheetData.push([marginCurrentCompany, productName, count, sellingPrice, supplyPrice, margin, margin * count]);
                    }
                }
            }
        }
        if (marginSheetData.length > 1) {
            const totalMargin = marginSheetData.slice(1).reduce((sum: number, r: any[]) => sum + (r[6] || 0), 0);
            marginSheetData.push([]);
            marginSheetData.push(['', '', '', '', '', '총 마진', totalMargin]);
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(marginSheetData), "마진시트");
        }

        const todayDate = new Date().toISOString().slice(0, 10);
        XLSX.writeFile(wb, `${todayDate}_업무일지.xlsx`);
        // 매출현황 자동 저장 (발주/송장/입금 데이터 포함)
        saveDailySales(todayDate, allSummaries, totalsMap, pricingConfig, companySessions, {
            orderRows: orderSheetData.length > 0 ? orderSheetData : undefined,
            invoiceRows: invoiceSheetData.length > 0 ? invoiceSheetData : undefined,
            depositRecords: depositRows.filter(r => r.length >= 3 && r[0] !== '' && r[1] !== '합계').map(r => ({
                bankName: String(r[0] || ''),
                accountNumber: String(r[1] || ''),
                amount: typeof r[2] === 'number' ? r[2] : parseInt(String(r[2]).replace(/[,원\s]/g, '')) || 0,
            })),
            depositTotal: depTotal > 0 ? depTotal : undefined,
        });
    };

    const grandTotal = (Object.values(totalsMap) as number[]).reduce((a: number, b: number) => a + b, 0) + 
                       manualTransfers.reduce((a: number, b: ManualTransfer) => a + b.amount, 0);

    const isAllSelected = selectedSessionIds.size > 0 && selectedSessionIds.size === (Object.values(companySessions).flat() as SessionData[]).length;

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <section className="lg:col-span-2 bg-zinc-900/60 rounded-[2.5rem] p-6 border border-zinc-800 shadow-2xl backdrop-blur-md">
                    <div className="flex flex-col gap-6">
                        <div className="flex flex-col md:flex-row items-center gap-6">
                            <div className="flex-1 w-full">
                                <FileUpload 
                                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleMasterUpload(f); }}
                                    onDrop={(e) => { const f = e.dataTransfer.files?.[0]; if (f) handleMasterUpload(f); }}
                                />
                            </div>
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
                                </div>
                            )}
                        </div>
                        
                        <div className="bg-zinc-950/40 p-5 rounded-2xl border border-zinc-800/50">
                            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
                                <h3 className="text-zinc-400 font-black text-[10px] uppercase tracking-widest flex items-center gap-2">
                                    <PlusCircleIcon className="w-4 h-4 text-rose-500" />
                                    수동 발주 추가 (엑셀 양식 자동 맞춤)
                                </h3>
                                <div className="flex flex-wrap gap-2">
                                    <span className="text-zinc-600 text-[9px] font-black uppercase self-center mr-1">빠른 선택 :</span>
                                    {QUICK_RECIPIENTS.map(p => (
                                        <button key={p.name} type="button" onClick={() => handleQuickSelect(p)} className="px-3 py-1 bg-zinc-800 hover:bg-rose-500 hover:text-white border border-zinc-700 rounded-full text-[10px] font-black text-zinc-400 transition-all shadow-sm">{p.name}</button>
                                    ))}
                                </div>
                            </div>
                            <form onSubmit={handleAddManualOrder} className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                                <select value={manualInput.companyName} onChange={e => setManualInput({...manualInput, companyName: e.target.value})} className="bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none">
                                    <option value="">업체 선택</option>
                                    {Object.keys(pricingConfig).sort().map(name => <option key={name} value={name}>{name}</option>)}
                                </select>
                                <input placeholder="수령자" value={manualInput.recipientName} onChange={e => setManualInput({...manualInput, recipientName: e.target.value})} className="bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none" />
                                <input placeholder="전화번호" value={manualInput.phone} onChange={e => setManualInput({...manualInput, phone: e.target.value})} className="bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none" />
                                <input placeholder="주소" value={manualInput.address} onChange={e => setManualInput({...manualInput, address: e.target.value})} className="bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none" />
                                <input placeholder="품목명" value={manualInput.productName} onChange={e => setManualInput({...manualInput, productName: e.target.value})} className="bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none" />
                                <div className="flex gap-2">
                                    <input type="number" placeholder="수량" value={manualInput.qty} onChange={e => setManualInput({...manualInput, qty: e.target.value})} className="w-16 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-rose-500/30 outline-none" />
                                    <button type="submit" className="flex-1 bg-rose-500 hover:bg-rose-600 text-white font-black rounded-xl text-xs transition-all shadow-lg">추가</button>
                                </div>
                            </form>
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

                <section className="bg-zinc-900/60 rounded-[2.5rem] p-6 border border-zinc-800 shadow-2xl backdrop-blur-md relative overflow-hidden">
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
                                        <h4 className="text-rose-500 font-black text-[9px] uppercase mb-2 tracking-widest flex items-center gap-2">
                                            <span className="w-1.5 h-1.5 bg-rose-500 rounded-full animate-pulse" />
                                            ⚠️ 파일에서 찾지 못한 주문 (확인 필요)
                                        </h4>
                                        <div className="flex flex-wrap gap-1.5">
                                            {fakeOrderAnalysis.missing.map(num => (
                                                <div key={num} className="bg-rose-950/40 text-rose-400 border border-rose-500/20 px-2 py-1 rounded-lg text-[10px] font-mono flex flex-col gap-0.5">
                                                    <span>{num}</span>
                                                    <span className="text-[7px] text-rose-500/70 font-black uppercase">Not Found</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                <div>
                                    <h4 className="text-emerald-500 font-black text-[9px] uppercase mb-2 tracking-widest flex items-center gap-2">
                                        <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full" />
                                        ✅ 정상 제외 완료 ({fakeOrderAnalysis.matched.length}건)
                                    </h4>
                                    <div className="grid grid-cols-1 gap-1.5">
                                        {fakeOrderAnalysis.matched.map(num => {
                                            const detail = fakeOrderAnalysis.foundDetails[num];
                                            return (
                                                <div key={num} className="flex items-center justify-between bg-zinc-900/50 p-2 rounded-xl border border-zinc-800/50">
                                                    <div className="flex flex-col">
                                                        <span className="text-[10px] font-mono text-zinc-400">{num}</span>
                                                        <span className="text-[8px] text-zinc-600 font-bold">{detail.productName}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-[10px] font-black text-white">{detail.recipientName}</span>
                                                        <span className="text-[8px] bg-zinc-800 text-emerald-500 px-2 py-0.5 rounded-full font-black border border-emerald-500/20">{detail.companyName}</span>
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
                        <div className="space-y-3 animate-fade-in">
                            <textarea
                                autoFocus value={fakeOrderInput} onChange={(e) => setFakeOrderInput(e.target.value)}
                                placeholder="예: 홍길동 20231010-00001"
                                className="w-full h-24 bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-[11px] font-mono text-zinc-300 focus:outline-none focus:border-rose-500/50 resize-none custom-scrollbar"
                            />
                            <div className="flex items-center gap-2">
                                <label className={`flex-1 flex items-center justify-center gap-2 cursor-pointer px-4 py-2.5 rounded-xl text-[10px] font-black border transition-all shadow-md ${lotteFile ? 'bg-indigo-950/30 border-indigo-500/30 text-indigo-400' : 'bg-zinc-900/50 border-zinc-700 text-zinc-500 hover:border-indigo-500/40 hover:text-indigo-400'}`}>
                                    <ArrowDownTrayIcon className="w-4 h-4" />
                                    <span>{lotteFile ? lotteFile.name : '롯데택배 파일 업로드'}</span>
                                    <input type="file" className="sr-only" accept=".xlsx,.xls" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleLotteFileUpload(f); }} />
                                </label>
                                {lotteFile && (
                                    <button onClick={() => { setLotteFile(null); setLotteResult(null); }} className="p-2 bg-zinc-900 rounded-xl text-zinc-700 hover:text-rose-500 border border-zinc-800 transition-colors">
                                        <ArrowPathIcon className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </div>
                            {lotteResult && (
                                <div className="bg-zinc-950/80 p-3 rounded-xl border border-zinc-800 animate-fade-in">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="bg-emerald-500 text-white text-[9px] px-2 py-0.5 rounded-full font-black">매칭 {lotteResult.matched}건</span>
                                        <span className="text-zinc-500 text-[9px] font-black">/ 가구매 {lotteResult.total}건</span>
                                        {lotteResult.notFound.length > 0 && (
                                            <span className="bg-rose-500 text-white text-[9px] px-2 py-0.5 rounded-full font-black">미매칭 {lotteResult.notFound.length}건</span>
                                        )}
                                    </div>
                                    {lotteResult.notFound.length > 0 && (
                                        <div className="mt-2 flex flex-wrap gap-1">
                                            {lotteResult.notFound.map(num => (
                                                <span key={num} className="bg-rose-950/40 text-rose-400 border border-rose-500/20 px-1.5 py-0.5 rounded text-[9px] font-mono">{num}</span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="flex items-center justify-center h-24 border border-dashed border-zinc-800 rounded-xl cursor-pointer hover:bg-zinc-800/20 transition-all" onClick={() => setShowFakeOrderInput(true)}>
                            <span className="text-[10px] font-black text-zinc-600 uppercase tracking-widest">명단 입력하기</span>
                        </div>
                    )}
                </section>
            </div>

            <section className="bg-zinc-900/60 rounded-[2.5rem] p-6 border border-zinc-800 shadow-2xl backdrop-blur-md">
                <div className="flex flex-col lg:flex-row items-center justify-between gap-6">
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
                        <div className="flex flex-wrap gap-2 mt-1">
                            {Object.keys(pricingConfig).sort((a, b) => {
                                const deadlineA = pricingConfig[a]?.deadline;
                                const deadlineB = pricingConfig[b]?.deadline;
                                if (deadlineA || deadlineB) return getTimeScore(deadlineA) - getTimeScore(deadlineB);
                                const indexA = PREFERRED_ORDER.indexOf(a), indexB = PREFERRED_ORDER.indexOf(b);
                                if (indexA !== -1 && indexB !== -1) return indexA - indexB;
                                return indexA !== -1 ? -1 : indexB !== -1 ? 1 : a.localeCompare(b);
                            }).flatMap(name => (companySessions[name] || []).map(s => {
                                const amount = totalsMap[s.id] || 0;
                                if (amount === 0) return null;
                                return (
                                    <div key={s.id} className="bg-zinc-950/50 px-3 py-1.5 rounded-lg border border-zinc-800 flex items-center gap-2 group/item hover:border-rose-500/30 transition-all shadow-sm">
                                        <span className="text-[10px] font-black text-zinc-500">{name}({s.round}차)</span>
                                        <span className="text-[11px] font-black text-white">{amount.toLocaleString()}원</span>
                                        <button onClick={() => handleResetSessionData(name, s.id, s.round)} className="text-zinc-700 hover:text-rose-500 transition-all p-0.5"><TrashIcon className="w-3 h-3" /></button>
                                    </div>
                                );
                            }))}
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
                    </div>
                </div>
            </section>
            
            <section className="bg-zinc-900/40 rounded-[2.5rem] p-6 border border-zinc-800 shadow-xl overflow-hidden">
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
                    <form onSubmit={handleAddManualTransfer} className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
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

            <section className="bg-zinc-900/20 rounded-[2.5rem] border border-zinc-900 overflow-hidden shadow-2xl">
                <div className="p-6 border-b border-zinc-900 bg-zinc-900/40 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="bg-zinc-800 p-2 rounded-xl border border-zinc-700"><BuildingStorefrontIcon className="w-5 h-5 text-rose-500" /></div>
                        <h2 className="text-xl font-black text-white tracking-tight uppercase">Workstation</h2>
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-zinc-950/50 text-zinc-500 text-[10px] font-black uppercase tracking-[0.15em]">
                                <th className="px-6 py-4 w-[35%] whitespace-nowrap">
                                    <div className="flex items-center gap-3">
                                        <button onClick={handleSelectAllSessions} className={`w-5 h-5 rounded-md border flex items-center justify-center transition-all ${isAllSelected ? 'bg-rose-500 border-rose-400 text-white' : 'bg-zinc-900 border-zinc-700 text-transparent hover:border-rose-500/50'}`} title="전체 선택"><CheckIcon className="w-3 h-3" /></button>
                                        <span>업체 정보</span>
                                    </div>
                                </th>
                                <th className="px-6 py-4 w-[30%] text-center whitespace-nowrap">발주서</th>
                                <th className="px-6 py-4 w-[35%] text-center whitespace-nowrap">송장 매칭</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-900">
                            {Object.keys(pricingConfig).sort((a, b) => {
                                const deadlineA = pricingConfig[a]?.deadline;
                                const deadlineB = pricingConfig[b]?.deadline;
                                if (deadlineA || deadlineB) return getTimeScore(deadlineA) - getTimeScore(deadlineB);
                                const indexA = PREFERRED_ORDER.indexOf(a), indexB = PREFERRED_ORDER.indexOf(b);
                                if (indexA !== -1 && indexB !== -1) return indexA - indexB;
                                return indexA !== -1 ? -1 : indexB !== -1 ? 1 : a.localeCompare(b);
                            }).map(company => (
                                <React.Fragment key={company}>
                                    {companySessions[company].map((session, sIdx) => (
                                        <CompanyWorkstationRow 
                                            key={session.id} sessionId={session.id} companyName={company} roundNumber={session.round} isFirstSession={sIdx === 0} pricingConfig={pricingConfig}
                                            vendorFile={vendorFiles[session.id] || null} masterFile={masterOrderFile} isDetected={detectedCompanies.has(company)} fakeOrderNumbers={fakeOrderInput}
                                            manualOrders={manualOrders.filter(o => o.companyName === company)} isSelected={selectedSessionIds.has(session.id)} onSelectToggle={handleToggleSessionSelection}
                                            onVendorFileChange={(file) => handleVendorFileChange(session.id, file)} onResultUpdate={handleResultUpdate} onDataUpdate={handleDataUpdate}
                                            onAddSession={() => handleAddSession(company)} onRemoveSession={() => handleRemoveSession(company, session.id)} onAddAdjustment={handleAddCompanyAdjustment}
                                        />
                                    ))}
                                </React.Fragment>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    );
};

export default CompanySelector;
