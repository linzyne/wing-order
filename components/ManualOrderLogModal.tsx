import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DailySales, ManualOrder } from '../types';
import { subscribeManualOrderLog, subscribeRecentOrderSearch, type ManualOrderLogEntry } from '../services/firestoreService';

// 수동발주 기록 창: 수동발주 추가에 넣었던 건을 모두 보여주고, 실제 발주서에 들어갔는지 옆에 적는다.
//  · 등록 기록(manualOrderLog)은 이 기능을 넣은 날부터 쌓인다.
//  · 그 전 건은 최근 45일 발주서(주문검색 색인)에서 주문번호가 '수동'인 줄로 찾아 함께 보여준다.
//  · 발주서에 들어갔는지는 같은 업체·같은 받는분 이름이 등록한 날 이후 발주서의 수동 줄에 있는지로 본다.

interface Props {
  businessId?: string;
  businessName?: string;
  /** 지금 대기 목록 (대기 중인지 보려고) */
  currentOrders: ManualOrder[];
  onClose: () => void;
}

type ManualRow = { date: string; company: string; name: string; productText: string };
type Status = 'sent' | 'waiting' | 'missing';
type Item = {
  key: string;
  at: number;            // 정렬용 (ms)
  when: string;          // 화면 표시용
  company: string;
  recipientName: string;
  productName: string;
  qty: number;
  phone?: string;
  address?: string;
  memo?: string;
  isSample?: boolean;
  status: Status;
  statusText: string;
  fromPoOnly?: boolean;  // 등록 기록 없이 발주서에서만 찾은 건
};

const normName = (s: string) => String(s || '').replace(/\s+/g, '');
const ymd = (ms: number) => new Date(ms).toLocaleDateString('en-CA');
const md = (date: string) => { const [, m, d] = date.split('-'); return `${Number(m)}/${Number(d)}`; };
const fmtWhen = (ms: number) => {
  const d = new Date(ms);
  const wd = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}(${wd}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const manualRowsOf = (history: DailySales[]): ManualRow[] => {
  const out: ManualRow[] = [];
  history.forEach(d => {
    if (!d.companyOrderRows) return;
    Object.entries(d.companyOrderRows).forEach(([company, rows]) => {
      const nums = d.companyOrderNumbers?.[company] || [];
      const names = d.companyRecipientNames?.[company] || [];
      (rows as any[][]).forEach((row, i) => {
        const cells = (row || []).map(c => String(c ?? '').trim()).filter(Boolean);
        const num = String(nums[i] || '');
        // CS 재배송으로 덧붙인 줄은 주문번호 목록이 비어 있어서, 발주서 칸에 '수동'이 적혀 있는지로 본다
        if (!num.startsWith('수동') && !(num === '' && cells.some(c => c === '수동' || c === '수동샘플'))) return;
        const name = names[i] || cells.find(c => /^[가-힣]{2,4}$/.test(c) && c !== '수동' && c !== '수동샘플' && !/(농원|푸드|상회|무역|상사)$/.test(c)) || '';
        const product = cells.find(c => /kg|개|박스|세트|g\b/i.test(c) && c.length < 40) || '';
        const reship = cells.some(c => c.includes('재배송'));
        out.push({ date: d.date, company, name, productText: reship ? `${product} · 재배송` : product });
      });
    });
  });
  return out;
};

const FILTERS: { key: 'all' | Status; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'missing', label: '발주서 없음' },
  { key: 'waiting', label: '대기 중' },
  { key: 'sent', label: '발주서 들어감' },
];

