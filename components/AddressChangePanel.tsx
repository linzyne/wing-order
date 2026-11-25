import React, { useEffect, useMemo, useState } from 'react';
import type { DailySales } from '../types';
import { subscribeAddressChanges, saveAddressChange, deleteAddressChange, type AddressChange } from '../services/addressChanges';
import { subscribeRecentOrderSearch, subscribeSessionResults, type SessionResultData } from '../services/firestoreService';

// 주소변경 등록 칸 (수동 발주 추가 아래). 주문번호나 받는분 이름으로 오늘 주문서에서 주문을 찾아 고르고,
// 새 주소를 적어 두면 발주서를 만들 때 자동으로 바뀐다. 이미 발주서가 나간 주문이면 업체에 직접 연락하라고 빨갛게 알린다.

interface Props {
  businessId?: string;
  /** 오늘 올린 쿠팡 주문서 행 (헤더 뺀 것). 1=주문번호, 26=수취인, 27=전화, 28=우편번호, 29=주소 */
  masterRows: any[][];
  /** 이미 만든 오늘 발주서에서 그 주문 주소를 바로 고친다. 고친 줄 수·업체를 돌려줌 */
  onApplyToMade?: (change: AddressChange) => { rows: number; companies: string[] };
}

const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, '');
const md = (date: string) => { const [, m, d] = date.split('-'); return `${Number(m)}/${Number(d)}`; };
const asArray = (v: any): any[] => {
  let x = v;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return []; } }
  return Array.isArray(x) ? x : (x && typeof x === 'object' ? Object.values(x) : []);
};

type Found = { orderNumber: string; name: string; phone: string; zip: string; address: string; product: string };
const EMPTY = { orderNumber: '', recipientName: '', oldAddress: '', newAddress: '', newZipcode: '', newPhone: '', memo: '' };

