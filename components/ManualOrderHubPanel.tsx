import React, { useEffect, useMemo, useState } from 'react';
import type { ManualOrder, PricingConfig } from '../types';
import {
  subscribeManualOrders, addManualOrdersTx, removeManualOrderTx, updateManualOrderTx,
  loadPricingConfig, loadQuickRecipients, type QuickRecipientData,
} from '../services/firestoreService';
import ManualOrderLogModal from './ManualOrderLogModal';

// 상단 '수동발주' 통합 창: 사업자를 왼쪽에서 고르고, 오른쪽에서 수동발주를 넣고 대기 목록을 본다.
// 각 사업자 화면의 '수동 발주 추가'와 같은 대기 목록(config/pendingManualOrders[_사업자])을 쓰므로, 여기서 넣은 건은
// 그 사업자 발주서를 만들 때 똑같이 들어간다. 저장은 건별 트랜잭션이라 다른 창의 옛 목록이 덮어쓰지 않는다.

interface Props {
  businesses: { id: string; displayName: string }[];
  active: boolean;
  onClose: () => void;
}

type Draft = { companyName: string; recipientName: string; phone: string; address: string; memo: string; isSample: boolean };
const EMPTY: Draft = { companyName: '', recipientName: '', phone: '', address: '', memo: '', isSample: false };

