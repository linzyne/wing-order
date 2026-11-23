import React, { useEffect, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import CsEntryModal, { type CsDraft, resolveOrderRowFields, refineOrderRowFieldsByValue, normalizeForSearch, buildCsDraft, buildCsDraftFromRecord, deleteCsRecord, revertCsRecordToPending } from './CsEntryModal';
import { getHeaderForCompany, inferFieldFromHeader } from '../hooks/useConsolidatedOrderConverter';
import type { CsRecord, PricingConfig, ManualOrder } from '../types';
import { getCsVendorStatus, getCsCustomerStatus, isCsFullyCompleted } from '../types';
import { CS_SYNC_EVENT, getCsSyncState, clearCsSyncFailures, subscribeOpenCs, subscribeRecentOrderSearch, writeCsItem, type CsSyncState, type OpenCsEntry } from '../services/firestoreService';
import type { DailySales } from '../types';

interface Business { id: string; displayName: string; themeColor?: string; }

/** 사업자 설정의 테마색을 그대로 글자색으로 쓴다. 미설정/기본(검정)이면 보라색 폴백 */
function businessTextColor(themeColor?: string): string {
  if (!themeColor || themeColor === '#09090b') return '#a78bfa';
  return themeColor;
}

interface OpenCsItem extends CsRecord {
  date: string;
  businessId: string;
  businessName: string;
  /** 아직 서버에 안 간 저장이 있음 */
  syncing?: boolean;
}

type OrderRowEntry = { company: string; row: any[]; orderNumber: string; recipientName: string };
const flattenOrderRows = (history: DailySales[]): OrderRowEntry[] => {
  const rows: OrderRowEntry[] = [];
  history.forEach(d => {
    if (d.companyOrderRows) {
      Object.entries(d.companyOrderRows).forEach(([company, companyRows]) => {
        // companyOrderNumbers/companyRecipientNames[company]는 companyOrderRows[company]와 동일한 순서/길이
        const nums = d.companyOrderNumbers?.[company] || [];
        const names = d.companyRecipientNames?.[company] || [];
        (companyRows as any[][]).forEach((row, i) => rows.push({ company, row, orderNumber: nums[i] || '', recipientName: names[i] || '' }));
      });
    } else if (d.orderRows) {
      d.orderRows.forEach(row => rows.push({ company: '', row, orderNumber: '', recipientName: '' }));
    }
  });
  return rows;
};

interface Props {
  businesses: Business[];
  onClose: () => void;
  onCreatePurchaseOrder: (businessId: string, company: string, mo: Omit<ManualOrder, 'id' | 'companyName'>) => Promise<boolean>;
  /** 대기로 되돌릴 때 그 CS로 발주서에 덧붙였던 재배송 행을 제거 (기록이 있는 세션이 있을 때만 true) */
  onRemovePurchaseOrder?: (businessId: string, company: string, csRecordId: string) => boolean;
}

/** 발주내역 행에서 업체 헤더 구조를 참고해 전화번호/주소 열을 찾아낸다 (resolveOrderRowFields의 phone/address 버전) */
function resolvePhoneAddress(company: string, row: any[], pricingConfig?: PricingConfig): { phone: string; address: string } {
  const config = pricingConfig?.[company];
  const headers = config ? getHeaderForCompany(company, config) : [];
  let phoneIdx = -1, addressIdx = -1;
  headers.forEach((h, idx) => {
    const field = config?.orderFormFieldMap?.[idx] || inferFieldFromHeader(h);
    if (field === 'recipientPhone' && phoneIdx === -1) phoneIdx = idx;
    if (field === 'recipientAddress' && addressIdx === -1) addressIdx = idx;
  });
  return {
    phone: phoneIdx >= 0 ? String(row[phoneIdx] ?? '') : '',
    address: addressIdx >= 0 ? String(row[addressIdx] ?? '') : '',
  };
}

/** navigator.clipboard 실패(비보안 컨텍스트, 권한 거부 등) 시 execCommand로 폴백 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 폴백으로 이어짐
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/** CS 항목의 원본 발주내역을 주문번호로 찾아 팝업으로 보여준다 (이름이 아닌 주문번호로만 매칭) */
const OrderDetailModal: React.FC<{ item: OpenCsItem; onClose: () => void }> = ({ item, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [row, setRow] = useState<any[] | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);

  useEffect(() => {
    // 접수 시점에 원본 행을 스냅샷으로 저장해두므로 대부분 바로 표시된다.
    // 스냅샷이 없는 구버전 CS 기록만 전체 발주 이력에서 주문번호로 재검색한다.
    if (item.orderRowSnapshot) {
      setRow(item.orderRowSnapshot);
      setHeaders(item.orderRowHeaders || []);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { loadAllOrderSearch, loadPricingConfig } = await import('../services/firestoreService');
      const [history, configResult] = await Promise.all([
        loadAllOrderSearch(item.businessId),
        loadPricingConfig(item.businessId),
      ]);
      if (cancelled) return;
      const companyConfig = configResult.config?.[item.company];
      const hdrs = companyConfig ? getHeaderForCompany(item.company, companyConfig) : [];
      let found: any[] | null = null;
      for (const d of history) {
        const rows = d.companyOrderRows
          ? (d.companyOrderRows[item.company] || [])
          : (d.orderRows || []);
        // 저장된 원본 주문번호 목록으로 우선 매칭 (발주서 행에는 묶음배송번호만 있을 수 있음)
        const nums = d.companyOrderNumbers?.[item.company] || [];
        const idxByOrderNumber = nums.findIndex(n => n && n.split(',').map(s => s.trim()).includes(item.orderNumber));
        if (idxByOrderNumber >= 0 && rows[idxByOrderNumber]) { found = rows[idxByOrderNumber]; break; }
        found = rows.find(r => resolveOrderRowFields(item.company, r, configResult.config || undefined).orderNumber === item.orderNumber) || null;
        if (found) break;
      }
      setRow(found);
      setHeaders(hdrs);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [item]);

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative bg-zinc-900 border border-zinc-700 rounded-[2rem] shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <div className="min-w-0">
            <div className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-1">발주내역</div>
            <div className="text-white font-black text-lg truncate">{item.recipientName || '이름없음'} · {item.orderNumber || '주문번호없음'}</div>
            <div className="text-[11px] text-zinc-500 font-bold mt-0.5">{item.businessName} · {item.company} · {item.date}</div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-600 hover:text-white transition-colors text-2xl font-bold w-9 h-9 flex items-center justify-center rounded-xl hover:bg-zinc-800 shrink-0"
          >
            ×
          </button>
        </div>

        <div className="overflow-y-auto custom-scrollbar flex-1 px-6 py-5">
          {loading ? (
            <p className="text-zinc-600 text-xs font-bold text-center py-6">불러오는 중...</p>
          ) : !row ? (
            <p className="text-zinc-600 text-xs font-bold text-center py-6">발주내역을 찾을 수 없습니다.</p>
          ) : (
            <div className="space-y-0.5">
              {headers.map((h, idx) => {
                const value = row[idx];
                if (!h || value == null || String(value) === '') return null;
                return (
                  <div key={idx} className="flex items-start justify-between gap-3 py-1.5 border-b border-zinc-800/60 last:border-0">
                    <span className="text-zinc-500 text-xs font-bold shrink-0">{h}</span>
                    <span className="text-white text-xs font-bold text-right break-all">{String(value)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

const ConsolidatedCsPanel: React.FC<Props> = ({ businesses, onClose, onCreatePurchaseOrder, onRemovePurchaseOrder }) => {
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  const [creatingPoId, setCreatingPoId] = useState<string | null>(null);
  const [revertingKey, setRevertingKey] = useState<string | null>(null);
  const [viewingItem, setViewingItem] = useState<OpenCsItem | null>(null);

  // 검색용: 사업자 먼저 선택 → 그 사업자의 발주내역만 대상으로 검색 (사업자마다 같은 주문번호가 있을 수 있어 섞으면 안 됨)
  const [selectedBusinessId, setSelectedBusinessId] = useState('');
  const [search, setSearch] = useState('');
  // 기본은 최근 45일 발주내역만 (전체 이력은 문서 수백 개라 느림). 못 찾으면 전체로 넓힌다.
  const [searchAllHistory, setSearchAllHistory] = useState(false);
  const [allHistoryRows, setAllHistoryRows] = useState<OrderRowEntry[] | null>(null);
  const [manualCompany, setManualCompany] = useState('');
  const [csDraft, setCsDraft] = useState<CsDraft | null>(null);
  const [editing, setEditing] = useState<{ date: string; record: OpenCsItem; businessId: string } | null>(null);
  const [editingPricingConfig, setEditingPricingConfig] = useState<PricingConfig | undefined>(undefined);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  // 패널이 열리면 모든 사업자의 미완료 CS·최근 45일 발주내역·품목설정을 한꺼번에 받아 둔다(구독).
  // 업체 드롭다운을 바꿀 땐 받아 둔 것에서 고르기만 해서 기다릴 게 없다.
  const [openCsByBiz, setOpenCsByBiz] = useState<Record<string, OpenCsEntry[] | null>>({});
  const [recentByBiz, setRecentByBiz] = useState<Record<string, DailySales[] | null>>({});
  const [pricingByBiz, setPricingByBiz] = useState<Record<string, PricingConfig | null | undefined>>({});
  useEffect(() => {
    const t0 = performance.now();
    const logged = new Set<string>();
    const logOnce = (k: string) => { if (!logged.has(k)) { logged.add(k); console.info(`[CS 속도] ${k} ${Math.round(performance.now() - t0)}ms`); } };
    const unsubs = businesses.flatMap(b => [
      subscribeOpenCs(b.id, list => {
        if (list) logOnce(`${b.displayName} CS 목록`);
        setOpenCsByBiz(prev => ({ ...prev, [b.id]: list }));
      }),
      subscribeRecentOrderSearch(b.id, list => {
        if (list) logOnce(`${b.displayName} 최근 45일 발주내역`);
        setRecentByBiz(prev => ({ ...prev, [b.id]: list }));
      }),
    ]);
    let cancelled = false;
    import('../services/firestoreService').then(({ loadPricingConfig }) => {
      businesses.forEach(b => loadPricingConfig(b.id).then(r => {
        if (!cancelled) setPricingByBiz(prev => ({ ...prev, [b.id]: r.config }));
      }));
    });
    return () => { cancelled = true; unsubs.forEach(u => u()); };
  }, [businesses]);

  const loading = businesses.some(b => !openCsByBiz[b.id]);
  const { items, pendingItems } = useMemo(() => {
    const open: OpenCsItem[] = [];
    const pending: OpenCsItem[] = [];
    businesses.forEach(b => (openCsByBiz[b.id] || []).forEach(r => {
      const item: OpenCsItem = { ...r, businessId: b.id, businessName: b.displayName };
      if (r.pending) pending.push(item);
      else if (!isCsFullyCompleted(r)) open.push(item);
    }));
    const byCreated = (a: OpenCsItem, b: OpenCsItem) => (a.createdAt || '').localeCompare(b.createdAt || '');
    return { items: open.sort(byCreated), pendingItems: pending.sort(byCreated) };
  }, [businesses, openCsByBiz]);

  // 뒤에서 서버로 보내는 중인 저장 수·실패
  const [sync, setSync] = useState<CsSyncState>(getCsSyncState);
  useEffect(() => {
    const handler = (e: Event) => setSync((e as CustomEvent<CsSyncState>).detail);
    window.addEventListener(CS_SYNC_EVENT, handler);
    return () => window.removeEventListener(CS_SYNC_EVENT, handler);
  }, []);

  useEffect(() => { setSearch(''); setManualCompany(''); setAllHistoryRows(null); }, [selectedBusinessId]);
  useEffect(() => {
    if (!selectedBusinessId || !searchAllHistory) return;
    let cancelled = false;
    setAllHistoryRows(null);
    import('../services/firestoreService').then(({ loadAllOrderSearch }) => loadAllOrderSearch(selectedBusinessId)).then(history => {
      if (!cancelled) setAllHistoryRows(flattenOrderRows(history));
    });
    return () => { cancelled = true; };
  }, [selectedBusinessId, searchAllHistory]);

  const recentRows = useMemo(() => {
    const history = recentByBiz[selectedBusinessId];
    return history ? flattenOrderRows(history) : null;
  }, [recentByBiz, selectedBusinessId]);
  const businessOrderRows = (searchAllHistory ? allHistoryRows : recentRows) || [];
  const businessPricingConfig = pricingByBiz[selectedBusinessId] ?? null;
  const loadingBusinessData = !!selectedBusinessId
    && ((searchAllHistory ? allHistoryRows : recentRows) === null || pricingByBiz[selectedBusinessId] === undefined);

  // 검색 색인: 표시에 쓸 필드와 검색용 문자열을 한 번만 만들어 둔다 (타이핑마다 재계산 방지).
  // 이름 소스 우선순위: 저장된 수취인 이름 → 값 기반 보정 → 헤더 추측.
  // (업체 발주양식에 이름 칸이 없거나 헤더명이 인식 안 되면 헤더 추측만으로는 이름이 비거나 주소가 들어옴)
  const searchIndex = useMemo(() => {
    return businessOrderRows.map(({ company, row, orderNumber, recipientName }) => {
      const base = resolveOrderRowFields(company, row, businessPricingConfig || undefined);
      const refined = refineOrderRowFieldsByValue(base, row, businessPricingConfig?.[company], company);
      const fields = recipientName ? { ...refined, recipientName } : refined;
      // 셀 경계를 넘는 오매칭(예: "강" 셀 + "경희" 셀)을 막으려고 구분자로 이어붙인다
      const haystack = normalizeForSearch(
        [orderNumber, recipientName, fields.recipientName, fields.productName, ...row].join('\u0001')
      );
      return { company, row, orderNumber, fields, haystack };
    });
  }, [businessOrderRows, businessPricingConfig]);

  const searchResults = useMemo(() => {
    const q = normalizeForSearch(search);
    if (!q) return [];
    return searchIndex.filter(r => r.haystack.includes(q)).slice(0, 50);
  }, [searchIndex, search]);

  const openOrderNumbersForBusiness = useMemo(() => {
    const set = new Set<string>();
    items.filter(i => i.businessId === selectedBusinessId).forEach(i => set.add(i.orderNumber));
    return set;
  }, [items, selectedBusinessId]);

  // 누르는 즉시 화면(구독)에 반영되고 서버 저장은 뒤에서
  const handleToggleSide = (item: OpenCsItem, side: 'vendor' | 'customer') => {
    const isVendor = side === 'vendor';
    const now = new Date().toISOString();
    const currentStatus = isVendor ? getCsVendorStatus(item) : getCsCustomerStatus(item);
    const nextStatus = currentStatus === '접수' ? '완료' as const : '접수' as const;
    writeCsItem(item.businessId, item.date, {
      ...item,
      vendorStatus: isVendor ? nextStatus : getCsVendorStatus(item),
      customerStatus: isVendor ? getCsCustomerStatus(item) : nextStatus,
      vendorCompletedAt: isVendor ? (nextStatus === '완료' ? now : undefined) : item.vendorCompletedAt,
      customerCompletedAt: isVendor ? item.customerCompletedAt : (nextStatus === '완료' ? now : undefined),
    }).catch(() => {});
  };

  const handleSendToVendor = async (item: OpenCsItem) => {
    const key = `${item.businessId}-${item.id}`;
    setSendingId(key);
    try {
      let supplyPrice = item.supplyPrice;
      if (supplyPrice == null && item.productKey) {
        const { loadPricingConfig } = await import('../services/firestoreService');
        const { config } = await loadPricingConfig(item.businessId);
        supplyPrice = (config?.[item.company]?.products?.[item.productKey] as any)?.supplyPrice;
      }
      const text = [
        `이름: ${item.recipientName || '-'}`,
        `품목명: ${item.productName || '-'}`,
        `공급가: ${(supplyPrice || 0).toLocaleString()}원`,
        `사유: ${item.reason}`,
        `처리: ${item.customerMethod}`,
      ].join('\n');
      const ok = await copyToClipboard(text);
      if (ok) {
        setSentId(key);
        setTimeout(() => setSentId(null), 2000);
      } else {
        alert(`클립보드 복사에 실패했습니다. 아래 내용을 직접 복사해주세요:\n\n${text}`);
      }
    } finally {
      setSendingId(null);
    }
  };

  const handleCreatePurchaseOrder = async (item: OpenCsItem) => {
    const key = `${item.businessId}-${item.id}`;
    setCreatingPoId(key);
    try {
      const config = pricingByBiz[item.businessId]
        ?? (await (await import('../services/firestoreService')).loadPricingConfig(item.businessId)).config;
      const row = item.orderRowSnapshot || [];
      const fields = resolveOrderRowFields(item.company, row, config || undefined);
      const { phone, address } = resolvePhoneAddress(item.company, row, config || undefined);
      if (!fields.recipientName || !fields.productName) {
        alert('원본 발주 정보가 없어 발주서를 생성할 수 없습니다.');
        return;
      }
      const ok = await onCreatePurchaseOrder(item.businessId, item.company, {
        recipientName: fields.recipientName,
        phone,
        address,
        productName: fields.productName,
        qty: fields.qty,
        productKey: item.productKey,
        memo: `${item.orderNumber || ''} 재배송`.trim(),
        csRecordId: item.id,
      });
      if (!ok) {
        alert('발주서 추가에 실패했습니다. 해당 사업자 탭이 열려있는지 확인해주세요.');
        return;
      }
      writeCsItem(item.businessId, item.date, { ...item, poAdded: true }).catch(() => {});
    } finally {
      setCreatingPoId(null);
    }
  };

  const handleEdit = async (item: OpenCsItem) => {
    const config = pricingByBiz[item.businessId]
      ?? (await (await import('../services/firestoreService')).loadPricingConfig(item.businessId)).config;
    setEditingPricingConfig(config || undefined);
    setEditing({ date: item.date, record: item, businessId: item.businessId });
    setCsDraft(buildCsDraftFromRecord(item));
  };

  const handleRevertToPending = async (item: OpenCsItem) => {
    if (!window.confirm(`${item.recipientName || '이름없음'} · ${item.orderNumber || '주문번호없음'} 건을 접수대기 상태로 되돌리시겠습니까?\n확정 시 반영된 발주서 재배송 행/반품기록/정산조정/계좌이체 내역이 함께 취소됩니다.`)) return;
    const key = `${item.businessId}-${item.id}`;
    setRevertingKey(key);
    try {
      // 발주서에 덧붙였던 재배송 행 먼저 제거. 이 CS로 추가했다는 기록이 남은 세션만 반응한다.
      // (기록이 없는 예전 건, 또는 해당 사업자 발주 화면이 안 열린 경우에는 지워지지 않으므로 그때만 안내한다)
      const poRemoved = item.poAdded ? (onRemovePurchaseOrder?.(item.businessId, item.company, item.id) ?? false) : true;
      await revertCsRecordToPending(item.businessId, item.date, item);
      if (!poRemoved) {
        alert('공급가차감과 "발주서생성됨" 표시는 풀었지만, 발주서에 추가된 재배송 행은 자동으로 지우지 못했습니다.\n해당 사업자의 발주 화면을 열어둔 상태에서 되돌리거나, 발주서에서 그 행을 직접 지운 뒤 다시 확정해주세요.');
      }
    } finally {
      setRevertingKey(null);
    }
  };

  const handleDelete = async (item: OpenCsItem) => {
    if (!window.confirm(`${item.recipientName || '이름없음'} · ${item.orderNumber || '주문번호없음'} CS 접수를 삭제하시겠습니까?`)) return;
    const key = `${item.businessId}-${item.id}`;
    setDeletingKey(key);
    try {
      // 되돌리기와 동일하게, 이 CS로 발주서에 덧붙였던 재배송 행도 함께 걷어낸다
      if (item.poAdded) onRemovePurchaseOrder?.(item.businessId, item.company, item.id);
      await deleteCsRecord(item.businessId, item.date, item);
    } finally {
      setDeletingKey(null);
    }
  };

  const closeCsModal = () => {
    setCsDraft(null);
    setEditing(null);
    setEditingPricingConfig(undefined);
  };

  const selectedBusinessName = businesses.find(b => b.id === selectedBusinessId)?.displayName || '';

  const businessColorById = useMemo(() => {
    const map: Record<string, string> = {};
    businesses.forEach(b => { map[b.id] = businessTextColor(b.themeColor); });
    return map;
  }, [businesses]);

  return (
    <div className="p-4" onMouseDown={e => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-3 px-2">
        <div>
          <h3 className="text-white font-black text-sm">통합 CS 현황</h3>
          <p className="text-zinc-600 text-[10px] font-bold mt-0.5">접수 중인 건만 표시 · 완료 처리하면 자동으로 사라집니다</p>
        </div>
        <button onClick={onClose} className="text-zinc-600 hover:text-white transition-colors text-2xl leading-none w-7 h-7 flex items-center justify-center rounded-lg hover:bg-zinc-800">×</button>
      </div>

      {(sync.pending > 0 || sync.failures.length > 0) && (
        <div className="px-2 mb-3 space-y-1">
          {sync.pending > 0 && (
            <p className="text-amber-400 text-[11px] font-black">서버로 보내는 중 {sync.pending}건 · 끝나기 전에 창을 닫지 마세요</p>
          )}
          {sync.failures.length > 0 && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2">
              {sync.failures.map((f, i) => (
                <p key={i} className="text-rose-400 text-[11px] font-black">저장 실패: {f.label} — {f.message}</p>
              ))}
              <button onClick={clearCsSyncFailures} className="mt-1 text-[10px] font-black text-zinc-400 hover:text-white">확인했음</button>
            </div>
          )}
        </div>
      )}

      {pendingItems.length > 0 && (
        <div className="px-2 mb-3">
          <p className="text-zinc-500 text-[10px] font-black uppercase tracking-widest mb-1.5">대기중 CS ({pendingItems.length}건)</p>
          <div className="space-y-1.5 max-h-56 overflow-y-auto custom-scrollbar pr-1">
            {pendingItems.map(item => {
              const key = `${item.businessId}-${item.id}`;
              return (
                <div key={key} className="rounded-lg px-3 py-2 flex items-center justify-between gap-2 border bg-sky-500/5 border-sky-500/20">
                  <div className="min-w-0">
                    <div className="font-black text-sm truncate text-white">
                      {item.recipientName || '이름없음'} · {item.orderNumber || '주문번호없음'}
                      {item.syncing && <span className="ml-1 text-[10px] text-amber-400">저장 중</span>}
                    </div>
                    <div className="text-xs font-black truncate mt-0.5">
                      <span style={{ color: businessColorById[item.businessId] || '#a78bfa' }}>{item.businessName || '사업자없음'}</span>
                      <span className="text-zinc-600">(</span>
                      <span className="text-zinc-300">{item.company || '공급사없음'}</span>
                      <span className="text-zinc-600">)</span>
                      <span className="text-zinc-500 font-bold"> · {item.customerMethod} · {item.reason}</span>
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-1">
                    <button
                      onClick={() => handleSendToVendor(item)}
                      disabled={sendingId === key}
                      className="px-2 py-1 rounded-lg bg-sky-500/10 text-sky-400 hover:bg-sky-500/20 disabled:opacity-50 text-[10px] font-black border border-sky-500/20 transition-colors"
                    >
                      {sentId === key ? '복사됨' : sendingId === key ? '복사 중...' : '업체전송'}
                    </button>
                    <button
                      onClick={() => handleEdit(item)}
                      className="px-2 py-1 rounded-lg bg-sky-500/10 text-sky-400 hover:bg-sky-500/20 text-[10px] font-black border border-sky-500/20 transition-colors"
                    >
                      수정/확정
                    </button>
                    <button
                      onClick={() => handleDelete(item)}
                      disabled={deletingKey === key}
                      className="px-2 py-1 rounded-lg bg-zinc-800 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-40 text-[10px] font-black border border-zinc-700 transition-colors"
                    >
                      {deletingKey === key ? '삭제 중...' : '삭제'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 사업자 선택 + 검색 → CS 접수 */}
      <div className="px-2 mb-3 space-y-2">
        <select
          value={selectedBusinessId}
          onChange={e => { setSearchAllHistory(false); setSelectedBusinessId(e.target.value); }}
          className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-white outline-none focus:ring-1 focus:ring-violet-500/30 focus:border-violet-500/30"
        >
          <option value="">CS 접수할 사업자 선택...</option>
          {businesses.map(b => <option key={b.id} value={b.id}>{b.displayName}</option>)}
        </select>

        {selectedBusinessId && (
          <div className="relative">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={loadingBusinessData ? `${selectedBusinessName} 발주내역 불러오는 중...` : `${selectedBusinessName}에서 이름, 주문번호로 검색...`}
              disabled={loadingBusinessData}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:ring-1 focus:ring-violet-500/30 focus:border-violet-500/30 outline-none disabled:opacity-50"
            />
          </div>
        )}

        {selectedBusinessId && !loadingBusinessData && (
          <div className="flex items-center gap-2">
            <select
              value={manualCompany}
              onChange={e => setManualCompany(e.target.value)}
              className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-white outline-none focus:ring-1 focus:ring-violet-500/30 focus:border-violet-500/30"
            >
              <option value="">발주내역 없이 수동 접수할 업체 선택...</option>
              {Object.keys(businessPricingConfig || {}).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <button
              onClick={() => manualCompany && setCsDraft(buildCsDraft(manualCompany, [], businessPricingConfig || undefined))}
              disabled={!manualCompany}
              className="shrink-0 px-3 py-2 rounded-xl bg-zinc-700/50 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 text-xs font-black border border-zinc-600/40 transition-colors"
            >
              수동 접수
            </button>
          </div>
        )}

        {selectedBusinessId && search.trim() && (
          <div className="space-y-1.5 max-h-64 overflow-y-auto custom-scrollbar pr-1">
            {searchResults.length === 0 ? (
              <div className="text-center py-3">
                <p className="text-zinc-600 text-xs font-bold">{searchAllHistory ? '검색 결과가 없습니다.' : '최근 45일 발주내역에 없습니다.'}</p>
                {!searchAllHistory && !loadingBusinessData && (
                  <button onClick={() => setSearchAllHistory(true)} className="mt-1.5 text-[11px] font-black text-violet-400 hover:text-violet-300">
                    전체 기간에서 찾기 (느림)
                  </button>
                )}
              </div>
            ) : searchResults.map(({ company, row, orderNumber, fields }, i) => {
              const displayOrderNumber = orderNumber || fields.orderNumber;
              const isOpen = (orderNumber && openOrderNumbersForBusiness.has(orderNumber))
                || (fields.orderNumber && openOrderNumbersForBusiness.has(fields.orderNumber));
              return (
                <div key={i} className="bg-zinc-800/50 border border-zinc-700/40 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-white font-bold text-xs truncate">{fields.recipientName || '이름없음'} · {displayOrderNumber || '주문번호없음'}</div>
                    <div className="text-zinc-500 text-[10px] font-bold truncate">
                      {company} · {fields.productName}{fields.qty > 1 ? ` x${fields.qty}` : ''}
                      {orderNumber && orderNumber !== fields.orderNumber && fields.orderNumber ? ` · 묶음 ${fields.orderNumber}` : ''}
                    </div>
                  </div>
                  {isOpen ? (
                    <span className="shrink-0 text-[10px] bg-amber-500/10 text-amber-400 px-2 py-1 rounded-full font-black border border-amber-500/20">CS 처리중</span>
                  ) : (
                    <button
                      onClick={() => {
                        const draft = buildCsDraft(company, row, businessPricingConfig || undefined);
                        // 화면에 보인 이름/품목(저장값·값 기반 보정 반영)을 그대로 초안에 넣는다
                        setCsDraft({
                          ...draft,
                          ...(orderNumber ? { orderNumber } : {}),
                          ...(fields.recipientName ? { recipientName: fields.recipientName } : {}),
                          ...(!draft.productName && fields.productName ? { productName: fields.productName } : {}),
                        });
                      }}
                      className="shrink-0 px-2 py-1 rounded-lg bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 text-[10px] font-black border border-rose-500/20 transition-colors"
                    >
                      CS 접수
                    </button>
                  )}
                </div>
              );
            })}
            {searchResults.length === 50 && (
              <p className="text-zinc-700 text-[10px] font-bold text-center">결과가 많아 50건까지만 표시됩니다. 검색어를 좁혀보세요.</p>
            )}
          </div>
        )}
      </div>

      <div className="h-px bg-zinc-800 mx-2 mb-3" />

      {loading ? (
        <p className="text-zinc-600 text-xs font-bold text-center py-10">불러오는 중...</p>
      ) : items.length === 0 ? (
        <p className="text-zinc-600 text-xs font-bold text-center py-10">진행중인 CS가 없습니다.</p>
      ) : (
        <div className="space-y-2 max-h-[50vh] overflow-y-auto custom-scrollbar px-1">
          {items.map(item => {
            const key = `${item.businessId}-${item.id}`;
            return (
              <div
                key={key}
                onClick={() => setViewingItem(item)}
                className="bg-zinc-800/60 border border-zinc-700/50 rounded-xl p-3 cursor-pointer hover:bg-zinc-800 hover:border-zinc-700 transition-colors"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-black">
                    <span style={{ color: businessColorById[item.businessId] || '#a78bfa' }}>{item.businessName || '사업자없음'}</span>
                    <span className="text-zinc-600">(</span>
                    <span className="text-zinc-300">{item.company || '공급사없음'}</span>
                    <span className="text-zinc-600">)</span>
                  </span>
                  <span className="text-[10px] text-zinc-600 font-bold">{item.date}</span>
                </div>
                <div className="text-white font-black text-sm">
                  {item.recipientName || '이름없음'} · {item.orderNumber || '주문번호없음'}
                  {item.syncing && <span className="ml-1 text-[10px] text-amber-400">저장 중</span>}
                </div>
                <div className="text-zinc-500 text-xs font-bold mt-0.5">{item.reason}</div>
                <div className="text-xs font-black mt-0.5">
                  <span className="text-sky-400">[업체:{item.vendorMethod || '-'}]</span>{' '}
                  <span className="text-sky-400">[고객:{item.customerMethod === '환불' ? (item.refundMethod || '환불') : item.customerMethod}]</span>
                </div>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-[10px] text-zinc-500 font-bold">
                    {item.customerMethod}{item.deduction === 'full' ? ` · -${(item.marginPerUnit || 0).toLocaleString()}원` : ''}
                  </span>
                  <button
                    onClick={e => { e.stopPropagation(); handleSendToVendor(item); }}
                    disabled={sendingId === key}
                    className="px-2.5 py-1 rounded-full text-[10px] font-black bg-sky-500/10 text-sky-400 border border-sky-500/20 hover:bg-sky-500/20 disabled:opacity-50 transition-colors"
                  >
                    {sentId === key ? '복사됨' : sendingId === key ? '복사 중...' : '업체전송'}
                  </button>
                </div>
                <div className="flex items-center gap-1.5 mt-1.5">
                  {(['vendor', 'customer'] as const).map(side => {
                    const label = side === 'vendor' ? '업체' : '고객';
                    const status = side === 'vendor' ? getCsVendorStatus(item) : getCsCustomerStatus(item);
                    const isDone = status === '완료';
                    return (
                      <button
                        key={side}
                        onClick={e => { e.stopPropagation(); handleToggleSide(item, side); }}
                        className={`px-2.5 py-1 rounded-full text-[10px] font-black border transition-colors disabled:opacity-50 ${
                          isDone
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20'
                            : 'bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/20'
                        }`}
                      >
                        {`${label} ${isDone ? '처리완료' : '접수중'}`}
                      </button>
                    );
                  })}
                  {item.customerMethod === '재배송' && (
                    <button
                      onClick={e => { e.stopPropagation(); handleCreatePurchaseOrder(item); }}
                      disabled={item.poAdded || creatingPoId === key}
                      className="px-2.5 py-1 rounded-full text-[10px] font-black bg-violet-500/10 text-violet-400 border border-violet-500/20 hover:bg-violet-500/20 disabled:opacity-50 transition-colors"
                    >
                      {item.poAdded ? '발주서생성됨' : creatingPoId === key ? '발주서생성 중...' : '→ 발주서생성'}
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <button
                    onClick={e => { e.stopPropagation(); handleEdit(item); }}
                    className="px-2.5 py-1 rounded-full text-[10px] font-black bg-zinc-700/40 text-zinc-300 border border-zinc-600/40 hover:bg-zinc-700/60 transition-colors"
                  >
                    수정
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(item); }}
                    disabled={deletingKey === key}
                    className="px-2.5 py-1 rounded-full text-[10px] font-black bg-rose-500/10 text-rose-400 border border-rose-500/20 hover:bg-rose-500/20 disabled:opacity-50 transition-colors"
                  >
                    {deletingKey === key ? '삭제 중...' : '삭제'}
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); handleRevertToPending(item); }}
                    disabled={revertingKey === key}
                    className="px-2.5 py-1 rounded-full text-[10px] font-black bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 disabled:opacity-50 transition-colors"
                  >
                    {revertingKey === key ? '되돌리는 중...' : '대기로 되돌리기'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {viewingItem && (
        <OrderDetailModal item={viewingItem} onClose={() => setViewingItem(null)} />
      )}

      {csDraft && (
        <CsEntryModal
          businessId={editing ? editing.businessId : selectedBusinessId}
          pricingConfig={(editing ? editingPricingConfig : businessPricingConfig) || undefined}
          draft={csDraft}
          onChange={setCsDraft}
          onClose={closeCsModal}
          onSaved={() => {}}
          editing={editing ? { date: editing.date, record: editing.record } : undefined}
        />
      )}
    </div>
  );
};

export default ConsolidatedCsPanel;
