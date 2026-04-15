import React, { useEffect, useMemo, useRef, useState } from 'react';

interface Quest {
  id: string;
  label: string;
  title: string;
  done: boolean;
}

const STORAGE_KEY = 'quest-timeline-v1';

const nextLetter = (count: number): string => {
  // A, B, ..., Z, AA, AB, ...
  let n = count;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

const loadQuests = (): Quest[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return [];
};

const QuestTimeline: React.FC = () => {
  const [quests, setQuests] = useState<Quest[]>(loadQuests);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [burstId, setBurstId] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(quests));
  }, [quests]);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const completedCount = quests.filter(q => q.done).length;
  const totalCount = quests.length;
  const progress = totalCount ? (completedCount / totalCount) * 100 : 0;
  const allDone = totalCount > 0 && completedCount === totalCount;

  const handleToggle = (id: string) => {
    setQuests(prev =>
      prev.map(q => {
        if (q.id !== id) return q;
        const becoming = !q.done;
        if (becoming) {
          setBurstId(id);
          setShake(true);
          setTimeout(() => setBurstId(null), 900);
          setTimeout(() => setShake(false), 450);
        }
        return { ...q, done: becoming };
      })
    );
  };

  const handleAdd = () => {
    const title = newTitle.trim();
    if (!title) {
      setAdding(false);
      return;
    }
    const label = nextLetter(quests.length);
    setQuests(prev => [...prev, { id: `${Date.now()}-${Math.random()}`, label, title, done: false }]);
    setNewTitle('');
    setAdding(false);
  };

  const handleRemove = (id: string) => {
    setQuests(prev => {
      const filtered = prev.filter(q => q.id !== id);
      return filtered.map((q, i) => ({ ...q, label: nextLetter(i) }));
    });
  };

  const handleReset = () => {
    if (!window.confirm('모든 퀘스트를 초기화하시겠습니까?')) return;
    setQuests([]);
  };

  const particles = useMemo(
    () => Array.from({ length: 14 }).map((_, i) => ({
      i,
      angle: (360 / 14) * i + Math.random() * 10,
      dist: 40 + Math.random() * 30,
    })),
    [burstId]
  );

  return (
    <div
      className={`relative mb-6 p-5 rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-900/95 via-zinc-900/80 to-black/90 shadow-2xl overflow-hidden ${shake ? 'quest-shake' : ''}`}
    >
      <div className="absolute inset-0 quest-grid-bg pointer-events-none opacity-40" />
      <div className="absolute -top-12 -left-12 w-40 h-40 rounded-full bg-rose-500/10 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-12 -right-12 w-40 h-40 rounded-full bg-fuchsia-500/10 blur-3xl pointer-events-none" />

      <div className="relative flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="absolute inset-0 rounded-lg bg-rose-500 blur-md opacity-60 animate-pulse" />
            <div className="relative w-8 h-8 rounded-lg bg-gradient-to-br from-rose-400 to-fuchsia-600 flex items-center justify-center text-white font-black text-sm shadow-lg">
              ★
            </div>
          </div>
          <div>
            <h2 className="text-white font-black text-sm tracking-wider uppercase">Daily Quest</h2>
            <p className="text-zinc-500 font-bold text-[10px] tracking-widest uppercase">
              {completedCount} / {totalCount} Cleared {allDone && '· 🔥 ALL CLEAR!'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAdding(true)}
            className="px-3 py-1.5 text-[11px] font-black rounded-lg bg-rose-500 hover:bg-rose-400 text-white transition-all shadow-lg shadow-rose-900/40 hover:shadow-rose-500/40 hover:scale-105"
          >
            + ADD QUEST
          </button>
          {totalCount > 0 && (
            <button
              onClick={handleReset}
              className="px-2 py-1.5 text-[11px] font-black rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-all"
            >
              RESET
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="relative h-2 rounded-full bg-zinc-800/80 overflow-hidden mb-5 shadow-inner">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-rose-500 via-fuchsia-500 to-amber-400 transition-all duration-700 ease-out"
          style={{ width: `${progress}%` }}
        >
          <div className="absolute inset-0 quest-shine rounded-full" />
        </div>
        {progress > 0 && (
          <div
            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow-[0_0_12px_rgba(244,63,94,0.9)] transition-all duration-700"
            style={{ left: `calc(${progress}% - 6px)` }}
          />
        )}
      </div>

      {/* Quest nodes */}
      <div className="relative flex items-start gap-1 overflow-x-auto custom-scrollbar pb-1">
        {quests.length === 0 && !adding && (
          <div className="w-full text-center py-6 text-zinc-600 font-bold text-xs tracking-widest uppercase">
            ▸ No Active Quests — Press <span className="text-rose-400">+ ADD QUEST</span> to begin
          </div>
        )}
        {quests.map((q, idx) => {
          const isBurst = burstId === q.id;
          return (
            <React.Fragment key={q.id}>
              {idx > 0 && (
                <div className="flex-shrink-0 pt-5 px-1">
                  <div
                    className={`h-[3px] w-8 rounded-full transition-all duration-500 ${
                      q.done && quests[idx - 1].done
                        ? 'bg-gradient-to-r from-rose-500 to-fuchsia-500 shadow-[0_0_8px_rgba(244,63,94,0.7)]'
                        : 'bg-zinc-800'
                    }`}
                  />
                </div>
              )}
              <div className="flex-shrink-0 flex flex-col items-center gap-1.5 group relative" style={{ minWidth: 68 }}>
                <button
                  onClick={() => handleToggle(q.id)}
                  className={`relative w-12 h-12 rounded-xl flex items-center justify-center font-black text-lg transition-all duration-300 ${
                    q.done
                      ? 'bg-gradient-to-br from-rose-400 via-fuchsia-500 to-amber-400 text-white shadow-[0_0_20px_rgba(244,63,94,0.8)] scale-105 quest-glow'
                      : 'bg-zinc-800 text-zinc-500 border-2 border-dashed border-zinc-700 hover:border-rose-500 hover:text-rose-400 quest-idle'
                  }`}
                >
                  {q.done ? '✓' : q.label}
                  {isBurst && (
                    <>
                      <span className="absolute inset-0 rounded-xl quest-flash pointer-events-none" />
                      {particles.map(p => (
                        <span
                          key={p.i}
                          className="absolute top-1/2 left-1/2 w-1.5 h-1.5 rounded-full bg-gradient-to-br from-amber-300 to-rose-500 pointer-events-none quest-particle"
                          style={{
                            ['--angle' as any]: `${p.angle}deg`,
                            ['--dist' as any]: `${p.dist}px`,
                          }}
                        />
                      ))}
                    </>
                  )}
                </button>
                <div
                  className={`text-[10px] font-black text-center max-w-[68px] truncate uppercase tracking-wide ${
                    q.done ? 'text-rose-300 line-through opacity-70' : 'text-zinc-400'
                  }`}
                  title={q.title}
                >
                  {q.label}. {q.title}
                </div>
                <button
                  onClick={() => handleRemove(q.id)}
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-zinc-700 hover:bg-red-500 text-white text-[9px] font-black opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                  title="삭제"
                >
                  ×
                </button>
              </div>
            </React.Fragment>
          );
        })}

        {adding && (
          <div className="flex-shrink-0 flex flex-col items-center gap-1.5 ml-1">
            <div className="w-12 h-12 rounded-xl bg-zinc-800 border-2 border-rose-500 flex items-center justify-center font-black text-rose-400 text-lg animate-pulse">
              {nextLetter(quests.length)}
            </div>
            <input
              ref={inputRef}
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              onBlur={handleAdd}
              onKeyDown={e => {
                if (e.key === 'Enter') handleAdd();
                if (e.key === 'Escape') {
                  setNewTitle('');
                  setAdding(false);
                }
              }}
              placeholder="할일..."
              className="w-24 px-2 py-1 text-[10px] font-bold bg-zinc-800 border border-rose-500 rounded text-white focus:outline-none focus:ring-1 focus:ring-rose-400"
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default QuestTimeline;