const ManualOrderHubPanel: React.FC<Props> = ({ businesses, active, onClose }) => {
  const [bizId, setBizId] = useState(businesses[0]?.id || '');
  const [ordersByBiz, setOrdersByBiz] = useState<Record<string, ManualOrder[]>>({});
  const [pricing, setPricing] = useState<Record<string, PricingConfig | null>>({});
  const [quick, setQuick] = useState<Record<string, QuickRecipientData[]>>({});
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [products, setProducts] = useState<{ productKey: string; productName: string; qty: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => { if (!bizId && businesses[0]) setBizId(businesses[0].id); }, [businesses, bizId]);

  // 모든 사업자 대기 목록 구독 (창이 열려 있을 때만)
  useEffect(() => {
    if (!active) return;
    const unsubs = businesses.map(b => subscribeManualOrders(list => setOrdersByBiz(prev => ({ ...prev, [b.id]: list as ManualOrder[] })), b.id));
    return () => unsubs.forEach(u => u());
  }, [active, businesses]);

  // 고른 사업자의 품목 설정·빠른 선택 (처음 고를 때 한 번)
  useEffect(() => {
    if (!active || !bizId) return;
    if (pricing[bizId] === undefined) loadPricingConfig(bizId).then(r => setPricing(prev => ({ ...prev, [bizId]: r.config })));
    if (quick[bizId] === undefined) loadQuickRecipients(bizId).then(r => setQuick(prev => ({ ...prev, [bizId]: r })));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, bizId]);

  useEffect(() => { setDraft(EMPTY); setProducts([]); }, [bizId]);

  const config = pricing[bizId] || {};
  const companies = useMemo(() => Object.keys(config).filter(n => config[n]?.products && Object.keys(config[n].products).length > 0).sort((a, b) => a.localeCompare(b, 'ko')), [config]);
  const companyProducts = draft.companyName ? Object.entries((config[draft.companyName]?.products || {}) as Record<string, any>) : [];
  const orders = ordersByBiz[bizId] || [];
  const bizName = businesses.find(b => b.id === bizId)?.displayName || '';

  const addProduct = (key: string) => {
    if (!key) return;
    const p = (config[draft.companyName]?.products as any)?.[key];
    const name = p ? (p.orderFormName || p.displayName || key) : key;
    setProducts(prev => (prev.some(x => x.productKey === key) ? prev : [...prev, { productKey: key, productName: name, qty: '1' }]));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.companyName || !draft.recipientName.trim() || products.length === 0) { alert('업체, 받는분 이름, 품목은 꼭 넣어 주세요.'); return; }
    const stamp = Date.now();
    const newOrders: ManualOrder[] = products.map((p, i) => ({
      id: `mo-${stamp}-h${i}`,
      companyName: draft.companyName,
      recipientName: draft.recipientName.trim(),
      phone: draft.phone.trim(),
      address: draft.address.trim(),
      productName: p.productName,
      productKey: p.productKey,
      qty: parseInt(p.qty) || 1,
      memo: draft.memo.trim(),
      ...(draft.isSample ? { isSample: true } : {}),
    }));
    setSaving(true);
    try {
      await addManualOrdersTx(bizId, newOrders);
      setDraft(prev => ({ ...EMPTY, companyName: prev.companyName }));
      setProducts([]);
    } catch (err: any) {
      alert(`수동발주 저장 실패 — 다시 눌러 주세요.\n${err?.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  const input = 'w-full bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-2 text-xs font-bold text-white outline-none focus:ring-1 focus:ring-rose-500/30';

  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-white font-black text-sm">수동발주 (전체 사업자)</div>
        <button onClick={onClose} className="text-zinc-500 hover:text-white text-lg font-black px-2">×</button>
      </div>
      <div className="flex gap-2">
        <div className="flex flex-col gap-1.5 w-24 shrink-0">
          {businesses.map(b => {
            const n = (ordersByBiz[b.id] || []).length;
            const on = b.id === bizId;
            return (
              <button key={b.id} onClick={() => setBizId(b.id)}
                className={`text-left px-2 py-2 rounded-lg text-[11px] font-black border transition-colors ${on ? 'btn-accent text-white border-transparent' : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-white'}`}>
                <div className="truncate">{b.displayName}</div>
                {n > 0 && <div className={`text-[10px] ${on ? 'text-white/80' : 'text-rose-400'}`}>대기 {n}</div>}
              </button>
            );
          })}
        </div>
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          {(quick[bizId] || []).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {(quick[bizId] || []).map(p => (
                <button key={p.name} type="button" onClick={() => setDraft(d => ({ ...d, recipientName: p.name, phone: p.phone, address: p.address }))}
                  className="px-2 py-0.5 bg-zinc-800 hover:bg-rose-500 hover:text-white border border-zinc-700 rounded-full text-[10px] font-black text-zinc-400">{p.name}</button>
              ))}
            </div>
          )}
          <form onSubmit={submit} className="flex flex-col gap-1.5">
            <select value={draft.companyName} onChange={e => { setDraft(d => ({ ...d, companyName: e.target.value })); setProducts([]); }} className={input}>
              <option value="">{pricing[bizId] === undefined ? '불러오는 중…' : '업체 고르기'}</option>
              {companies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input value={draft.recipientName} onChange={e => setDraft(d => ({ ...d, recipientName: e.target.value }))} placeholder="받는분 이름" className={input} />
            <input value={draft.phone} onChange={e => setDraft(d => ({ ...d, phone: e.target.value }))} placeholder="전화번호" className={input} />
            <input value={draft.address} onChange={e => setDraft(d => ({ ...d, address: e.target.value }))} placeholder="주소" className={input} />
            <select value="" onChange={e => addProduct(e.target.value)} disabled={!draft.companyName} className={input}>
              <option value="">+ 품목 추가 (여러 개 가능)</option>
              {companyProducts.map(([key, p]) => (
                <option key={key} value={key}>{p.displayName || key}{p.orderFormName && p.orderFormName !== p.displayName ? ` → ${p.orderFormName}` : ''} ({(Number(p.supplyPrice) || 0).toLocaleString()}원)</option>
              ))}
            </select>
            {products.map((p, i) => (
              <div key={p.productKey} className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-1.5">
                <span className="flex-1 text-[10px] font-bold text-zinc-300 truncate">{p.productName}</span>
                <input type="number" value={p.qty} onChange={e => setProducts(prev => prev.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                  className="w-14 bg-zinc-950 border border-zinc-800 rounded-lg px-1.5 py-1 text-[10px] font-bold text-white outline-none" />
                <button type="button" onClick={() => setProducts(prev => prev.filter((_, j) => j !== i))} className="text-zinc-600 hover:text-rose-500 text-[11px] font-black">✕</button>
              </div>
            ))}
            <input value={draft.memo} onChange={e => setDraft(d => ({ ...d, memo: e.target.value }))} placeholder="메모 (배송메세지로 들어감)" className={input} />
            <label className="flex items-center gap-1.5 text-[10px] font-bold text-zinc-400 px-1">
              <input type="checkbox" checked={draft.isSample} onChange={e => setDraft(d => ({ ...d, isSample: e.target.checked }))} className="accent-amber-500" />
              샘플 (매출현황 마진에서 뺌)
            </label>
            <button type="submit" disabled={saving} className="rounded-xl text-xs font-black py-2 btn-accent text-white disabled:opacity-50">
              {saving ? '저장 중…' : `${bizName}에 추가${products.length > 1 ? ` (${products.length}건)` : ''}`}
            </button>
          </form>

          <div className="flex items-center justify-between mt-1">
            <span className="text-[11px] font-black text-zinc-300">{bizName} 대기 {orders.length}건</span>
            <button type="button" onClick={() => setLogOpen(true)} className="text-[10px] font-black text-zinc-400 hover:text-white">📜 기록 보기</button>
          </div>
          {orders.length === 0 && <div className="text-[10px] text-zinc-600">대기 중인 수동발주가 없어요</div>}
          <div className="flex flex-col gap-1">
            {orders.map(o => (
              <div key={o.id} className="flex items-center gap-1.5 bg-zinc-900/70 border border-zinc-800 rounded-lg px-2 py-1.5">
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] font-black truncate">
                    {o.redirectFrom && <span className="text-sky-400">{o.redirectFrom}→ </span>}
                    <span className="text-rose-400">{o.companyName}</span> <span className="text-white">{o.recipientName}</span>
                  </div>
                  <div className="text-[10px] text-zinc-500 truncate">{o.productName} ×{o.qty}{o.memo ? ` · ${o.memo}` : ''}</div>
                </div>
                <button type="button" title="샘플 (매출현황 마진에서 뺌)" onClick={() => updateManualOrderTx(bizId, o.id, { isSample: !o.isSample }).catch(err => alert(`저장 실패: ${err?.message || err}`))}
                  className={`text-[9px] font-black px-1 rounded ${o.isSample ? 'bg-amber-500 text-black' : 'text-zinc-500 border border-zinc-700'}`}>샘플</button>
                <button type="button" onClick={() => { if (confirm(`${o.recipientName} 수동발주를 지울까요?`)) removeManualOrderTx(bizId, o.id).catch(err => alert(`삭제 실패: ${err?.message || err}`)); }}
                  className="text-zinc-600 hover:text-rose-500 text-[11px] font-black px-1">✕</button>
              </div>
            ))}
          </div>
          <div className="text-[10px] text-zinc-600">여기 넣은 건은 그 사업자 발주서를 만들 때 들어가요. 바로 발주서를 만들려면 그 사업자 화면의 수동발주 칩에서 📄를 누르세요.</div>
        </div>
      </div>
      {logOpen && <ManualOrderLogModal businessId={bizId} businessName={bizName} currentOrders={orders} onClose={() => setLogOpen(false)} />}
    </div>
  );
};

export default ManualOrderHubPanel;