const AddressChangePanel: React.FC<Props> = ({ businessId, masterRows, onApplyToMade }) => {
  const [changes, setChanges] = useState<AddressChange[]>([]);
  const [recent, setRecent] = useState<DailySales[] | null>(null);
  const [sessions, setSessions] = useState<Record<string, SessionResultData> | null>(null);
  const [lookup, setLookup] = useState('');
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => subscribeAddressChanges(businessId, setChanges), [businessId]);
  useEffect(() => subscribeRecentOrderSearch(businessId, setRecent), [businessId]);
  useEffect(() => subscribeSessionResults(setSessions, businessId), [businessId]);

  // 주문번호·이름으로 오늘 주문서에서 찾기 (같은 주문번호 여러 줄은 하나로)
  const found = useMemo<Found[]>(() => {
    const q = norm(lookup);
    if (q.length < 2) return [];
    const seen = new Set<string>();
    const out: Found[] = [];
    for (const r of masterRows) {
      const on = String(r?.[1] ?? '').trim();
      if (!on || seen.has(on)) continue;
      if (!norm(on).includes(q) && !norm(r?.[26]).includes(q)) continue;
      seen.add(on);
      out.push({ orderNumber: on, name: String(r[26] ?? ''), phone: String(r[27] ?? ''), zip: String(r[28] ?? ''), address: String(r[29] ?? ''), product: String(r[10] || r[11] || '') });
      if (out.length >= 6) break;
    }
    return out;
  }, [lookup, masterRows]);

  const pick = (f: Found) => {
    setForm({ ...EMPTY, orderNumber: f.orderNumber, recipientName: f.name, oldAddress: f.address });
    setLookup('');
  };

  // 이미 나간 발주서에서 이 주문번호 찾기: 기록된 발주서(최근 45일) + 오늘 만든 발주서
  const sentIn = useMemo(() => {
    const map = new Map<string, { date: string; company: string }[]>();
    const add = (on: string, date: string, company: string) => {
      String(on || '').split(/[,\s]+/).filter(Boolean).forEach(n => {
        const k = norm(n);
        const list = map.get(k) || [];
        if (!list.some(x => x.date === date && x.company === company)) list.push({ date, company });
        map.set(k, list);
      });
    };
    (recent || []).forEach(d => Object.entries(d.companyOrderNumbers || {}).forEach(([company, nums]) =>
      (nums as string[]).forEach(n => add(n, d.date, company))));
    const today = new Date().toLocaleDateString('en-CA');
    Object.entries(sessions || {}).forEach(([sid, data]) => {
      const company = sid.replace(/-(batch-\d+-\d+|\d+)$/, '');
      asArray((data as any)?.rowOrderNumbers).forEach(n => add(String(n ?? ''), today, company));
    });
    return map;
  }, [recent, sessions]);

  const statusOf = (c: AddressChange): { tone: 'ok' | 'wait' | 'bad'; text: string; today?: boolean } => {
    const sent = (sentIn.get(norm(c.orderNumber)) || []).sort((a, b) => b.date.localeCompare(a.date));
    if (c.appliedAt) return { tone: 'ok', text: `✓ ${md(c.appliedDate || '')} ${c.appliedCompany || ''} 발주서에 새 주소로 들어감` };
    if (sent.length) {
      const s = sent[0];
      const today = new Date().toLocaleDateString('en-CA');
      return s.date === today
        ? { tone: 'bad', today: true, text: `오늘 ${s.company} 발주서에 옛 주소로 들어가 있어요 — 아래 버튼으로 고치세요 (이미 보냈으면 업체에도 연락)` }
        : { tone: 'bad', text: `${md(s.date)} ${s.company} 발주서로 이미 나갔어요 — 업체에 직접 주소변경 연락` };
    }
    return { tone: 'wait', text: '대기 — 다음 발주서 만들 때 새 주소로 들어가요' };
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.orderNumber.trim() || !form.newAddress.trim()) return;
    if (changes.some(c => norm(c.orderNumber) === norm(form.orderNumber))
      && !confirm('이 주문번호로 등록한 주소변경이 이미 있어요. 새로 적은 주소로 바꿀까요?')) return;
    const existing = changes.find(c => norm(c.orderNumber) === norm(form.orderNumber));
    setSaving(true);
    try {
      const change: AddressChange = {
        id: existing?.id || `addr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        businessId: businessId || '안군농원',
        orderNumber: form.orderNumber.trim(),
        recipientName: form.recipientName.trim() || undefined,
        oldAddress: form.oldAddress || undefined,
        newAddress: form.newAddress.trim(),
        newZipcode: form.newZipcode.trim() || undefined,
        newPhone: form.newPhone.trim() || undefined,
        memo: form.memo.trim() || undefined,
        createdAt: Date.now(),
      };
      await saveAddressChange(change);
      // 오늘 발주서가 이미 만들어져 있으면 그 줄 주소를 바로 고친다
      const res = onApplyToMade?.(change);
      if (res && res.rows > 0) setNotice(`이미 만든 ${res.companies.join(', ')} 발주서 ${res.rows}줄의 주소를 바로 고쳤어요. 이미 보낸 발주서면 업체에 따로 알려 주세요.`);
      else setNotice('');
      setForm(EMPTY);
    } catch (err: any) {
      alert(`주소변경 저장 실패: ${err?.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  const input = 'w-full bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-2 text-xs font-bold text-white focus:ring-1 focus:ring-sky-500/30 outline-none';
  const waiting = changes.filter(c => statusOf(c).tone !== 'ok').length;

  return (
    <details className="glass-light rounded-2xl mb-3 group/addr">
      <summary className="flex items-center justify-between gap-2 p-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-zinc-800/20 rounded-2xl transition-colors duration-200">
        <h3 className="text-zinc-400 font-black text-[12px] uppercase tracking-widest flex items-center gap-2">
          <div className="bg-sky-500/10 p-1 rounded-lg text-[12px] leading-none">📍</div>
          주소 변경
          {waiting > 0 && <span className="bg-sky-600 text-white text-[9px] px-1.5 py-0.5 rounded-full font-black">{waiting}</span>}
        </h3>
        <span className="text-zinc-600 text-[10px] transition-transform group-open/addr:rotate-180">▼</span>
      </summary>
      <div className="px-4 pb-4 flex flex-col gap-2">
        <div className="relative">
          <input value={lookup} onChange={e => setLookup(e.target.value)} placeholder="주문번호나 받는분 이름으로 오늘 주문서에서 찾기" className={input} />
          {found.length > 0 && (
            <div className="mt-1 flex flex-col gap-1">
              {found.map(f => (
                <button key={f.orderNumber} type="button" onClick={() => pick(f)} className="text-left bg-zinc-950 border border-zinc-800 hover:border-sky-500 rounded-xl px-2.5 py-1.5">
                  <div className="text-[11px] font-black text-white">{f.name} <span className="text-zinc-500 font-bold">{f.orderNumber}</span></div>
                  <div className="text-[10px] text-zinc-500 truncate">{f.address}</div>
                </button>
              ))}
            </div>
          )}
          {norm(lookup).length >= 2 && found.length === 0 && (
            <div className="mt-1 text-[10px] text-zinc-600">오늘 주문서에 없어요. 주문번호를 아래에 직접 적어도 돼요.</div>
          )}
        </div>
        <form onSubmit={submit} className="flex flex-col gap-1.5">
          <input value={form.orderNumber} onChange={e => setForm({ ...form, orderNumber: e.target.value })} placeholder="주문번호 (필수)" className={input} />
          <input value={form.recipientName} onChange={e => setForm({ ...form, recipientName: e.target.value })} placeholder="받는분 (확인용)" className={input} />
          {form.oldAddress && <div className="text-[10px] text-zinc-500 px-1">지금 주소: {form.oldAddress}</div>}
          <input value={form.newAddress} onChange={e => setForm({ ...form, newAddress: e.target.value })} placeholder="새 주소 (필수)" className={input} />
          <input value={form.newZipcode} onChange={e => setForm({ ...form, newZipcode: e.target.value })} placeholder="새 우편번호 (모르면 비워 두기)" className={input} />
          <input value={form.newPhone} onChange={e => setForm({ ...form, newPhone: e.target.value })} placeholder="새 전화번호 (바뀔 때만)" className={input} />
          <input value={form.memo} onChange={e => setForm({ ...form, memo: e.target.value })} placeholder="메모" className={input} />
          <button type="submit" disabled={saving || !form.orderNumber.trim() || !form.newAddress.trim()} className="rounded-xl text-xs font-black py-2 btn-accent text-white disabled:opacity-50">
            {saving ? '저장 중…' : '주소변경 등록'}
          </button>
        </form>
        {notice && <div className="text-[10px] font-black text-emerald-400 px-1">{notice}</div>}
        {changes.length > 0 && (
          <div className="flex flex-col gap-1.5 mt-1">
            {changes.map(c => {
              const st = statusOf(c);
              return (
                <div key={c.id} className={`rounded-xl border px-2.5 py-2 ${st.tone === 'bad' ? 'border-rose-500/40 bg-rose-950/20' : st.tone === 'ok' ? 'border-emerald-500/30 bg-emerald-950/10' : 'border-zinc-800 bg-zinc-900/60'}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-black text-white truncate">{c.recipientName || '받는분?'}</span>
                    <span className="text-[10px] text-zinc-500 font-bold truncate">{c.orderNumber}</span>
                    <button type="button" onClick={() => { if (confirm('이 주소변경을 지울까요?')) deleteAddressChange(c.id).catch(err => alert(`삭제 실패: ${err?.message || err}`)); }} className="ml-auto text-zinc-600 hover:text-rose-500 text-[11px] font-black">✕</button>
                  </div>
                  <div className="text-[10px] text-zinc-300 mt-0.5">→ {c.newAddress}{c.newZipcode ? ` (${c.newZipcode})` : ''}{c.newPhone ? ` · ${c.newPhone}` : ''}</div>
                  {c.memo && <div className="text-[10px] text-zinc-500">{c.memo}</div>}
                  <div className={`text-[10px] font-black mt-0.5 ${st.tone === 'bad' ? 'text-rose-300' : st.tone === 'ok' ? 'text-emerald-400' : 'text-sky-400'}`}>{st.text}</div>
                  {st.today && onApplyToMade && (
                    <button type="button" onClick={() => {
                      const res = onApplyToMade(c);
                      setNotice(res.rows > 0 ? `${res.companies.join(', ')} 발주서 ${res.rows}줄의 주소를 고쳤어요.` : '오늘 발주서에서 이 주문 줄을 못 찾았어요.');
                    }} className="mt-1 px-2 py-1 rounded-lg text-[10px] font-black bg-rose-600 text-white">오늘 발주서 주소 바로 고치기</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
};

export default AddressChangePanel;
