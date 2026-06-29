
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
declare var XLSX: any;
import BusinessColumn from './components/BusinessColumn';
import AddBusinessModal from './components/AddBusinessModal';
import CoupangDownloader from './components/CoupangDownloader';
import SharedMasterUpload, { type UploadResult } from './components/SharedMasterUpload';
import ConsolidatedInvoicePanel, { type InvoiceResult, type CourierItem } from './components/ConsolidatedInvoicePanel';
import { ChartBarIcon, PlusCircleIcon, PencilIcon, ArrowPathIcon, ArrowDownTrayIcon, ArrowUpTrayIcon, TruckIcon, HomeIcon, TrashIcon } from './components/icons';
import { useSharedSuppliers, useCourierTemplates } from './hooks/useFirestore';
import { useBusinessList } from './hooks/useBusinessList';
import { migrateLocalStorageToFirestore } from './services/migration';
import type { CourierTemplate } from './types';

// 400레벨 원색을 약간 어둡게 (투명도 레이어 대신 직접 혼합한 값)
function dimThemeColor(color: string): string {
  if (!color || color === '#09090b') return color;
  // hex를 rgb로 파싱 후 70%로 어둡게
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const factor = 0.62;
  const dr = Math.round(r * factor);
  const dg = Math.round(g * factor);
  const db = Math.round(b * factor);
  return `#${dr.toString(16).padStart(2, '0')}${dg.toString(16).padStart(2, '0')}${db.toString(16).padStart(2, '0')}`;
}

const FAKE_ORDER_KEY = 'globalFakeOrderInput';
const FAKE_ORDER_TS_KEY = 'globalFakeOrderInputTs';
const FAKE_TTL = 48 * 60 * 60 * 1000;

function loadPersistedFakeOrder(): string {
  try {
    const saved = localStorage.getItem(FAKE_ORDER_KEY);
    const ts = localStorage.getItem(FAKE_ORDER_TS_KEY);
    if (saved && ts && Date.now() - Number(ts) < FAKE_TTL) return saved;
  } catch {}
  return '';
}

// "사업자_이름_주문번호" 형식 파싱 (이름에 _가 있어도 마지막 _로 분리)
function parseGlobalFakeLine(line: string, businesses: { id: string; displayName: string }[]) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const firstUnderscore = trimmed.indexOf('_');
  if (firstUnderscore === -1) return null;
  const businessName = trimmed.slice(0, firstUnderscore);
  const rest = trimmed.slice(firstUnderscore + 1);
  const lastUnderscore = rest.lastIndexOf('_');
  if (lastUnderscore === -1) return null;
  const name = rest.slice(0, lastUnderscore);
  const orderNum = rest.slice(lastUnderscore + 1);
  if (!orderNum) return null;
  const business = businesses.find(b => b.displayName === businessName || b.id === businessName);
  return { businessName, name, orderNum, businessId: business?.id ?? null };
}

