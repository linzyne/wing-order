import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import CsEntryModal, { type CsDraft, resolveOrderRowFields, buildCsDraft, buildCsDraftFromRecord, deleteCsRecord } from './CsEntryModal';
import { getHeaderForCompany } from '../hooks/useConsolidatedOrderConverter';
import type { CsRecord, PricingConfig } from '../types';
import { getCsVendorStatus, getCsCustomerStatus, isCsFullyCompleted } from '../types';

interface Business { id: string; displayName: string; }

interface OpenCsItem extends CsRecord {
  date: string;
  businessId: string;
  businessName: string;
}

interface Props {
  businesses: Business[];
  onClose: () => void;
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
      const { loadAllSalesHistory, loadPricingConfig } = await import('../services/firestoreService');
      const [history, configResult] = await Promise.all([
        loadAllSalesHistory(item.businessId),
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

const ConsolidatedCsPanel: React.FC<Props> = ({ businesses, onClose }) => {
  const [items, setItems] = useState<OpenCsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  const [viewingItem, setViewingItem] = useState<OpenCsItem | null>(null);

  // 검색용: 사업자 먼저 선택 → 그 사업자의 발주내역만 대상으로 검색 (사업자마다 같은 주문번호가 있을 수 있어 섞으면 안 됨)
  const [selectedBusinessId, setSelectedBusinessId] = useState('');
  const [businessOrderRows, setBusinessOrderRows] = useState<{ company: string; row: any[] }[]>([]);
  const [businessPricingConfig, setBusinessPricingConfig] = useState<PricingConfig | null>(null);
  const [loadingBusinessData, setLoadingBusinessData] = useState(false);
  const [search, setSearch] = useState('');
  const [manualCompany, setManualCompany] = useState('');
  const [csDraft, setCsDraft] = useState<CsDraft | null>(null);
  const [editing, setEditing] = useState<{ date: string; record: OpenCsItem; businessId: string } | null>(null);
  const [editingPricingConfig, setEditingPricingConfig] = useState<PricingConfig | undefined>(undefined);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { loadAllSalesHistory } = await import('../services/firestoreService');
    const results = await Promise.all(businesses.map(async b => {
      const history = await loadAllSalesHistory(b.id);
      const open: OpenCsItem[] = [];
      history.forEach(d => {
        (d.csRecords || []).forEach(r => {
          if (!isCsFullyCompleted(r)) open.push({ ...r, date: d.date, businessId: b.id, businessName: b.displayName });
        });
      });
      return open;
    }));
    setItems(results.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    setLoading(false);
  }, [businesses]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selectedBusinessId) {
      setBusinessOrderRows([]);
      setBusinessPricingConfig(null);
      return;
    }
    let cancelled = false;
    setLoadingBusinessData(true);
    setSearch('');
    setManualCompany('');
    (async () => {
      const { loadAllSalesHistory, loadPricingConfig } = await import('../services/firestoreService');
      const [history, configResult] = await Promise.all([
        loadAllSalesHistory(selectedBusinessId),
        loadPricingConfig(selectedBusinessId),
      ]);
      if (cancelled) return;
      const rows: { company: string; row: any[] }[] = [];
      history.forEach(d => {
        if (d.companyOrderRows) {
          Object.entries(d.companyOrderRows).forEach(([company, companyRows]) => {
            (companyRows as any[][]).forEach(row => rows.push({ company, row }));
          });
        } else if (d.orderRows) {
          d.orderRows.forEach(row => rows.push({ company: '', row }));
        }
      });
      setBusinessOrderRows(rows);
      setBusinessPricingConfig(configResult.config);
      setLoadingBusinessData(false);
    })();
    return () => { cancelled = true; };
  }, [selectedBusinessId]);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return businessOrderRows
      .filter(({ row }) => row.some(cell => cell != null && String(cell).toLowerCase().includes(q)))
      .slice(0, 50);
  }, [businessOrderRows, search]);

  const openOrderNumbersForBusiness = useMemo(() => {
    const set = new Set<string>();
    items.filter(i => i.businessId === selectedBusinessId).forEach(i => set.add(i.orderNumber));
    return set;
  }, [items, selectedBusinessId]);

  const handleToggleSide = async (item: OpenCsItem, side: 'vendor' | 'customer') => {
    setCompletingId(`${item.businessId}-${item.id}-${side}`);
    try {
      const { loadDailySales, upsertDailySales } = await import('../services/firestoreService');
      const existing = await loadDailySales(item.date, item.businessId);
      if (!existing?.csRecords) return;
      const now = new Date().toISOString();
      let nextItem: CsRecord | undefined;
      const updated = existing.csRecords.map(r => {
        if (r.id !== item.id) return r;
        const isVendor = side === 'vendor';
        const currentStatus = isVendor ? getCsVendorStatus(r) : getCsCustomerStatus(r);
        const nextStatus = currentStatus === '접수' ? '완료' as const : '접수' as const;
        const next: CsRecord = {
          ...r,
          vendorStatus: isVendor ? nextStatus : getCsVendorStatus(r),
          customerStatus: isVendor ? getCsCustomerStatus(r) : nextStatus,
          vendorCompletedAt: isVendor ? (nextStatus === '완료' ? now : undefined) : r.vendorCompletedAt,
          customerCompletedAt: isVendor ? r.customerCompletedAt : (nextStatus === '완료' ? now : undefined),
        };
        nextItem = next;
        return next;
      });
      await upsertDailySales({ ...existing, csRecords: updated }, item.businessId);
      if (!nextItem) return;
      if (isCsFullyCompleted(nextItem)) {
        setItems(prev => prev.filter(i => !(i.id === item.id && i.businessId === item.businessId)));
      } else {
        setItems(prev => prev.map(i => (i.id === item.id && i.businessId === item.businessId) ? { ...i, ...nextItem } : i));
      }
    } finally {
      setCompletingId(null);
    }
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

  const handleEdit = async (item: OpenCsItem) => {
    const { loadPricingConfig } = await import('../services/firestoreService');
    const { config } = await loadPricingConfig(item.businessId);
    setEditingPricingConfig(config || undefined);
    setEditing({ date: item.date, record: item, businessId: item.businessId });
    setCsDraft(buildCsDraftFromRecord(item));
  };

  const handleDelete = async (item: OpenCsItem) => {
    if (!window.confirm(`${item.recipientName || '이름없음'} · ${item.orderNumber || '주문번호없음'} CS 접수를 삭제하시겠습니까?`)) return;
    const key = `${item.businessId}-${item.id}`;
    setDeletingKey(key);
    try {
      await deleteCsRecord(item.businessId, item.date, item);
      setItems(prev => prev.filter(i => !(i.id === item.id && i.businessId === item.businessId)));
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

  return (
    <div className="p-4" onMouseDown={e => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-3 px-2">
        <div>
          <h3 className="text-white font-black text-sm">통합 CS 현황</h3>
          <p className="text-zinc-600 text-[10px] font-bold mt-0.5">접수 중인 건만 표시 · 완료 처리하면 자동으로 사라집니다</p>
        </div>
        <button onClick={onClose} className="text-zinc-600 hover:text-white transition-colors text-2xl leading-none w-7 h-7 flex items-center justify-center rounded-lg hover:bg-zinc-800">×</button>
      </div>

      {/* 사업자 선택 + 검색 → CS 접수 */}
      <div className="px-2 mb-3 space-y-2">
        <select
          value={selectedBusinessId}
          onChange={e => setSelectedBusinessId(e.target.value)}
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
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {searchResults.length === 0 ? (
              <p className="text-zinc-600 text-xs font-bold text-center py-3">검색 결과가 없습니다.</p>
            ) : searchResults.map(({ company, row }, i) => {
              const fields = resolveOrderRowFields(company, row, businessPricingConfig || undefined);
              const isOpen = fields.orderNumber && openOrderNumbersForBusiness.has(fields.orderNumber);
              return (
                <div key={i} className="bg-zinc-800/50 border border-zinc-700/40 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-white font-bold text-xs truncate">{fields.recipientName || '이름없음'} · {fields.orderNumber || '주문번호없음'}</div>
                    <div className="text-zinc-500 text-[10px] font-bold truncate">{company} · {fields.productName}{fields.qty > 1 ? ` x${fields.qty}` : ''}</div>
                  </div>
                  {isOpen ? (
                    <span className="shrink-0 text-[10px] bg-amber-500/10 text-amber-400 px-2 py-1 rounded-full font-black border border-amber-500/20">CS 처리중</span>
                  ) : (
                    <button
                      onClick={() => setCsDraft(buildCsDraft(company, row, businessPricingConfig || undefined))}
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
        <div className="space-y-2 max-h-[50vh] overflow-y-auto px-1">
          {items.map(item => {
            const key = `${item.businessId}-${item.id}`;
            return (
              <div
                key={key}
                onClick={() => setViewingItem(item)}
                className="bg-zinc-800/60 border border-zinc-700/50 rounded-xl p-3 cursor-pointer hover:bg-zinc-800 hover:border-zinc-700 transition-colors"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-black text-violet-400">{item.businessName}</span>
                  <span className="text-[10px] text-zinc-600 font-bold">{item.date}</span>
                </div>
                <div className="text-white font-black text-sm">{item.recipientName || '이름없음'} · {item.orderNumber || '주문번호없음'}</div>
                <div className="text-zinc-500 text-xs font-bold mt-0.5">{item.company} · {item.reason}</div>
                <div className="text-zinc-500 text-[10px] font-bold mt-0.5">
                  [업체:{item.vendorMethod || '-'}][고객:{item.customerMethod === '환불' ? (item.refundMethod || '환불') : item.customerMethod}]
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
                    const sideKey = `${key}-${side}`;
                    const isDone = status === '완료';
                    return (
                      <button
                        key={side}
                        onClick={e => { e.stopPropagation(); handleToggleSide(item, side); }}
                        disabled={completingId === sideKey}
                        className={`px-2.5 py-1 rounded-full text-[10px] font-black border transition-colors disabled:opacity-50 ${
                          isDone
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20'
                            : 'bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/20'
                        }`}
                      >
                        {completingId === sideKey ? `${label} 처리 중...` : `${label} ${isDone ? '처리완료' : '접수중'}`}
                      </button>
                    );
                  })}
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
          onSaved={load}
          editing={editing ? { date: editing.date, record: editing.record } : undefined}
        />
      )}
    </div>
  );
};

export default ConsolidatedCsPanel;
