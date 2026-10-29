import React, { useEffect, useState } from 'react';
import { createWingRequests, subscribeWingRequests, type WingRequest } from '../services/wingInbox';

interface Props {
  businesses: { id: string; displayName: string }[];
  /** 사업자의 지금 다음 차수 — 1이면 1차(상품준비중), 아니면 2차(결제확인)로 받는다.
   *  화면에 들고 있던 값은 늦게 바뀔 수 있어(1차가 있는데 1차로 보여 상품준비중 전체를 또 받던 일) 누를 때마다 새로 읽는다 */
  getNextRound: (businessId: string) => number;
}

const SELECTED_KEY = 'wingFetchSelected';
const loadSelected = (): Record<string, boolean> => {
  try { return JSON.parse(localStorage.getItem(SELECTED_KEY) || '{}'); } catch { return {}; }
};

// 쿠팡에서 받기: 체크한 사업자마다 그 크롬 프로필의 확장에 받기 요청을 보내고 진행 상황을 보여 준다.
// 받은 파일은 wingInbox → 주문서 업로드로 따로 들어온다.
const WingFetchBar: React.FC<Props> = ({ businesses, getNextRound }) => {
  const [selected, setSelected] = useState<Record<string, boolean>>(loadSelected);
  // 주문서 창을 닫았다 열어도 진행 상황이 이어지게 이번 요청 묶음 id를 기억
  const [batchId, setBatchIdState] = useState<string | null>(() => {
    try { return sessionStorage.getItem('wingFetchBatch'); } catch { return null; }
  });
  const setBatchId = (id: string) => {
    try { sessionStorage.setItem('wingFetchBatch', id); } catch { /* 저장 실패는 무시 */ }
    setBatchIdState(id);
  };
  const [reqs, setReqs] = useState<WingRequest[]>([]);
  const [sending, setSending] = useState(false);
  const [now, setNow] = useState(Date.now());

  const isOn = (id: string) => selected[id] !== false;
  const toggle = (id: string) => setSelected(prev => {
    const next = { ...prev, [id]: !isOn(id) };
    try { localStorage.setItem(SELECTED_KEY, JSON.stringify(next)); } catch { /* 저장 실패는 무시 */ }
    return next;
  });

  useEffect(() => (batchId ? subscribeWingRequests(batchId, setReqs) : undefined), [batchId]);
  // '응답 없음' 판단·칩의 차수 표시를 위해 2초마다 다시 그린다
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(t);
  }, []);
  // 45초 넘게 아무 확장도 안 가져간 요청(응답 없음)이나 5분 넘게 안 끝난 요청은 끝난 것으로 봐서 다시 누를 수 있게 한다
  const active = reqs.some(r =>
    (r.status === 'running' && now - r.createdAt <= 5 * 60_000) || (r.status === 'pending' && now - r.createdAt <= 45_000));

  const start = async () => {
    const targets = businesses.filter(b => isOn(b.id))
      .map(b => ({ businessName: b.displayName, mode: getNextRound(b.id) === 1 ? 'first' as const : 'next' as const }));
    if (targets.length === 0 || sending) return;
    setSending(true);
    try {
      setReqs([]);
      setBatchId(await createWingRequests(targets));
    } catch (e: any) {
      alert(`받기 요청 실패: ${e?.message ?? e}`);
    } finally {
      setSending(false);
    }
  };

  const doneCount = reqs.filter(r => r.status === 'done').length;
  const statusText = (r: WingRequest) => {
    if (r.status === 'done') return { text: `✓ ${r.message}`, cls: 'text-emerald-400' };
    if (r.status === 'error') return { text: `✕ ${r.message}`, cls: 'text-red-400' };
    if (r.status === 'pending' && now - r.createdAt > 45_000) return { text: '응답 없음 — 그 프로필 창이 열려 있나요?', cls: 'text-amber-400' };
    if (r.status === 'pending') return { text: '확장 기다리는 중…', cls: 'text-zinc-500' };
    return { text: r.message || '받는 중…', cls: 'text-sky-400' };
  };

  return (
    <div className="flex flex-col gap-1.5 bg-zinc-800/40 border border-zinc-700/50 rounded-xl p-2">
      <div className="flex items-center gap-1.5">
        <button
          onClick={start}
          disabled={sending || active || !businesses.some(b => isOn(b.id))}
          className="px-2.5 py-1 rounded-lg text-[11px] font-black text-white bg-red-600 hover:bg-red-500 disabled:opacity-40 transition-colors"
        >
          {active ? '받는 중…' : '쿠팡에서 받기'}
        </button>
        {reqs.length > 0 && (
          <span className="text-[10px] font-bold text-zinc-400">{reqs.length}곳 중 {doneCount}곳 완료</span>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {businesses.map(b => {
          const first = getNextRound(b.id) === 1;
          return (
            <button
              key={b.id}
              onClick={() => toggle(b.id)}
              title={first ? '1차: 결제완료를 모은 뒤 상품준비중 전체' : '2차: 결제확인의 새 주문만'}
              className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition-colors ${
                isOn(b.id) ? 'bg-zinc-700 text-zinc-100 border-zinc-500' : 'bg-transparent text-zinc-600 border-zinc-700 line-through'
              }`}
            >
              {b.displayName} <span className="text-zinc-400 font-normal">{first ? '1차 상품준비중' : '2차 결제확인'}</span>
            </button>
          );
        })}
      </div>
      {reqs.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {reqs.map(r => {
            const s = statusText(r);
            return (
              <div key={r.id} className="text-[10px] flex gap-1.5">
                <span className="font-black text-zinc-300 shrink-0">{r.businessName}</span>
                <span className={`${s.cls} truncate`} title={s.text}>{s.text}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default WingFetchBar;