const App: React.FC = () => {
  const [showAddModal, setShowAddModal] = useState(false);
  const [showCoupang, setShowCoupang] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showInvoice, setShowInvoice] = useState(false);
  const [showGlobalFake, setShowGlobalFake] = useState(false);
  const [globalFakeOrderInput, setGlobalFakeOrderInput] = useState(() => loadPersistedFakeOrder());
  const [isEditingGlobalFake, setIsEditingGlobalFake] = useState(false);
  const [globalUnsentOrderInput, setGlobalUnsentOrderInput] = useState('');
  const [isEditingGlobalUnsent, setIsEditingGlobalUnsent] = useState(false);
  const [matchedFakeNums, setMatchedFakeNums] = useState<Record<string, string[]>>({});
  const globalFakeOrderInputRef = useRef('');
  useEffect(() => { globalFakeOrderInputRef.current = globalFakeOrderInput; }, [globalFakeOrderInput]);
  useEffect(() => {
    try {
      localStorage.setItem(FAKE_ORDER_KEY, globalFakeOrderInput);
      localStorage.setItem(FAKE_ORDER_TS_KEY, String(Date.now()));
    } catch {}
  }, [globalFakeOrderInput]);
  const [uploadResults, setUploadResults] = useState<UploadResult[]>([]);
  const [invoiceResults, setInvoiceResults] = useState<InvoiceResult[]>([]);
  const [businessWarnings, setBusinessWarnings] = useState<Record<string, boolean>>({});
  const [quotaExceeded, setQuotaExceeded] = useState(false);
  const [activePanelIndex, setActivePanelIndex] = useState(0);
  const [refreshKeys, setRefreshKeys] = useState<Record<string, number>>({});
  const [editingBusiness, setEditingBusiness] = useState<ReturnType<typeof useBusinessList>['businesses'][0] | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const uploadFnsRef = useRef<Record<string, { uploadMaster: (f: File) => Promise<void>; uploadBatch: (f: File) => Promise<void>; getNextRound: () => number; deleteBatchRound: (round: number) => boolean; clearMaster: () => void; getOrderState: () => { name: string; rounds: { round: number; hasData: boolean }[] }[]; downloadCompanyMerged: (companyName: string) => void; downloadCompanyRound: (companyName: string, round: number) => void; downloadAllCompanies?: () => void; uploadVendorInvoice?: (files: File[]) => void; getInvoiceState?: () => { name: string; uploadCount: number }[]; downloadInvoice?: (companyName: string) => void; downloadAllInvoices?: () => void; getInvoiceWorkbookFile?: () => File | null; }>>({});
  const directCoupangUploadRef = useRef<((businessId: string, file: File) => Promise<void>) | null>(null);
  const resetFnsRef = useRef<Record<string, () => void>>({});
  type DepositExtraRow = { bankName: string; accountNumber: string; amount: string; label: string };
  const downloadActionsRef = useRef<Record<string, { downloadDepositList: () => void; downloadWorkLog: () => void; downloadDepositListWithExtra: (extraRows: DepositExtraRow[]) => void; getDepositBaseRows: () => any[][]; downloadDepositListDirect: (baseRows: any[][], extraRows: DepositExtraRow[]) => void }>>({});

  const handleRegisterMasterUpload = useCallback((businessId: string, handlers: { uploadMaster: (f: File) => Promise<void>; uploadBatch: (f: File) => Promise<void>; getNextRound: () => number; deleteBatchRound: (round: number) => boolean; clearMaster: () => void; getOrderState: () => { name: string; rounds: { round: number; hasData: boolean }[] }[]; downloadCompanyMerged: (companyName: string) => void; downloadCompanyRound: (companyName: string, round: number) => void; downloadAllCompanies?: () => void; uploadVendorInvoice?: (files: File[]) => void; getInvoiceState?: () => { name: string; uploadCount: number }[]; downloadInvoice?: (companyName: string) => void; downloadAllInvoices?: () => void; getInvoiceWorkbookFile?: () => File | null; }) => {
    uploadFnsRef.current[businessId] = handlers;
  }, []);

  const handleRegisterReset = useCallback((businessId: string, fn: () => void) => {
    resetFnsRef.current[businessId] = fn;
  }, []);


  const handleRegisterDownloadActions = useCallback((businessId: string, actions: { downloadDepositList: () => void; downloadWorkLog: () => void; downloadDepositListWithExtra: (extraRows: DepositExtraRow[]) => void; getDepositBaseRows: () => any[][]; downloadDepositListDirect: (baseRows: any[][], extraRows: DepositExtraRow[]) => void }) => {
    downloadActionsRef.current[businessId] = actions;
  }, []);

  const handleBulkWorkLog = useCallback(() => {
    const actions = Object.values(downloadActionsRef.current) as { downloadWorkLog: () => void }[];
    if (actions.length === 0) { alert('다운로드 가능한 사업자 데이터가 없습니다.'); return; }
    actions.forEach(a => a.downloadWorkLog());
  }, []);

  const [showBulkDepositModal, setShowBulkDepositModal] = useState(false);
  const [bulkPasteText, setBulkPasteText] = useState('');
  const [bulkBaseRowsMap, setBulkBaseRowsMap] = useState<Record<string, any[][]>>({});

  useEffect(() => {
    const handler = () => setQuotaExceeded(true);
    window.addEventListener('firestore-quota-exceeded', handler);
    return () => window.removeEventListener('firestore-quota-exceeded', handler);
  }, []);

  useEffect(() => {
    migrateLocalStorageToFirestore().then((migrated) => {
      if (migrated) console.log('[App] localStorage → Firestore 마이그레이션 완료');
    });
  }, []);

  const { businesses: allBusinesses, isLoading: businessListLoading, addBusiness, removeBusiness, updateBusiness } = useBusinessList();

  const openBulkDepositModal = useCallback(() => {
    const loaded: Record<string, any[][]> = {};
    allBusinesses.forEach(b => {
      const rows = downloadActionsRef.current[b.id]?.getDepositBaseRows?.() ?? [];
      if (rows.length > 0) loaded[b.id] = rows;
    });
    setBulkBaseRowsMap(loaded);
    setBulkPasteText('');
    setShowBulkDepositModal(true);
  }, [allBusinesses]);
  const sharedSuppliers = useSharedSuppliers();
  const { courierTemplates } = useCourierTemplates();

  // 공통 택배: 각 사업자의 주문 행 데이터를 ref에 수집 (상태 불필요, 버튼 클릭 시점에 읽음)
  const globalMasterRowsRef = useRef<Record<string, { header: any[]; dataRows: any[][] }>>({} as Record<string, { header: any[]; dataRows: any[][] }>);
  const globalCourierFilesRef = useRef<Record<string, File[]>>({});
  const [globalCourierFiles, setGlobalCourierFiles] = useState<Record<string, File[]>>({});
  const [globalCourierResults, setGlobalCourierResults] = useState<Record<string, { matched: number; total: number; notFound: string[] }>>({});
  const [globalCourierMatchedRows, setGlobalCourierMatchedRows] = useState<Record<string, any[][]>>({});

  const handleExposeOrderRows = useCallback((businessId: string, header: any[] | null, dataRows: any[][]) => {
    globalMasterRowsRef.current[businessId] = { header: header ?? [], dataRows };
  }, []);

  const handleGlobalCourierDownload = useCallback(async (template: CourierTemplate) => {
    const allDataRows = (Object.values(globalMasterRowsRef.current) as { header: any[]; dataRows: any[][] }[]).flatMap(b => b.dataRows);
    if (allDataRows.length === 0) { alert('각 사업자 탭에 주문서를 먼저 업로드해주세요.'); return; }

    const fakeOrderNums = new Set<string>();
    globalFakeOrderInputRef.current.split('\n').forEach(line => {
      const trimmed = line.trim();
      const parts = trimmed.split('_');
      if (parts.length >= 3) {
        const orderNum = parts[parts.length - 1].replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (orderNum) fakeOrderNums.add(orderNum);
      }
    });
    if (fakeOrderNums.size === 0) { alert('가구매 명단에 주문번호가 없습니다.'); return; }

    const rows: any[][] = [[...template.headers]];
    const notFoundOrders: string[] = [];
    const seenOrderNums = new Set<string>();
    const { mapping, fixedValues } = template;

    for (const row of allDataRows) {
      if (!row) continue;
      const orderNum = String(row[2] || '').trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
      if (!fakeOrderNums.has(orderNum)) continue;
      if (seenOrderNums.has(orderNum)) continue;
      seenOrderNums.add(orderNum);

      const recipientName = String(row[26] || '').trim();
      const phone = String(row[27] || '').trim();
      const address = String(row[29] || '').trim();
      const originalOrderNum = String(row[2] || '').trim();
      if (!recipientName) notFoundOrders.push(originalOrderNum);

      const newRow = new Array(template.headers.length).fill('');
      newRow[mapping.orderNumber] = originalOrderNum;
      newRow[mapping.recipientName] = recipientName;
      newRow[mapping.recipientPhone] = phone;
      newRow[mapping.recipientAddress] = address;
      Object.entries(fixedValues).forEach(([colIdx, value]) => { newRow[Number(colIdx)] = value; });
      rows.push(newRow);
    }

    const matchedCount = rows.length - 1;
    if (matchedCount === 0) { alert('주문서에서 가구매 명단과 매칭되는 주문을 찾지 못했습니다.'); return; }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const tmplDisplayName = template.label ? `${template.name}_${template.label}` : template.name;
    XLSX.writeFile(wb, `${new Date().toLocaleDateString('en-CA')}_공통_${tmplDisplayName}.xlsx`);
    if (notFoundOrders.length > 0) alert(`${template.name} ${matchedCount}건 다운로드!\n배송정보 누락 ${notFoundOrders.length}건: ${notFoundOrders.join(', ')}`);
  }, []);

  const processGlobalCourierFiles = useCallback(async (template: CourierTemplate, files: File[]) => {
    const allBusiness = globalMasterRowsRef.current as Record<string, { header: any[]; dataRows: any[][] }>;
    const allDataRows = Object.values(allBusiness).flatMap(b => b.dataRows);
    if (allDataRows.length === 0) { alert('각 사업자 탭에 주문서를 먼저 업로드해주세요.'); return; }

    setGlobalCourierResults(prev => { const n = { ...prev }; delete n[template.id]; return n; });
    setGlobalCourierMatchedRows(prev => { const n = { ...prev }; delete n[template.id]; return n; });

    if (files.length === 0) return;

    try {
      const rm = template.returnMapping;
      const orderColIdx = rm ? rm.orderNumber : template.mapping.orderNumber;
      const trackingColIdx = rm ? rm.trackingNumber : template.mapping.trackingNumber;

      const trackingMap = new Map<string, string>();
      for (const file of files) {
        const courierData = await file.arrayBuffer();
        const courierWb = XLSX.read(courierData, { type: 'array' });
        const courierAoa: any[][] = XLSX.utils.sheet_to_json(courierWb.Sheets[courierWb.SheetNames[0]], { header: 1 });
        for (let i = 1; i < courierAoa.length; i++) {
          const row = courierAoa[i];
          if (!row) continue;
          const orderNum = String(row[orderColIdx] || '').trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
          const trackingNum = String(row[trackingColIdx] || '').trim();
          if (orderNum && trackingNum && trackingNum.length >= 5) trackingMap.set(orderNum, trackingNum);
        }
      }

      const fakeOrderNums = new Set<string>();
      globalFakeOrderInputRef.current.split('\n').forEach(line => {
        const parts = line.trim().split('_');
        if (parts.length >= 3) {
          const orderNum = parts[parts.length - 1].replace(/[^A-Z0-9]/gi, '').toUpperCase();
          if (orderNum) fakeOrderNums.add(orderNum);
        }
      });
      if (fakeOrderNums.size === 0) { alert('가구매 명단에 주문번호가 없습니다.'); return; }

      const header = Object.values(allBusiness).find(b => b.header.length > 0)?.header ?? [];
      const matchedRows: any[][] = [header];
      const notFoundOrders: string[] = [];
      const seenOrderNums = new Set<string>();

      for (const row of allDataRows) {
        if (!row) continue;
        const orderNum = String(row[2] || '').trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (!fakeOrderNums.has(orderNum)) continue;
        if (seenOrderNums.has(orderNum)) continue;
        seenOrderNums.add(orderNum);
        const tracking = trackingMap.get(orderNum);
        if (tracking) {
          const newRow = [...row];
          while (newRow.length <= 4) newRow.push('');
          newRow[3] = template.name;
          newRow[4] = tracking;
          matchedRows.push(newRow);
        } else {
          notFoundOrders.push(String(row[2] || ''));
        }
      }

      const matchedCount = matchedRows.length - 1;
      setGlobalCourierResults(prev => ({ ...prev, [template.id]: { matched: matchedCount, total: fakeOrderNums.size, notFound: notFoundOrders } }));
      if (matchedCount > 0) setGlobalCourierMatchedRows(prev => ({ ...prev, [template.id]: matchedRows }));
    } catch (err: any) {
      alert(`${template.name} 운송장 처리 중 오류: ` + err.message);
    }
  }, []);

  const handleGlobalCourierFilesAdd = useCallback(async (template: CourierTemplate, newFiles: File[]) => {
    const current = globalCourierFilesRef.current[template.id] || [];
    const updated = [...current, ...newFiles];
    globalCourierFilesRef.current = { ...globalCourierFilesRef.current, [template.id]: updated };
    setGlobalCourierFiles(prev => ({ ...prev, [template.id]: updated }));
    await processGlobalCourierFiles(template, updated);
  }, [processGlobalCourierFiles]);

  const handleGlobalCourierFileRemove = useCallback(async (template: CourierTemplate, index: number) => {
    const current = globalCourierFilesRef.current[template.id] || [];
    const updated = current.filter((_, i) => i !== index);
    globalCourierFilesRef.current = { ...globalCourierFilesRef.current, [template.id]: updated };
    setGlobalCourierFiles(prev => ({ ...prev, [template.id]: updated }));
    await processGlobalCourierFiles(template, updated);
  }, [processGlobalCourierFiles]);

  const handleGlobalCourierResultDownload = useCallback((templateId: string) => {
    const rows = globalCourierMatchedRows[templateId];
    if (!rows) return;
    const tmpl = courierTemplates.find(t => t.id === templateId);
    const tmplDisplayName = tmpl ? (tmpl.label ? `${tmpl.name}_${tmpl.label}` : tmpl.name) : '택배';
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '주문서');
    XLSX.writeFile(wb, `${new Date().toLocaleDateString('en-CA')}_공통_가구매_${tmplDisplayName}_운송장완료.xlsx`);
  }, [globalCourierMatchedRows, courierTemplates]);

  const handleCourierDirectCoupangUpload = useCallback(async (templateId: string, businessId: string) => {
    const rows = globalCourierMatchedRows[templateId];
    if (!rows) throw new Error('운송장 매칭 데이터가 없습니다. 먼저 운송장을 업로드해주세요.');
    if (!directCoupangUploadRef.current) throw new Error('쿠팡 업로더가 초기화되지 않았습니다. 페이지를 새로고침 후 다시 시도해주세요.');
    const tmpl = courierTemplates.find(t => t.id === templateId);
    const tmplDisplayName = tmpl ? (tmpl.label ? `${tmpl.name}_${tmpl.label}` : tmpl.name) : '택배';
    const fileName = `${new Date().toLocaleDateString('en-CA')}_공통_가구매_${tmplDisplayName}_운송장완료.xlsx`;
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '주문서');
    const binary: ArrayBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const file = new File([binary], fileName, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    await directCoupangUploadRef.current(businessId, file);
  }, [globalCourierMatchedRows, courierTemplates]);

  const courierItemsForPanel = useMemo<CourierItem[]>(() =>
    courierTemplates.map(t => ({
      id: t.id,
      name: t.name,
      label: t.label,
      files: globalCourierFiles[t.id] || [],
      result: globalCourierResults[t.id],
      hasMatchedRows: !!globalCourierMatchedRows[t.id],
    })),
    [courierTemplates, globalCourierFiles, globalCourierResults, globalCourierMatchedRows]
  );

  const handleCourierFilesAddForPanel = useCallback((templateId: string, files: File[]) => {
    const tmpl = courierTemplates.find(t => t.id === templateId);
    if (tmpl) handleGlobalCourierFilesAdd(tmpl, files);
  }, [courierTemplates, handleGlobalCourierFilesAdd]);

  const handleCourierFileRemoveForPanel = useCallback((templateId: string, index: number) => {
    const tmpl = courierTemplates.find(t => t.id === templateId);
    if (tmpl) handleGlobalCourierFileRemove(tmpl, index);
  }, [courierTemplates, handleGlobalCourierFileRemove]);

  const scrollToPanel = useCallback((index: number) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTo({ left: index * window.innerWidth, behavior: 'instant' });
    setActivePanelIndex(index);
  }, []);

  // 스크롤 감지 — businessListLoading 이후 컨테이너가 DOM에 생긴 뒤에 바인딩
  useEffect(() => {
    if (businessListLoading) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const index = Math.round(container.scrollLeft / window.innerWidth);
      setActivePanelIndex(index);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [businessListLoading]);

  // 드롭다운 외부 클릭 감지 — overlay 대신 document mousedown으로 처리 (overlay는 스크롤을 막으므로)
  useEffect(() => {
    if (!showCoupang && !showUpload && !showInvoice && !showGlobalFake) return;
    const handler = () => {
      setShowCoupang(false);
      setShowUpload(false);
      setShowInvoice(false);
      setShowGlobalFake(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showCoupang, showUpload, showInvoice, showGlobalFake]);

  const handleDeleteBusiness = async (businessId: string) => {
    const label = allBusinesses.find(b => b.id === businessId)?.displayName;
    if (!window.confirm(`"${label}" 사업자를 삭제하시겠습니까?\n(Firestore 데이터는 보존됩니다)`)) return;
    await removeBusiness(businessId);
  };

  // 전역 가구매 명단 → 사업자별 "이름 주문번호" 문자열로 분배
  const perBusinessFakeInput = useMemo(() => {
    const result: Record<string, string> = {};
    globalFakeOrderInput.split('\n').forEach(line => {
      const parsed = parseGlobalFakeLine(line, allBusinesses);
      if (!parsed?.businessId || !parsed.name || !parsed.orderNum) return;
      const entry = `${parsed.name} ${parsed.orderNum}`;
      result[parsed.businessId] = result[parsed.businessId]
        ? `${result[parsed.businessId]}\n${entry}`
        : entry;
    });
    return result;
  }, [globalFakeOrderInput, allBusinesses]);

  // 전역 미발송 명단 → 사업자별 "이름 주문번호" 문자열로 분배
  const perBusinessUnsentInput = useMemo(() => {
    const result: Record<string, string> = {};
    globalUnsentOrderInput.split('\n').forEach(line => {
      const parsed = parseGlobalFakeLine(line, allBusinesses);
      if (!parsed?.businessId || !parsed.name || !parsed.orderNum) return;
      const entry = `${parsed.name} ${parsed.orderNum}`;
      result[parsed.businessId] = result[parsed.businessId]
        ? `${result[parsed.businessId]}\n${entry}`
        : entry;
    });
    return result;
  }, [globalUnsentOrderInput, allBusinesses]);

  // 모든 사업자에서 올라온 매칭된 주문번호 합집합
  const allMatchedFakeNums = useMemo(() => {
    const all = new Set<string>();
    (Object.values(matchedFakeNums) as string[][]).forEach(nums => nums.forEach(n => all.add(n)));
    return all;
  }, [matchedFakeNums]);

  // 사업자별 가구매 매칭/미발견 통계
  const perBusinessFakeStats = useMemo(() => {
    const stats: Record<string, { total: number; matched: number }> = {};
    allBusinesses.forEach(b => {
      const input = perBusinessFakeInput[b.id] || '';
      const total = input.trim() ? input.trim().split('\n').filter(Boolean).length : 0;
      const matched = matchedFakeNums[b.id]?.length ?? 0;
      if (total > 0) stats[b.id] = { total, matched };
    });
    return stats;
  }, [perBusinessFakeInput, matchedFakeNums, allBusinesses]);

  const handleGlobalFakeMatch = useCallback((businessId: string, matched: string[]) => {
    setMatchedFakeNums(prev => {
      const prev_ = prev[businessId];
      if (prev_ && prev_.length === matched.length && prev_.every((v, i) => v === matched[i])) return prev;
      return { ...prev, [businessId]: matched };
    });
  }, []);

  return (
    // h-screen + overflow-hidden 으로 전체를 뷰포트에 가두고, 스크롤 컨텍스트를 패널별로 분리
    <div className="h-screen overflow-hidden flex flex-col bg-zinc-950">

      {/* 상단 네비게이션 — 고정 (sticky 불필요, flex-shrink-0으로 공간 확보) */}
      <div className="flex-shrink-0 z-50 bg-zinc-950/90 backdrop-blur-xl border-b border-zinc-800/40 px-4 py-2 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 mr-2">
          <ChartBarIcon className="w-5 h-5 text-zinc-400" />
          <span className="text-sm font-black text-white">윙</span>
          <button
            onClick={() => {
              const currentBusiness = allBusinesses[activePanelIndex];
              if (!currentBusiness) return;
              resetFnsRef.current[currentBusiness.id]?.();
              setUploadResults(prev => prev.filter(r => r.businessId !== currentBusiness.id));
            }}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-zinc-700 hover:bg-zinc-600 active:bg-zinc-800 active:scale-95 transition-all duration-150"
            title="현재 사업자 워크스테이션 새로고침"
          >
            <ArrowPathIcon className="w-3.5 h-3.5 text-white" />
            <span className="text-[10px] font-black text-white">새로고침</span>
          </button>
          <button
            onClick={() => {
              if (!window.confirm('모든 사업자의 워크스테이션을 초기화하시겠습니까?')) return;
              allBusinesses.forEach(b => resetFnsRef.current[b.id]?.());
              setUploadResults([]);
            }}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-zinc-800 hover:bg-rose-900/60 active:bg-rose-900 active:scale-95 transition-all duration-150"
            title="모든 사업자 워크스테이션 초기화"
          >
            <TrashIcon className="w-3.5 h-3.5 text-zinc-400" />
            <span className="text-[10px] font-black text-zinc-400">초기화</span>
          </button>
        </div>

        {/* 사업자 네비 칩 */}
        {allBusinesses.map((b, i) => (
          <div key={b.id} className="flex items-center gap-1">
            <button
              onClick={() => scrollToPanel(i)}
              className={`px-3 py-1 rounded-full text-[11px] font-black transition-all duration-200 ${
                activePanelIndex === i
                  ? 'text-white'
                  : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
              }`}
              style={activePanelIndex === i ? { backgroundColor: b.buttonColor } : undefined}
            >
              {b.displayName}
            </button>
            {!['안군농원', '조에'].includes(b.id) && (
              <button
                onClick={() => handleDeleteBusiness(b.id)}
                className="w-5 h-5 flex items-center justify-center bg-zinc-800 hover:bg-red-500 rounded-full text-zinc-400 hover:text-white transition-colors text-[10px] font-black"
                title="사업자 삭제"
              >
                ×
              </button>
            )}
          </div>
        ))}

        <div className="flex-1" />

        {/* 일괄 입금목록 */}
        <button
          onClick={openBulkDepositModal}
          className="px-3 py-1 rounded-full text-[11px] font-black transition-all duration-200 border text-emerald-400 border-emerald-500/50 hover:bg-emerald-900/30 hover:border-emerald-400 active:scale-95"
        >
          일괄 입금목록
        </button>

        {/* 일괄 업무일지 */}
        <button
          onClick={handleBulkWorkLog}
          className="px-3 py-1 rounded-full text-[11px] font-black transition-all duration-200 border text-violet-400 border-violet-500/50 hover:bg-violet-900/30 hover:border-violet-400 active:scale-95"
        >
          일괄 업무일지
        </button>

        {/* 전체 가구매 명단 */}
        <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
          <button
            onClick={() => { setShowGlobalFake(v => !v); setShowCoupang(false); setShowUpload(false); setShowInvoice(false); }}
            className={`px-3 py-1 rounded-full text-[11px] font-black transition-all duration-200 border ${
              showGlobalFake
                ? 'bg-zinc-700 text-white border-zinc-600'
                : globalFakeOrderInput.trim()
                ? 'text-violet-400 border-violet-500/50 hover:border-violet-400 hover:bg-violet-900/30'
                : 'text-zinc-500 hover:text-white border-zinc-700/50 hover:border-zinc-600 hover:bg-zinc-800'
            }`}
          >
            가구매 명단{globalFakeOrderInput.trim() ? ` (${globalFakeOrderInput.trim().split('\n').filter(Boolean).length}${allMatchedFakeNums.size > 0 ? `/${allMatchedFakeNums.size}` : ''})` : ''}
          </button>
          {showGlobalFake && (
            <div className="absolute right-0 top-full mt-2 z-50 w-[380px] bg-zinc-900 border border-zinc-700/50 rounded-2xl shadow-2xl max-h-[calc(100vh-70px)] overflow-y-auto">
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-zinc-200 font-black text-[11px] uppercase tracking-widest">가구매 명단</h3>
                  <div className="flex items-center gap-2">
                    {globalFakeOrderInput.trim() && !isEditingGlobalFake && (
                      <button onClick={() => setIsEditingGlobalFake(true)} className="text-[10px] text-zinc-500 hover:text-white font-black transition-colors">편집</button>
                    )}
                    {globalFakeOrderInput.trim() && (
                      <button onClick={() => { setGlobalFakeOrderInput(''); setMatchedFakeNums({}); }} className="text-[10px] text-zinc-500 hover:text-rose-400 font-black transition-colors">초기화</button>
                    )}
                  </div>
                </div>
                <p className="text-zinc-600 text-[10px] mb-2 font-mono">형식: 사업자_이름_주문번호</p>

                {/* 편집 모드 또는 비어있을 때: textarea */}
                {(isEditingGlobalFake || !globalFakeOrderInput.trim()) ? (
                  <textarea
                    autoFocus={isEditingGlobalFake}
                    value={globalFakeOrderInput}
                    onChange={(e) => setGlobalFakeOrderInput(e.target.value)}
                    onBlur={() => setIsEditingGlobalFake(false)}
                    placeholder={'안군농원_홍길동_11100198137997\n조에_김철수_11100198138001'}
                    className="w-full h-[200px] bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-[10px] font-mono text-zinc-300 focus:outline-none focus:border-violet-500/50 resize-none custom-scrollbar"
                  />
                ) : (
                  /* 보기 모드: 줄별 컬러 표시 */
                  <div
                    onClick={() => setIsEditingGlobalFake(true)}
                    className="cursor-text w-full h-[200px] bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 overflow-y-auto custom-scrollbar"
                  >
                    {globalFakeOrderInput.split('\n').map((line, i) => {
                      const parsed = parseGlobalFakeLine(line, allBusinesses);
                      const isMatched = parsed?.orderNum ? allMatchedFakeNums.has(parsed.orderNum) : false;
                      const isValid = !!parsed?.businessId;
                      const isEmpty = !line.trim();
                      return (
                        <div
                          key={i}
                          className={`text-[10px] font-mono leading-[1.6] ${
                            isEmpty ? '' :
                            isMatched ? 'text-emerald-400' :
                            isValid ? 'text-zinc-400' :
                            'text-zinc-600'
                          }`}
                        >
                          {line || ' '}
                        </div>
                      );
                    })}
                  </div>
                )}

                {globalFakeOrderInput.trim() && (
                  <div className="mt-2 space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] text-zinc-500 font-black">
                        총 {globalFakeOrderInput.trim().split('\n').filter(Boolean).length}명
                      </span>
                      {allMatchedFakeNums.size > 0 && (
                        <span className="text-[10px] text-emerald-400 font-black">
                          매칭 {allMatchedFakeNums.size}
                        </span>
                      )}
                      {(() => {
                        const total = globalFakeOrderInput.trim().split('\n').filter(Boolean).length;
                        const unmatched = total - allMatchedFakeNums.size;
                        return unmatched > 0 && allMatchedFakeNums.size > 0 ? (
                          <span className="text-[10px] text-zinc-600 font-black">미발견 {unmatched}</span>
                        ) : null;
                      })()}
                    </div>
                    {allBusinesses
                      .filter(b => perBusinessFakeStats[b.id])
                      .map(b => {
                        const s = perBusinessFakeStats[b.id];
                        const missing = s.total - s.matched;
                        return (
                          <div key={b.id} className="flex items-center gap-1.5 flex-wrap pl-1 border-l-2 border-zinc-800">
                            <span className="text-[9px] text-zinc-500 font-black">{b.displayName}</span>
                            <span className="text-[9px] text-zinc-700 font-black">{s.total}명</span>
                            {s.matched > 0 && (
                              <span className="bg-emerald-500 text-white text-[8px] px-1.5 py-0.5 rounded-full font-black">매칭 {s.matched}</span>
                            )}
                            {missing > 0 && (
                              <span className="bg-rose-500 text-white text-[8px] px-1.5 py-0.5 rounded-full font-black">미발견 {missing}</span>
                            )}
                          </div>
                        );
                      })
                    }
                  </div>
                )}

                {/* 미발송 명단 */}
                <div className="mt-4 border-t border-zinc-800 pt-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-amber-400 font-black text-[11px] uppercase tracking-widest">미발송 명단</h3>
                    <div className="flex items-center gap-2">
                      {globalUnsentOrderInput.trim() && !isEditingGlobalUnsent && (
                        <button onClick={() => setIsEditingGlobalUnsent(true)} className="text-[10px] text-zinc-500 hover:text-white font-black transition-colors">편집</button>
                      )}
                      {globalUnsentOrderInput.trim() && (
                        <button onClick={() => setGlobalUnsentOrderInput('')} className="text-[10px] text-zinc-500 hover:text-rose-400 font-black transition-colors">초기화</button>
                      )}
                    </div>
                  </div>
                  <p className="text-zinc-600 text-[10px] mb-2 font-mono">형식: 사업자_이름_주문번호</p>

                  {(isEditingGlobalUnsent || !globalUnsentOrderInput.trim()) ? (
                    <textarea
                      autoFocus={isEditingGlobalUnsent}
                      value={globalUnsentOrderInput}
                      onChange={(e) => setGlobalUnsentOrderInput(e.target.value)}
                      onBlur={() => setIsEditingGlobalUnsent(false)}
                      placeholder={'안군농원_홍길동_11100198137997\n조에_김철수_11100198138001'}
                      className="w-full h-[80px] bg-zinc-950 border border-amber-900/30 rounded-xl px-3 py-2 text-[10px] font-mono text-zinc-300 focus:outline-none focus:border-amber-500/50 resize-none custom-scrollbar"
                    />
                  ) : (
                    <div
                      onClick={() => setIsEditingGlobalUnsent(true)}
                      className="cursor-text w-full h-[80px] bg-zinc-950 border border-amber-900/30 rounded-xl px-3 py-2 overflow-y-auto custom-scrollbar"
                    >
                      {globalUnsentOrderInput.split('\n').map((line, i) => {
                        const parsed = parseGlobalFakeLine(line, allBusinesses);
                        const isValid = !!parsed?.businessId;
                        const isEmpty = !line.trim();
                        return (
                          <div
                            key={i}
                            className={`text-[10px] font-mono leading-[1.6] ${
                              isEmpty ? '' : isValid ? 'text-amber-400/80' : 'text-zinc-600'
                            }`}
                          >
                            {line || ' '}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {globalUnsentOrderInput.trim() && (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[10px] text-zinc-500 font-black">
                        총 {globalUnsentOrderInput.trim().split('\n').filter(Boolean).length}명
                      </span>
                    </div>
                  )}
                </div>

                {/* 공통 택배 예약 / 송장 입력 */}
                {courierTemplates.length > 0 && globalFakeOrderInput.trim() && (
                  <div className="mt-4 border-t border-zinc-800 pt-4">
                    <h3 className="text-violet-400 font-black text-[11px] uppercase tracking-widest mb-3">택배</h3>
                    <div className="space-y-2">
                      {courierTemplates.map((tmpl: CourierTemplate) => {
                        const files = globalCourierFiles[tmpl.id] || [];
                        const result = globalCourierResults[tmpl.id];
                        const matched = globalCourierMatchedRows[tmpl.id];
                        const fullName = tmpl.label ? `${tmpl.name} (${tmpl.label})` : tmpl.name;
                        const isOffice = fullName.includes('사무실');
                        const isAgent = fullName.includes('대행');
                        const cs = isOffice
                          ? { border: 'border-pink-500/30', bg: 'bg-amber-950/30', text: 'text-pink-400', hoverBg: 'hover:bg-amber-900/40', hoverBorder: 'hover:border-pink-500/50', activeBg: 'bg-amber-950/30 border-pink-500/30 text-pink-400', inactiveBorder: 'hover:border-pink-500/40 hover:text-pink-400' }
                          : isAgent
                          ? { border: 'border-cyan-500/30', bg: 'bg-cyan-950/30', text: 'text-cyan-400', hoverBg: 'hover:bg-cyan-900/40', hoverBorder: 'hover:border-cyan-500/50', activeBg: 'bg-cyan-950/30 border-cyan-500/30 text-cyan-400', inactiveBorder: 'hover:border-cyan-500/40 hover:text-cyan-400' }
                          : { border: 'border-indigo-500/30', bg: 'bg-indigo-950/30', text: 'text-indigo-400', hoverBg: 'hover:bg-indigo-900/40', hoverBorder: 'hover:border-indigo-500/50', activeBg: 'bg-indigo-950/30 border-indigo-500/30 text-indigo-400', inactiveBorder: 'hover:border-indigo-500/40 hover:text-indigo-400' };
                        const totalFake = globalFakeOrderInput.trim().split('\n').filter(Boolean).length;
                        return (
                          <div key={tmpl.id} className={`space-y-1.5 p-2 rounded-xl border ${cs.border} bg-zinc-950/40`}>
                            <button
                              onClick={() => handleGlobalCourierDownload(tmpl)}
                              className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[9px] font-black border transition-all shadow-md ${cs.bg} ${cs.border} ${cs.text} ${cs.hoverBg} ${cs.hoverBorder}`}
                            >
                              <ArrowDownTrayIcon className="w-3.5 h-3.5" />
                              <span className="flex items-center gap-1">
                                {isOffice ? <HomeIcon className="w-3 h-3" /> : isAgent ? <TruckIcon className="w-3 h-3" /> : null}
                                {fullName} ({totalFake}건)
                              </span>
                            </button>
                            {/* 업로드된 파일 목록 */}
                            {files.length > 0 && (
                              <div className="flex flex-col gap-1">
                                {files.map((f, idx) => (
                                  <div key={idx} className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border ${cs.border} bg-zinc-900/60`}>
                                    <span className={`text-[9px] font-black truncate flex-1 ${cs.text}`}>{f.name}</span>
                                    <button
                                      onClick={() => handleGlobalCourierFileRemove(tmpl, idx)}
                                      className="shrink-0 text-zinc-600 hover:text-rose-400 transition-colors text-[10px] leading-none px-0.5"
                                    >✕</button>
                                  </div>
                                ))}
                              </div>
                            )}
                            {/* 파일 추가 버튼 */}
                            <label className={`flex items-center justify-center gap-1.5 cursor-pointer px-3 py-2 rounded-xl text-[9px] font-black border transition-all shadow-md ${files.length > 0 ? `bg-zinc-900/50 border-zinc-700 text-zinc-500 ${cs.inactiveBorder}` : `bg-zinc-900/50 border-zinc-700 text-zinc-500 ${cs.inactiveBorder}`}`}>
                              <ArrowUpTrayIcon className="w-3.5 h-3.5 shrink-0" />
                              <span>{files.length > 0 ? '파일 추가' : <span className="flex items-center gap-1">{isOffice ? <HomeIcon className="w-3 h-3" /> : isAgent ? <TruckIcon className="w-3 h-3" /> : null}{fullName} 운송장 업로드</span>}</span>
                              <input
                                type="file"
                                className="sr-only"
                                accept=".xlsx,.xls"
                                multiple
                                onChange={(e) => {
                                  const fs = Array.from(e.target.files || []);
                                  if (fs.length > 0) handleGlobalCourierFilesAdd(tmpl, fs);
                                  e.currentTarget.value = '';
                                }}
                              />
                            </label>
                            {result && (
                              <div className="bg-zinc-950/80 p-2 rounded-xl border border-zinc-800 space-y-1.5">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="bg-emerald-500 text-white text-[8px] px-1.5 py-0.5 rounded-full font-black">매칭 {result.matched}건</span>
                                  <span className="text-zinc-500 text-[8px] font-black">/ 가구매 {result.total}건</span>
                                  {result.notFound.length > 0 && <span className="bg-rose-500 text-white text-[8px] px-1.5 py-0.5 rounded-full font-black">미매칭 {result.notFound.length}건</span>}
                                </div>
                                {result.notFound.length > 0 && (
                                  <div className="flex flex-wrap gap-1">
                                    {result.notFound.map((num: string) => (
                                      <span key={num} className="bg-rose-950/40 text-rose-400 border border-rose-500/20 px-1 py-0.5 rounded text-[8px] font-mono">{num}</span>
                                    ))}
                                  </div>
                                )}
                                {matched && (
                                  <button onClick={() => handleGlobalCourierResultDownload(tmpl.id)} className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-[9px] font-black transition-colors shadow-lg">
                                    <ArrowDownTrayIcon className="w-3.5 h-3.5" />
                                    운송장완료 다운로드 ({result.matched}건)
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 공통 주문서 업로드 */}
        <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
          <button
            onClick={() => { setShowUpload(v => !v); setShowCoupang(false); setShowInvoice(false); setShowGlobalFake(false); }}
            className={`px-3 py-1 rounded-full text-[11px] font-black transition-all duration-200 border ${
              showUpload
                ? 'bg-zinc-700 text-white border-zinc-600'
                : 'text-zinc-500 hover:text-white border-zinc-700/50 hover:border-zinc-600 hover:bg-zinc-800'
            }`}
          >
            주문서 업로드
          </button>
          {showUpload && (
            <div className="absolute right-0 top-full mt-2 z-50 w-[380px] bg-zinc-900 border border-zinc-700/50 rounded-2xl shadow-2xl max-h-[calc(100vh-70px)] overflow-y-auto">
              <SharedMasterUpload
                businesses={allBusinesses.map(b => ({ id: b.id, displayName: b.displayName }))}
                uploadFns={uploadFnsRef.current}
                onClose={() => setShowUpload(false)}
                results={uploadResults}
                onResultsChange={setUploadResults}
                warningBusinessIds={new Set(Object.keys(businessWarnings).filter(id => businessWarnings[id]))}
              />
            </div>
          )}
        </div>

        {/* 통합 송장 변환 */}
        <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
          <button
            onClick={() => { setShowInvoice(v => !v); setShowCoupang(false); setShowUpload(false); setShowGlobalFake(false); }}
            className={`px-3 py-1 rounded-full text-[11px] font-black transition-all duration-200 border ${
              showInvoice
                ? 'bg-zinc-700 text-white border-zinc-600'
                : 'text-zinc-500 hover:text-white border-zinc-700/50 hover:border-zinc-600 hover:bg-zinc-800'
            }`}
          >
            통합송장변환
          </button>
          <div className={`absolute right-0 top-full mt-2 z-50 w-[420px] bg-zinc-900 border border-zinc-700/50 rounded-2xl shadow-2xl max-h-[calc(100vh-70px)] overflow-y-auto ${showInvoice ? '' : 'hidden'}`}>
            <ConsolidatedInvoicePanel
              businesses={allBusinesses.map(b => ({ id: b.id, displayName: b.displayName }))}
              uploadFns={uploadFnsRef.current}
              onClose={() => setShowInvoice(false)}
              results={invoiceResults}
              onResultsChange={setInvoiceResults}
              onReset={() => setInvoiceResults([])}
              couriers={courierItemsForPanel}
              hasFakeOrders={globalFakeOrderInput.trim().length > 0}
              onCourierFilesAdd={handleCourierFilesAddForPanel}
              onCourierFileRemove={handleCourierFileRemoveForPanel}
              onCourierResultDownload={handleGlobalCourierResultDownload}
              onCourierDirectCoupangUpload={handleCourierDirectCoupangUpload}
              onDirectCoupangUpload={async (businessId) => {
                const file = uploadFnsRef.current[businessId]?.getInvoiceWorkbookFile?.();
                if (!file) throw new Error('송장 데이터가 없습니다. 먼저 송장 파일을 업로드해주세요.');
                if (!directCoupangUploadRef.current) throw new Error('쿠팡 업로더가 초기화되지 않았습니다. 페이지를 새로고침 후 다시 시도해주세요.');
                await directCoupangUploadRef.current(businessId, file);
              }}
            />
          </div>
        </div>

        {/* 쿠팡 다운로드 토글 */}
        <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
          <button
            onClick={() => { setShowCoupang(v => !v); setShowInvoice(false); setShowUpload(false); setShowGlobalFake(false); }}
            className={`px-3 py-1 rounded-full text-[11px] font-black transition-all duration-200 border ${
              showCoupang
                ? 'bg-zinc-700 text-white border-zinc-600'
                : 'text-zinc-500 hover:text-white border-zinc-700/50 hover:border-zinc-600 hover:bg-zinc-800'
            }`}
          >
            쿠팡 주문
          </button>
          <div className={`absolute right-0 top-full mt-2 z-50 w-[480px] bg-zinc-900 border border-zinc-700/50 rounded-2xl shadow-2xl max-h-[calc(100vh-70px)] overflow-y-auto ${showCoupang ? '' : 'hidden'}`}>
            <CoupangDownloader
              businesses={allBusinesses.map(b => ({ id: b.id, displayName: b.displayName }))}
              onRegisterDirectUpload={(fn) => { directCoupangUploadRef.current = fn; }}
            />
          </div>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="text-zinc-600 hover:text-zinc-400 transition-colors"
          title="사업자 추가"
        >
          <PlusCircleIcon className="w-4 h-4" />
        </button>
      </div>

      {/* 가로 스크롤 패널 — flex-1로 나머지 높이 채움 */}
      {businessListLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="w-8 h-8 border-[3px] border-rose-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-zinc-500 font-bold text-sm">데이터 로딩 중...</p>
          </div>
        </div>
      ) : (
        <div
          ref={scrollContainerRef}
          className="flex flex-1 overflow-x-auto overflow-y-hidden"
          style={{ scrollSnapType: 'x mandatory' }}
        >
          {allBusinesses.map((b, i) => (
            <BusinessColumn
              key={b.id}
              businessId={b.id}
              displayName={b.displayName}
              portalId={`manual-order-portal-${b.id}`}
              themeColor={dimThemeColor(b.themeColor)}
              bank={b.bank}
              sharedSuppliers={sharedSuppliers.config}
              initiallyMounted={true}
              onRegisterMasterUpload={handleRegisterMasterUpload}
              onRegisterReset={handleRegisterReset}
              onRegisterDownloadActions={handleRegisterDownloadActions}
              onWorkstationReset={() => {
                setUploadResults(prev => prev.filter(r => r.businessId !== b.id));
              }}
              refreshKey={refreshKeys[b.id] ?? 0}
              globalFakeOrderInput={perBusinessFakeInput[b.id] || ''}
              onGlobalFakeMatch={(matched) => handleGlobalFakeMatch(b.id, matched)}
              globalUnsentOrderInput={perBusinessUnsentInput[b.id] || ''}
              onEdit={b.isDynamic ? () => setEditingBusiness(b) : undefined}
              onExposeOrderRows={(header, dataRows) => handleExposeOrderRows(b.id, header, dataRows)}
              onWarningUpdate={(_sessionId, has) => setBusinessWarnings(prev => prev[b.id] === has ? prev : { ...prev, [b.id]: has })}
            />
          ))}
        </div>
      )}

      {/* 일괄 입금목록 모달 */}
      {showBulkDepositModal && (() => {
        const lines = bulkPasteText.trim().split('\n').filter(l => l.trim());
        const grouped: Record<string, DepositExtraRow[]> = {};
        const unmatched: string[] = [];
        lines.forEach(line => {
          const cols = line.split('\t');
          if (cols.length < 3) { unmatched.push(line); return; }
          const bankName = cols[0]?.trim() || '';
          const accountNumber = cols[1]?.trim() || '';
          const amount = cols[2]?.trim() || '';
          const label = cols[3]?.trim() || '';
          const bizRaw = (cols[4]?.trim() || '').replace(/\s*환불$/, '').trim();
          const matched = allBusinesses.find(b => b.displayName === bizRaw || b.id === bizRaw || b.displayName.includes(bizRaw) || (bizRaw.length > 1 && bizRaw.includes(b.displayName)));
          if (matched) {
            if (!grouped[matched.id]) grouped[matched.id] = [];
            grouped[matched.id].push({ bankName, accountNumber, amount, label });
          } else {
            unmatched.push(line);
          }
        });
        // 기존 행이 있거나 붙여넣기 매칭된 사업자 모두 표시
        const allRelevantIds = [...new Set([
          ...Object.keys(bulkBaseRowsMap).filter(id => (bulkBaseRowsMap[id]?.length ?? 0) > 0),
          ...Object.keys(grouped),
        ])];
        const handleDownload = () => {
          if (allRelevantIds.length === 0) { alert('다운로드할 내역이 없습니다.'); return; }
          allRelevantIds.forEach(id => {
            const base = bulkBaseRowsMap[id] ?? [];
            const extra = grouped[id] ?? [];
            if (base.length > 0 || extra.length > 0) {
              downloadActionsRef.current[id]?.downloadDepositListDirect(base, extra);
            }
          });
          setShowBulkDepositModal(false);
        };
        return (
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) setShowBulkDepositModal(false); }}>
            <div className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-full max-w-2xl mx-4 flex flex-col max-h-[90vh]">
              <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
                <div>
                  <h3 className="text-white font-black text-sm">일괄 입금목록</h3>
                  <p className="text-zinc-500 text-[11px] mt-0.5">붙여넣기 — 열 순서: 은행 / 계좌번호 / 금액 / 이름 / 사업자명 환불</p>
                </div>
                <button onClick={() => setShowBulkDepositModal(false)} className="text-zinc-500 hover:text-white transition-colors p-1">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
                {/* 사업자별 기존 입금 항목 + 붙여넣기 매칭 행 */}
                {allRelevantIds.map(id => {
                  const biz = allBusinesses.find(b => b.id === id);
                  const baseRows = bulkBaseRowsMap[id] ?? [];
                  const extraRows = grouped[id] ?? [];
                  const totalCount = baseRows.length + extraRows.length;
                  return (
                    <div key={id} className="bg-zinc-950 rounded-xl border border-zinc-800 overflow-hidden">
                      <div className="px-4 py-2 border-b border-zinc-800 flex items-center justify-between">
                        <p className="text-[11px] font-black text-white">{biz?.displayName || id}</p>
                        <span className="text-zinc-600 text-[10px] font-bold">{totalCount}건</span>
                      </div>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-zinc-600 text-[10px] font-black border-b border-zinc-800">
                            <th className="px-3 py-1.5 text-left">은행</th>
                            <th className="px-3 py-1.5 text-left">계좌번호</th>
                            <th className="px-3 py-1.5 text-right">금액</th>
                            <th className="px-3 py-1.5 text-left">비고</th>
                            <th className="px-3 py-1.5 w-6" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-900">
                          {baseRows.map((r, i) => (
                            <tr key={`base-${i}`} className="text-zinc-400 group">
                              <td className="px-3 py-1.5">{r[0]}</td>
                              <td className="px-3 py-1.5 font-mono">{r[1]}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">{Number(r[2]).toLocaleString()}</td>
                              <td className="px-3 py-1.5 text-zinc-500">{r[3]}</td>
                              <td className="px-3 py-1.5">
                                <button
                                  onClick={() => setBulkBaseRowsMap(prev => ({ ...prev, [id]: (prev[id] ?? []).filter((_, j) => j !== i) }))}
                                  className="text-zinc-700 hover:text-rose-400 transition-colors opacity-0 group-hover:opacity-100"
                                >
                                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                              </td>
                            </tr>
                          ))}
                          {extraRows.map((r, i) => (
                            <tr key={`extra-${i}`} className="text-zinc-500 bg-emerald-950/20">
                              <td className="px-3 py-1.5">{r.bankName}</td>
                              <td className="px-3 py-1.5 font-mono">{r.accountNumber}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">{Number(r.amount).toLocaleString()}</td>
                              <td className="px-3 py-1.5 text-zinc-600">{r.label}</td>
                              <td className="px-3 py-1.5" />
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
                {/* 붙여넣기 영역 */}
                <div>
                  <p className="text-zinc-600 text-[10px] font-bold mb-1.5">엑셀에서 복사 후 붙여넣기 (열 순서: 은행 / 계좌번호 / 금액 / 이름 / 사업자명 환불)</p>
                  <textarea
                    rows={4}
                    value={bulkPasteText}
                    onChange={e => setBulkPasteText(e.target.value)}
                    placeholder={"기업\t490-048665-01-021\t17400\t장혜옥\t안군농원 환불\n기업\t490-048665-01-021\t12000\t홍길동\t조에 환불"}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-zinc-300 font-mono placeholder-zinc-700 focus:ring-1 focus:ring-emerald-500/30 outline-none resize-none"
                  />
                </div>
                {unmatched.length > 0 && (
                  <div className="bg-zinc-950 rounded-xl border border-rose-500/30 px-4 py-2.5">
                    <p className="text-[11px] font-black text-rose-400 mb-1.5">미매칭 {unmatched.length}건</p>
                    {unmatched.map((l, i) => <p key={i} className="text-[11px] text-zinc-500 font-mono truncate">{l}</p>)}
                  </div>
                )}
              </div>
              <div className="px-6 py-4 border-t border-zinc-800 flex justify-end gap-2">
                <button onClick={() => setShowBulkDepositModal(false)} className="px-4 py-2 text-xs font-bold text-zinc-400 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-xl transition-all">취소</button>
                <button onClick={handleDownload} disabled={allRelevantIds.length === 0} className="flex items-center gap-2 px-5 py-2 text-xs font-black text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl transition-all">
                  <ArrowDownTrayIcon className="w-3.5 h-3.5" />
                  {allRelevantIds.length > 0 ? `${allRelevantIds.length}개 사업자 다운로드` : '다운로드'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 사업자 추가/편집 모달 */}
      <AddBusinessModal
        key={editingBusiness?.id ?? (showAddModal ? 'add' : '')}
        isOpen={showAddModal || !!editingBusiness}
        onClose={() => { setShowAddModal(false); setEditingBusiness(null); }}
        onAdd={addBusiness}
        onEdit={async (id, updates) => { await updateBusiness(id, updates); setEditingBusiness(null); }}
        existingIds={allBusinesses.map(b => b.id)}
        editingBusiness={editingBusiness ?? undefined}
      />

      {quotaExceeded && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="bg-zinc-900 border border-red-500/60 rounded-2xl p-8 max-w-sm w-full mx-4 shadow-2xl text-center">
            <div className="text-4xl mb-4">🚫</div>
            <h2 className="text-red-400 font-black text-lg mb-2">Firestore 일일 한도 초과</h2>
            <p className="text-zinc-300 text-sm leading-relaxed mb-1">오늘 사용 가능한 Firestore 읽기/쓰기 횟수를 모두 소진했어요.</p>
            <p className="text-zinc-500 text-xs leading-relaxed mb-6">자정(00:00)이 지나면 자동으로 초기화됩니다.</p>
            <button onClick={() => setQuotaExceeded(false)} className="px-6 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-xl text-zinc-200 text-sm font-bold transition-colors">닫기</button>
          </div>
        </div>
      )}

    </div>
  );
};

export default App;
