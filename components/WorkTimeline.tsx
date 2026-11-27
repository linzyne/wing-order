import React, { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot, setDoc, deleteField } from 'firebase/firestore';
import { db } from '../firebase';
import { localYMD } from '../services/lotteReserve';

// 하루 업무 순서. due(시)가 있으면 그 시각이 지나도록 체크 안 했을 때 빨갛게 보인다.
type Step = { id: string; label: string; due?: number };
const DEFAULT_STEPS: Step[] = [
  { id: 'fakeMatch', label: '가구매매칭' },
  { id: 'csManual', label: 'CS/수동발주 추가' },
  { id: 'order10', label: '10시발주', due: 10 },
  { id: 'order15', label: '3시발주', due: 15 },
  { id: 'invoice', label: '송장업로드' },
  { id: 'deposit', label: '입금' },
];

type Checks = Record<string, { at: number }>;

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// 윙 '초기화' 버튼에서 부름 — 오늘 체크 전부 지움 (구독 중인 모든 PC에 바로 반영)
export const resetWorkTimeline = () =>
  setDoc(doc(db, 'workTimeline', localYMD(new Date())), { checks: {} })
    .catch(err => console.error('[업무 타임라인] 초기화 실패', err));

// 단계 목록은 workTimelineConfig/steps 한 문서 — 편집하면 모든 PC에 바로 반영
const stepsRef = () => doc(db, 'workTimelineConfig', 'steps');
const saveSteps = (steps: Step[]) =>
  setDoc(stepsRef(), {
    steps: steps.map(s => (s.due === undefined ? { id: s.id, label: s.label } : s)),
  }).catch(err => console.error('[업무 타임라인] 단계 저장 실패', err));

