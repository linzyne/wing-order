import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DailySales, PricingConfig } from '../types';
import { loadAllSalesHistory, loadPricingConfig } from '../services/firestoreService';
import { resolveOrderRowFields, normalizeForSearch } from './CsEntryModal';

interface Props {
  businesses: { id: string; displayName: string }[];
  active: boolean;
  onClose: () => void;
}

interface OrderHit {
  businessId: string;
  businessName: string;
  date: string;
  company: string;
  orderNumber: string;
  recipientName: string;
  productName: string;
  qty: number;
  phone: string;
  address: string;
  fake: boolean;
}

// 한글 NFD/NFC 혼용까지 흡수해야 이름 검색이 헛돌지 않는다
const norm = normalizeForSearch;

/** 모든 사업자의 매출현황(발주내역)에서 이름/주문번호로 어느 사업자 주문인지 찾아준다 */
const OrdererSearchPanel: React.FC<Props> = ({ businesses, active, onClose }) => {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<OrderHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const buildIndex = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const all: OrderHit[] = [];
      await Promise.all(
        businesses.map(async (biz) => {
          const [history, pricing] = await Promise.all([
            loadAllSalesHistory(biz.id).catch(() => [] as DailySales[]),
            loadPricingConfig(biz.id).then(r => r.config).catch(() => null as PricingConfig | null),
          ]);
          history.forEach((d) => {
            if (d.companyOrderRows) {
              Object.entries(d.companyOrderRows).forEach(([company, rows]) => {
                const nums = d.companyOrderNumbers?.[company] || [];
                const storedNames = d.companyRecipientNames?.[company] || [];
                (rows as any[][]).forEach((row, i) => {
                  const f = resolveOrderRowFields(company, row, pricing || undefined);
                  // 저장된 수취인 이름이 있으면 헤더 추측보다 우선 (발주양식에 이름 칸이 없어도 정확)
                  const rawName = storedNames[i] || f.recipientName || '';
                  all.push({
                    businessId: biz.id,
                    businessName: biz.displayName,
                    date: d.date,
                    company,
                    orderNumber: f.orderNumber || nums[i] || '',
                    recipientName: rawName || row.map(c => String(c ?? '')).join(' '),
                    productName: f.productName || '',
                    qty: f.qty || 1,
                    phone: f.recipientPhone || '',
                    address: f.recipientAddress || '',
                    fake: false,
                  });
                });
              });
            } else if (d.orderRows) {
              (d.orderRows as any[][]).forEach((row) => {
                all.push({
                  businessId: biz.id,
                  businessName: biz.displayName,
                  date: d.date,
                  company: '',
                  orderNumber: '',
                  recipientName: row.map(c => String(c ?? '')).join(' '),
                  productName: '',
                  qty: 1,
                  phone: '',
                  address: '',
                  fake: false,
                });
              });
            }
            (d.fakeOrderRecords || []).forEach((r) => {
              all.push({
                businessId: biz.id,
                businessName: biz.displayName,
                date: d.date,
                company: r.companyName || '',
                orderNumber: r.orderNumber || '',
                recipientName: r.recipientName || '',
                productName: r.productName || '',
                qty: r.qty || 1,
                phone: r.phone || '',
                address: '',
                fake: true,
              });
            });
          });
        })
      );
      setHits(all);
      setLoadedAt(new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  // 패널을 처음 펼칠 때 한 번만 로드
  useEffect(() => {
    if (active && loadedAt === null && !loadingRef.current) buildIndex();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const results = useMemo(() => {
    const q = norm(query);
    if (q.length < 1) return [];
    return hits.filter(h =>
      norm(h.recipientName).includes(q) ||
      (h.orderNumber && norm(h.orderNumber).includes(q)) ||
      (h.phone && norm(h.phone).includes(q))
    );
  }, [hits, query]);

  // 사업자별 집계 (핵심: 어느 사업자에서 주문했는지)
  const byBusiness = useMemo(() => {
    const m = new Map<string, { name: string; count: number; items: OrderHit[] }>();
    results.forEach(h => {
      const e = m.get(h.businessId) || { name: h.businessName, count: 0, items: [] };
      e.count += 1;
      e.items.push(h);
      m.set(h.businessId, e);
    });
    return Array.from(m.values()).sort((a, b) => b.count - a.count);
  }, [results]);

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-zinc-200 font-black text-[11px] uppercase tracking-widest">주문자 검색</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={buildIndex}
            disabled={loading}
            className="text-[10px] text-zinc-500 hover:text-white font-black transition-colors disabled:opacity-40"
          >
            {loading ? '불러오는 중…' : '새로고침'}
          </button>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      </div>
      <p className="text-zinc-600 text-[10px] mb-2 font-mono">
        주문자 이름(또는 주문번호·전화번호)으로 전체 사업자의 발주내역을 검색합니다.
        {loadedAt && <span className="text-zinc-700"> · {loadedAt} 기준</span>}
      </p>

      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="예: 홍길동"
        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-[12px] text-zinc-200 focus:outline-none focus:border-sky-500/50"
      />

      {loading && hits.length === 0 && (
        <p className="text-zinc-600 text-[11px] mt-3 font-bold">발주내역을 불러오는 중…</p>
      )}

      {!loading && query.trim() && results.length === 0 && (
        <p className="text-zinc-600 text-[11px] mt-3 font-bold">"{query.trim()}" 에 대한 결과가 없습니다.</p>
      )}

      {byBusiness.length > 0 && (
        <div className="mt-3 space-y-3">
          {/* 사업자별 요약 */}
          <div className="flex flex-wrap items-center gap-1.5">
            {byBusiness.map(b => (
              <span key={b.name} className="bg-sky-500 text-white text-[10px] px-2 py-0.5 rounded-full font-black">
                {b.name} {b.count}건
              </span>
            ))}
          </div>

          {/* 사업자별 상세 */}
          {byBusiness.map(b => (
            <div key={b.name} className="border-l-2 border-zinc-800 pl-2">
              <div className="text-[10px] text-zinc-400 font-black mb-1">{b.name}</div>
              <div className="space-y-1">
                {b.items
                  .slice()
                  .sort((x, y) => y.date.localeCompare(x.date))
                  .map((h, i) => (
                    <div key={i} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] text-white font-black">{h.recipientName || '이름없음'}</span>
                        <span className="text-[9px] text-zinc-600 font-mono">{h.date}</span>
                        {h.company && <span className="text-[9px] text-zinc-500 font-bold">{h.company}</span>}
                        {h.fake && <span className="text-[8px] bg-violet-500/80 text-white px-1 py-0.5 rounded font-black">가구매</span>}
                      </div>
                      <div className="text-[10px] text-zinc-500 mt-0.5">
                        {h.productName && <span>{h.productName} · {h.qty}개</span>}
                        {h.orderNumber && <span className="font-mono text-zinc-600"> · {h.orderNumber}</span>}
                        {h.phone && <span className="text-zinc-600"> · {h.phone}</span>}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default OrdererSearchPanel;