const ManualOrderLogModal: React.FC<Props> = ({ businessId, businessName, currentOrders, onClose }) => {
  const [log, setLog] = useState<ManualOrderLogEntry[] | null>(null);
  const [recent, setRecent] = useState<DailySales[] | null>(null);
  const [filter, setFilter] = useState<'all' | Status>('all');
  const [search, setSearch] = useState('');

  useEffect(() => subscribeManualOrderLog(businessId, setLog), [businessId]);
  useEffect(() => subscribeRecentOrderSearch(businessId, setRecent), [businessId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const items = useMemo<Item[]>(() => {
    const rows = recent ? manualRowsOf(recent) : [];
    const pendingIds = new Set(currentOrders.map(o => o.id));
    const matchedRow = new Set<ManualRow>();
    const out: Item[] = [];

    (log || []).forEach(e => {
      const from = ymd(e.createdAt);
      const hits = rows.filter(r => r.company === e.companyName && normName(r.name) === normName(e.recipientName) && r.date >= from)
        .sort((a, b) => a.date.localeCompare(b.date));
      hits.forEach(h => matchedRow.add(h));
      const pending = pendingIds.has(e.id);
      let status: Status;
      let statusText: string;
      if (hits.length) {
        status = 'sent';
        statusText = `발주서 ${Array.from(new Set(hits.map(h => md(h.date)))).join(', ')}`;
      } else if (pending) {
        status = 'waiting';
        statusText = '대기 중 · 아직 발주서 없음';
      } else if (e.removedAt) {
        status = 'missing';
        statusText = `발주서 없이 빠짐 · ${e.removedReason || '목록에서 빠짐'} ${fmtWhen(e.removedAt)}`;
      } else {
        status = 'missing';
        statusText = '목록에서 사라짐 · 발주서 없음';
      }
      out.push({
        key: e.id, at: e.createdAt, when: fmtWhen(e.createdAt), company: e.companyName, recipientName: e.recipientName,
        productName: e.productName, qty: e.qty, phone: e.phone, address: e.address, memo: e.memo, isSample: e.isSample,
        status, statusText,
      });
    });

    // 등록 기록이 없던 때의 수동 줄: 발주서에 들어간 것만 알 수 있다
    const groups = new Map<string, ManualRow[]>();
    rows.filter(r => !matchedRow.has(r)).forEach(r => {
      const k = `${r.date}|${r.company}|${normName(r.name)}`;
      groups.set(k, [...(groups.get(k) || []), r]);
    });
    groups.forEach((rs, k) => {
      const r = rs[0];
      out.push({
        key: `po-${k}`, at: new Date(`${r.date}T12:00:00`).getTime(), when: md(r.date), company: r.company,
        recipientName: r.name || '(이름 없음)', productName: r.productText, qty: rs.length,
        status: 'sent', statusText: `발주서 ${md(r.date)}`, fromPoOnly: true,
      });
    });
    return out.sort((a, b) => b.at - a.at);
  }, [log, recent, currentOrders]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length, sent: 0, waiting: 0, missing: 0 };
    items.forEach(i => { c[i.status]++; });
    return c;
  }, [items]);

  const shown = useMemo(() => {
    const q = normName(search).toLowerCase();
    return items.filter(i => (filter === 'all' || i.status === filter)
      && (!q || normName(`${i.recipientName}${i.company}${i.productName}${i.phone || ''}`).toLowerCase().includes(q)));
  }, [items, filter, search]);

  const loading = log === null || recent === null;
  const badge = (s: Status) => s === 'sent'
    ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
    : s === 'waiting' ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
    : 'bg-rose-500/20 text-rose-300 border-rose-500/40';

  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div>
            <div className="text-white font-black text-sm">수동발주 기록 · {businessName}</div>
            <div className="text-zinc-500 text-[10px] mt-0.5">등록 기록은 오늘부터 쌓여요. 그 전 건은 최근 45일 발주서에 들어간 것만 보여요.</div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white text-lg font-black px-2">×</button>
        </div>
        <div className="flex flex-1 min-h-0">
          <div className="flex flex-col gap-1.5 p-3 border-r border-zinc-800 w-32 shrink-0">
            {FILTERS.map(f => (
              <button key={f.key} onClick={() => setFilter(f.key)}
                className={`text-left px-2.5 py-2 rounded-lg text-[11px] font-black border transition-colors ${filter === f.key
                  ? (f.key === 'missing' ? 'bg-rose-600 text-white border-rose-600' : 'btn-accent text-white border-transparent')
                  : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-white'}`}>
                {f.label}
                <span className={`ml-1 ${f.key === 'missing' && counts.missing > 0 && filter !== f.key ? 'text-rose-400' : ''}`}>{counts[f.key]}</span>
              </button>
            ))}
          </div>
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="p-3 border-b border-zinc-800">
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="받는분·업체·품목·전화번호 검색"
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-bold text-white outline-none focus:ring-1 focus:ring-rose-500/30" />
            </div>
            <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-1.5">
              {loading && <div className="text-zinc-500 text-xs text-center py-8">불러오는 중…</div>}
              {!loading && shown.length === 0 && <div className="text-zinc-600 text-xs text-center py-8">해당하는 건이 없어요</div>}
              {!loading && shown.map(i => (
                <div key={i.key} className={`rounded-xl border px-3 py-2 ${i.status === 'missing' ? 'border-rose-500/40 bg-rose-950/20' : 'border-zinc-800 bg-zinc-900/60'}`}>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-zinc-500 font-bold shrink-0">{i.when}</span>
                    <span className="text-rose-400 font-black shrink-0">{i.company}</span>
                    <span className="text-white font-black truncate">{i.recipientName}</span>
                    {i.isSample && <span className="text-[9px] font-black bg-amber-500 text-black px-1 rounded shrink-0">샘플</span>}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-zinc-400 text-[10px] font-bold truncate flex-1">
                      {i.productName}{i.fromPoOnly ? (i.qty > 1 ? ` · ${i.qty}줄` : '') : ` ×${i.qty}`}
                    </span>
                    <span className={`text-[10px] font-black border rounded-md px-1.5 py-0.5 shrink-0 ${badge(i.status)}`}>{i.statusText}</span>
                  </div>
                  {(i.phone || i.address || i.memo) && (
                    <div className="text-zinc-600 text-[10px] mt-1 truncate">{[i.phone, i.address, i.memo].filter(Boolean).join(' · ')}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ManualOrderLogModal;
