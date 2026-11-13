import React, { useEffect, useState } from 'react';
import { subscribeSentBatches, cancelSentBatch, isSentOverdue, businessDaysAfter, SENT_METHOD_LABEL, SENT_RECORDED_EVENT, type SentBatch, type SentRecordedDetail } from '../services/sentOrders';

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// 주문서 패널 맨 위: 이미 발주한 묶음(송장 아직 없음). 평소 한 줄로 접혀 있고 송장 없음이 있으면 빨간색.
export const SentOrdersBar: React.FC = () => {
  const [batches, setBatches] = useState<SentBatch[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => subscribeSentBatches(setBatches), []);

  if (batches.length === 0) return null;
  const now = new Date();
  const overdue = batches.filter(b => isSentOverdue(b, now));
  const overdueCount = overdue.reduce((s, b) => s + b.orderNumbers.length, 0);
  const sorted = [...overdue, ...batches.filter(b => !overdue.includes(b))];

  const handleCancel = async (b: SentBatch) => {
    const today = new Date().toLocaleDateString('en-CA');
    if (b.recordDate !== today && !window.confirm(`${b.businessName} ${b.company} ${b.orderNumbers.length}건 발주기록을 취소할까요?\n다음 주문서에 다시 들어갑니다.`)) return;
    try { await cancelSentBatch(b.id); } catch (e: any) { alert(`취소 실패\n${e?.message || e}`); }
  };

  return (
    <div className={`rounded-xl border ${overdueCount > 0 ? 'border-red-500/60 bg-red-950/30' : 'border-amber-700/40 bg-amber-950/20'}`}>
      <button onClick={() => setOpen(v => !v)} className="w-full flex items-center gap-1.5 px-3 py-2 text-[11px] font-black text-left">
        <span className="text-amber-300">이미 발주 {batches.length}묶음</span>
        {overdueCount > 0 && <span className="text-red-400">· 송장 없음 {overdueCount}건 🔴</span>}
        <svg className={`ml-auto w-3 h-3 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="flex flex-col gap-1 px-2 pb-2 max-h-64 overflow-y-auto custom-scrollbar">
          {sorted.map(b => {
            const late = overdue.includes(b);
            return (
              <div key={b.id} className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-[10px] ${late ? 'bg-red-900/30' : 'bg-zinc-900/60'}`}>
                <button
                  onClick={() => handleCancel(b)}
                  title="발주기록 취소 — 다음 주문서에 다시 들어갑니다"
                  className="shrink-0 px-2 py-0.5 rounded border border-zinc-600 text-zinc-300 font-black hover:border-zinc-400 hover:text-white"
                >취소</button>
                <div className="flex flex-col min-w-0" title={b.orderNumbers.join('\n')}>
                  <span className={`font-black ${late ? 'text-red-300' : 'text-zinc-200'}`}>{b.businessName} · {b.company} · {b.orderNumbers.length}건</span>
                  <span className="text-zinc-500">
                    {fmtTime(b.createdAtMs)} · {b.label} · {SENT_METHOD_LABEL[b.method] || b.method}
                    {late && <span className="text-red-400"> · 송장 없음 (영업일 {businessDaysAfter(b.recordDate, now)}일째)</span>}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// 발주기록이 생기면 화면 아래에 잠깐 띄움 — 테스트로 받은 거면 여기서 바로 취소
export const SentOrderToast: React.FC = () => {
  const [items, setItems] = useState<SentRecordedDetail[]>([]);
  useEffect(() => {
    const onRecorded = (e: Event) => {
      const d = (e as CustomEvent<SentRecordedDetail>).detail;
      setItems(prev => [...prev, d]);
      setTimeout(() => setItems(prev => prev.filter(x => x.id !== d.id)), 8000);
    };
    window.addEventListener(SENT_RECORDED_EVENT, onRecorded);
    return () => window.removeEventListener(SENT_RECORDED_EVENT, onRecorded);
  }, []);
  if (items.length === 0) return null;
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] flex flex-col gap-1.5 items-center">
      {items.map(it => (
        <div key={it.id} className="flex items-center gap-3 bg-zinc-800 border border-amber-600/50 rounded-xl px-3 py-2 shadow-2xl text-[11px] font-black text-zinc-100">
          <span className="text-emerald-400">✓</span>
          <span>{it.text}</span>
          <button
            onClick={async () => {
              setItems(prev => prev.filter(x => x.id !== it.id));
              try { await cancelSentBatch(it.id); } catch (e: any) { alert(`취소 실패\n${e?.message || e}`); }
            }}
            className="px-2 py-0.5 rounded border border-zinc-500 text-zinc-200 hover:border-white hover:text-white"
          >취소</button>
        </div>
      ))}
    </div>
  );
};