// 날짜별 문서 workTimeline/{YYYY-MM-DD} 하나를 구독 — 다른 PC에서 체크해도 바로 같이 보임
const WorkTimeline: React.FC = () => {
  const [now, setNow] = useState(() => new Date());
  const [checks, setChecks] = useState<Checks>({});
  const [STEPS, setSteps] = useState<Step[]>(DEFAULT_STEPS);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Step[]>([]);
  const date = localYMD(now);

  useEffect(() => onSnapshot(stepsRef(), snap => {
    const list = snap.data()?.steps as Step[] | undefined;
    setSteps(Array.isArray(list) ? list : DEFAULT_STEPS);
  }, err => console.error('[업무 타임라인] 단계 구독 실패', err)), []);

  const startEdit = () => { setDraft(STEPS.map(s => ({ ...s }))); setEditing(true); };
  const patch = (i: number, p: Partial<Step>) => setDraft(d => d.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const move = (i: number, dir: -1 | 1) => setDraft(d => {
    const j = i + dir;
    if (j < 0 || j >= d.length) return d;
    const n = [...d]; [n[i], n[j]] = [n[j], n[i]]; return n;
  });
  const remove = (i: number) => setDraft(d => d.filter((_, j) => j !== i));
  const add = () => setDraft(d => [...d, { id: `s${Date.now().toString(36)}`, label: '' }]);
  const save = () => {
    const clean = draft
      .map(s => ({ ...s, label: s.label.trim() }))
      .filter(s => s.label)
      .map(s => (s.due === undefined || isNaN(s.due) ? { id: s.id, label: s.label } : s));
    setSteps(clean);
    saveSteps(clean);
    setEditing(false);
  };

  // 시계: 마감 지남 표시와 자정 날짜 넘김용 (데이터 조회 아님)
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setChecks({});
    return onSnapshot(doc(db, 'workTimeline', date), snap => {
      setChecks((snap.data()?.checks as Checks) || {});
    }, err => console.error('[업무 타임라인] 구독 실패', err));
  }, [date]);

  const toggle = (id: string) => {
    const on = !!checks[id];
    setChecks(prev => {
      const next = { ...prev };
      if (on) delete next[id]; else next[id] = { at: Date.now() };
      return next;
    });
    setDoc(doc(db, 'workTimeline', date), {
      checks: { [id]: on ? deleteField() : { at: Date.now() } },
    }, { merge: true }).catch(err => console.error('[업무 타임라인] 저장 실패', err));
  };

  const nextId = useMemo(() => STEPS.find(s => !checks[s.id])?.id, [checks, STEPS]);
  const doneCount = STEPS.filter(s => checks[s.id]).length;

  if (editing) {
    return (
      <div className="flex-shrink-0 bg-zinc-950 border-b border-zinc-800/40 px-4 py-2 flex gap-3">
        <div className="flex flex-col gap-1 flex-shrink-0">
          <button onClick={save} className="px-3 py-1 rounded text-[11px] font-black bg-emerald-600 text-white hover:bg-emerald-500">저장</button>
          <button onClick={() => setEditing(false)} className="px-3 py-1 rounded text-[11px] font-black border border-zinc-700 text-zinc-400 hover:text-zinc-200">취소</button>
          <button onClick={add} className="px-3 py-1 rounded text-[11px] font-black border border-sky-700 text-sky-300 hover:bg-sky-950/40">+ 추가</button>
        </div>
        <div className="flex flex-col gap-1 max-w-md">
          {draft.map((s, i) => (
            <div key={s.id} className="flex items-center gap-1">
              <span className="w-4 text-[10px] text-zinc-600 text-right">{i + 1}</span>
              <input
                value={s.label}
                autoFocus={!s.label}
                onChange={e => patch(i, { label: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
                placeholder="업무 이름"
                className="w-44 bg-zinc-900 border border-zinc-700 rounded px-2 py-0.5 text-[11px] text-zinc-200 outline-none focus:border-sky-500"
              />
              <select
                value={s.due ?? ''}
                onChange={e => patch(i, { due: e.target.value === '' ? undefined : Number(e.target.value) })}
                title="이 시각까지 체크 안 하면 빨갛게"
                className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-[11px] text-zinc-300 outline-none"
              >
                <option value="">마감 없음</option>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h}시 마감</option>)}
              </select>
              <button onClick={() => move(i, -1)} disabled={i === 0} className="px-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-20" title="위로">▲</button>
              <button onClick={() => move(i, 1)} disabled={i === draft.length - 1} className="px-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-20" title="아래로">▼</button>
              <button onClick={() => remove(i)} className="px-1 text-rose-500/70 hover:text-rose-400" title="삭제">✕</button>
            </div>
          ))}
          {draft.length === 0 && <span className="text-[11px] text-zinc-600">단계 없음 — + 추가</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-shrink-0 bg-zinc-950 border-b border-zinc-800/40 px-4 py-1.5 flex items-center gap-1 overflow-x-auto custom-scrollbar">
      <span className="text-[10px] font-black text-zinc-500 mr-1 whitespace-nowrap">
        오늘 {doneCount}/{STEPS.length}
      </span>
      {STEPS.map((s, i) => {
        const c = checks[s.id];
        const overdue = !c && s.due !== undefined && now.getHours() >= s.due;
        const isNext = s.id === nextId;
        return (
          <React.Fragment key={s.id}>
            {i > 0 && <div className={`w-4 h-px flex-shrink-0 ${checks[STEPS[i - 1].id] ? 'bg-emerald-600' : 'bg-zinc-700'}`} />}
            <button
              onClick={() => toggle(s.id)}
              title={c ? `${hhmm(c.at)} 완료 — 누르면 취소` : '끝났으면 눌러서 체크'}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-black whitespace-nowrap border transition-all active:scale-95 ${
                c
                  ? 'bg-emerald-900/40 border-emerald-700 text-emerald-300'
                  : overdue
                  ? 'border-rose-500/70 text-rose-300 bg-rose-950/40'
                  : isNext
                  ? 'border-sky-500/70 text-white bg-sky-950/40'
                  : 'border-zinc-700/60 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <span className={`w-3.5 h-3.5 rounded-full flex items-center justify-center text-[9px] ${c ? 'bg-emerald-500 text-zinc-950' : 'border border-current'}`}>
                {c ? '✓' : ''}
              </span>
              <span>{s.label}</span>
              {c && <span className="text-[9px] font-bold text-emerald-500/80">{hhmm(c.at)}</span>}
            </button>
          </React.Fragment>
        );
      })}
      <button onClick={startEdit} title="단계 추가·수정·삭제" className="ml-2 px-1.5 py-0.5 rounded text-[11px] text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 flex-shrink-0">✎ 편집</button>
    </div>
  );
};

export default WorkTimeline;
