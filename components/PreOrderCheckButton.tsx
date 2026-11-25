import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { runPreOrderCheck, type CheckIssue, type PreOrderCheckResult } from '../services/preOrderCheck';

// 발주전확인 버튼 + 결과 창. 통합주문서(공통 주문서 업로드) 창의 이메일 묶음 바로 위에 둔다.

interface Props {
  businesses: { id: string; displayName: string }[];
}

const SECTIONS: { key: 'cs' | 'manualOrders' | 'transfers'; label: string; okText: string }[] = [
  { key: 'cs', label: 'CS 접수', okText: '대기 중인 CS 없음' },
  { key: 'manualOrders', label: '수동발주', okText: '대기 목록이 모두 오늘 발주서에 들어감' },
  { key: 'transfers', label: '수동입금', okText: '오늘 넣은 입금이 모두 입금목록에 있음' },
];

const PreOrderCheckButton: React.FC<Props> = ({ businesses }) => {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PreOrderCheckResult | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const run = async () => {
    if (running) return;
    setRunning(true);
    try {
      setResult(await runPreOrderCheck(businesses));
      setCheckedAt(Date.now());
    } catch (e: any) {
      alert(`발주전확인 실패: ${e?.message || e}`);
    } finally {
      setRunning(false);
    }
  };

  const errors = result ? [...result.cs, ...result.manualOrders, ...result.transfers].filter(i => i.level === 'error').length : 0;
  const warns = result ? [...result.cs, ...result.manualOrders, ...result.transfers].filter(i => i.level === 'warn').length : 0;

  const row = (i: CheckIssue, idx: number) => (
    <div key={idx} className={`rounded-xl border px-3 py-2 ${i.level === 'error' ? 'border-rose-500/40 bg-rose-950/20' : 'border-amber-500/40 bg-amber-950/20'}`}>
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-zinc-500 font-bold shrink-0">{i.businessName}</span>
        <span className="text-white font-black truncate">{i.title}</span>
      </div>
      <div className={`text-[11px] font-bold mt-0.5 ${i.level === 'error' ? 'text-rose-300' : 'text-amber-300'}`}>{i.detail}</div>
    </div>
  );

  return (
    <>
      <button
        onClick={run}
        disabled={running}
        className="w-full mb-1 px-3 py-2 rounded-xl text-[12px] font-black btn-accent text-white disabled:opacity-60"
        title="CS 대기·수동발주·수동입금이 오늘 발주서와 입금목록에 다 들어갔는지 확인"
      >
        {running ? '확인 중…' : '✅ 발주전확인'}
      </button>
      {result && createPortal(
        <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4" onClick={() => setResult(null)}>
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
              <div>
                <div className="text-white font-black text-sm">
                  {errors > 0 ? `⚠️ 빠진 것 ${errors}건` : warns > 0 ? `확인할 것 ${warns}건` : '✅ 다 들어갔어요'}
                </div>
                <div className="text-zinc-500 text-[10px] mt-0.5">
                  모든 사업자 · 오늘 발주서와 입금목록 기준{checkedAt ? ` · ${new Date(checkedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 확인` : ''}
                </div>
              </div>
              <button onClick={() => setResult(null)} className="text-zinc-500 hover:text-white text-lg font-black px-2">×</button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
              {SECTIONS.map(s => {
                const list = result[s.key];
                return (
                  <div key={s.key}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[12px] font-black text-white">{s.label}</span>
                      {list.length > 0
                        ? <span className="text-[10px] font-black px-1.5 rounded-full bg-rose-600 text-white">{list.length}</span>
                        : <span className="text-[10px] font-bold text-emerald-400">✓ {s.okText}</span>}
                    </div>
                    {list.length > 0 && <div className="flex flex-col gap-1.5">{list.map(row)}</div>}
                  </div>
                );
              })}
            </div>
            <div className="px-4 py-3 border-t border-zinc-800 flex gap-2">
              <button onClick={run} disabled={running} className="px-3 py-2 rounded-xl text-[11px] font-black bg-zinc-900 border border-zinc-700 text-zinc-300 hover:text-white">
                {running ? '확인 중…' : '다시 확인'}
              </button>
              <button onClick={() => setResult(null)} className="flex-1 px-3 py-2 rounded-xl text-[11px] font-black btn-accent text-white">닫기</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

export default PreOrderCheckButton;
