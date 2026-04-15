import React, { useEffect, useMemo, useRef, useState } from 'react';
import { subscribeQuests, saveQuests as saveQuestsToFirestore } from '../services/firestoreService';

interface SubQuest {
  id: string;
  title: string;
  done: boolean;
}

interface Quest {
  id: string;
  label: string;
  title: string;
  done: boolean;
  children: SubQuest[];
}

const STORAGE_KEY = 'quest-timeline-v1';

const nextLetter = (count: number): string => {
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
    if (!Array.isArray(parsed)) return [];
    return parsed.map((q: any) => ({
      id: String(q.id),
      label: String(q.label ?? ''),
      title: String(q.title ?? ''),
      done: Boolean(q.done),
      children: Array.isArray(q.children)
        ? q.children.map((c: any) => ({ id: String(c.id), title: String(c.title ?? ''), done: Boolean(c.done) }))
        : [],
    }));
  } catch {}
  return [];
};

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const QuestTimeline: React.FC = () => {
  const [quests, setQuests] = useState<Quest[]>(loadQuests);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [addingChildFor, setAddingChildFor] = useState<string | null>(null);
  const [newChildTitle, setNewChildTitle] = useState('');
  const [editing, setEditing] = useState<{ kind: 'quest' | 'sub'; id: string; parentId?: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [burstId, setBurstId] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const childInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const pendingSaves = useRef(0);
  const saveGraceUntil = useRef(0);
  const questsRef = useRef<Quest[]>(quests);
  useEffect(() => { questsRef.current = quests; }, [quests]);

  // localStorage 캐시 (Firestore 실패/오프라인 시 백업)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(quests));
    } catch {}
  }, [quests]);

  // Firestore 구독 — 서버를 소스 오브 트루스로 사용하되,
  // "내가 삭제하기 전엔 절대 안 지워짐" 원칙에 따라 빈 결과로 덮어쓰지 않음.
  useEffect(() => {
    const unsub = subscribeQuests((serverQuests) => {
      if (pendingSaves.current > 0 || Date.now() < saveGraceUntil.current) return;
      if (serverQuests === null) {
        if (questsRef.current.length > 0) {
          saveQuestsToFirestore(questsRef.current).catch(err =>
            console.error('[Quests] 초기 업로드 실패:', err)
          );
        }
        return;
      }
      if (serverQuests.length === 0 && questsRef.current.length > 0) {
        console.warn('[Quests] 서버 빈 상태 감지 → 로컬 데이터 복구 업로드');
        saveQuestsToFirestore(questsRef.current).catch(err =>
          console.error('[Quests] 복구 업로드 실패:', err)
        );
        return;
      }
      const normalized: Quest[] = serverQuests.map((q: any) => ({
        id: String(q.id),
        label: String(q.label ?? ''),
        title: String(q.title ?? ''),
        done: Boolean(q.done),
        children: Array.isArray(q.children)
          ? q.children.map((c: any) => ({ id: String(c.id), title: String(c.title ?? ''), done: Boolean(c.done) }))
          : [],
      }));
      setQuests(normalized);
    });
    return unsub;
  }, []);

  const persist = (updater: (prev: Quest[]) => Quest[]) => {
    pendingSaves.current++;
    setQuests(prev => {
      const next = updater(prev);
      saveQuestsToFirestore(next)
        .then(() => { saveGraceUntil.current = Date.now() + 1500; })
        .catch(err => console.error('[Quests] Firestore 저장 실패 (localStorage 백업됨):', err))
        .finally(() => { pendingSaves.current--; });
      return next;
    });
  };

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);
  useEffect(() => {
    if (addingChildFor) childInputRef.current?.focus();
  }, [addingChildFor]);
  useEffect(() => {
    if (editing) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editing]);

  const { completedCount, totalCount } = useMemo(() => {
    let done = 0;
    let total = 0;
    quests.forEach(q => {
      total += 1;
      if (q.done) done += 1;
      q.children.forEach(c => {
        total += 1;
        if (c.done) done += 1;
      });
    });
    return { completedCount: done, totalCount: total };
  }, [quests]);
  const progress = totalCount ? (completedCount / totalCount) * 100 : 0;
  const allDone = totalCount > 0 && completedCount === totalCount;

  const triggerBurst = (id: string) => {
    setBurstId(id);
    setShake(true);
    setTimeout(() => setBurstId(null), 900);
    setTimeout(() => setShake(false), 450);
  };

  const handleToggleQuest = (id: string) => {
    persist(prev =>
      prev.map(q => {
        if (q.id !== id) return q;
        const becoming = !q.done;
        if (becoming) triggerBurst(id);
        return { ...q, done: becoming };
      })
    );
  };

  const handleToggleSub = (parentId: string, childId: string) => {
    persist(prev =>
      prev.map(q => {
        if (q.id !== parentId) return q;
        return {
          ...q,
          children: q.children.map(c => {
            if (c.id !== childId) return c;
            const becoming = !c.done;
            if (becoming) triggerBurst(childId);
            return { ...c, done: becoming };
          }),
        };
      })
    );
  };

  const handleAdd = () => {
    const title = newTitle.trim();
    if (!title) {
      setAdding(false);
      return;
    }
    persist(prev => [
      ...prev,
      { id: uid(), label: nextLetter(prev.length), title, done: false, children: [] },
    ]);
    setNewTitle('');
    setAdding(false);
  };

  const handleAddChild = (parentId: string) => {
    const title = newChildTitle.trim();
    if (!title) {
      setAddingChildFor(null);
      return;
    }
    persist(prev =>
      prev.map(q =>
        q.id === parentId
          ? { ...q, children: [...q.children, { id: uid(), title, done: false }] }
          : q
      )
    );
    setNewChildTitle('');
    setAddingChildFor(null);
  };

  const handleRemoveQuest = (id: string) => {
    const target = quests.find(q => q.id === id);
    if (!target) return;
    if (!window.confirm(`"${target.label}. ${target.title}" 퀘스트를 삭제하시겠습니까?${target.children.length ? `\n하위 ${target.children.length}개도 함께 삭제됩니다.` : ''}`)) return;
    persist(prev => {
      const filtered = prev.filter(q => q.id !== id);
      return filtered.map((q, i) => ({ ...q, label: nextLetter(i) }));
    });
  };

  const handleRemoveSub = (parentId: string, childId: string) => {
    const parent = quests.find(q => q.id === parentId);
    const child = parent?.children.find(c => c.id === childId);
    if (!child) return;
    if (!window.confirm(`"${child.title}" 하위 퀘스트를 삭제하시겠습니까?`)) return;
    persist(prev =>
      prev.map(q =>
        q.id === parentId ? { ...q, children: q.children.filter(c => c.id !== childId) } : q
      )
    );
  };

  const startEditQuest = (q: Quest) => {
    setEditing({ kind: 'quest', id: q.id });
    setEditValue(q.title);
  };
  const startEditSub = (parentId: string, c: SubQuest) => {
    setEditing({ kind: 'sub', id: c.id, parentId });
    setEditValue(c.title);
  };

  const commitEdit = () => {
    if (!editing) return;
    const value = editValue.trim();
    if (!value) {
      setEditing(null);
      return;
    }
    if (editing.kind === 'quest') {
      persist(prev => prev.map(q => (q.id === editing.id ? { ...q, title: value } : q)));
    } else {
      persist(prev =>
        prev.map(q =>
          q.id === editing.parentId
            ? { ...q, children: q.children.map(c => (c.id === editing.id ? { ...c, title: value } : c)) }
            : q
        )
      );
    }
    setEditing(null);
  };

  const cancelEdit = () => setEditing(null);

  const handleReset = () => {
    if (!window.confirm('⚠️ 모든 퀘스트를 초기화합니다. 정말 삭제하시겠습니까?\n(이 동작은 되돌릴 수 없습니다)')) return;
    if (!window.confirm('한 번 더 확인합니다. 정말 모든 퀘스트를 지우시겠습니까?')) return;
    persist(() => []);
  };

  const particles = useMemo(
    () =>
      Array.from({ length: 14 }).map((_, i) => ({
        i,
        angle: (360 / 14) * i + Math.random() * 10,
        dist: 40 + Math.random() * 30,
      })),
    [burstId]
  );

  const renderBurst = (targetId: string) => {
    if (burstId !== targetId) return null;
    return (
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
    );
  };

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
              {completedCount} / {totalCount} Cleared {allDone && '· 🔥 ALL CLEAR!'} · 더블클릭 수정
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
          const isEditingThis = editing?.kind === 'quest' && editing.id === q.id;
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
              <div
                className="flex-shrink-0 flex flex-col items-center gap-1.5 group relative"
                style={{ minWidth: 88 }}
              >
                <button
                  onClick={() => handleToggleQuest(q.id)}
                  onDoubleClick={e => {
                    e.stopPropagation();
                    startEditQuest(q);
                  }}
                  title="클릭: 완료 · 더블클릭: 수정"
                  className={`relative w-12 h-12 rounded-xl flex items-center justify-center font-black text-lg transition-all duration-300 ${
                    q.done
                      ? 'bg-gradient-to-br from-rose-400 via-fuchsia-500 to-amber-400 text-white shadow-[0_0_20px_rgba(244,63,94,0.8)] scale-105 quest-glow'
                      : 'bg-zinc-800 text-zinc-500 border-2 border-dashed border-zinc-700 hover:border-rose-500 hover:text-rose-400 quest-idle'
                  }`}
                >
                  {q.done ? '✓' : q.label}
                  {renderBurst(q.id)}
                </button>

                {isEditingThis ? (
                  <input
                    ref={editInputRef}
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitEdit();
                      if (e.key === 'Escape') cancelEdit();
                    }}
                    className="w-20 px-1.5 py-0.5 text-[10px] font-bold bg-zinc-800 border border-rose-500 rounded text-white focus:outline-none focus:ring-1 focus:ring-rose-400 text-center"
                  />
                ) : (
                  <div
                    onDoubleClick={() => startEditQuest(q)}
                    className={`text-[10px] font-black text-center max-w-[84px] truncate uppercase tracking-wide cursor-text ${
                      q.done ? 'text-rose-300 line-through opacity-70' : 'text-zinc-300'
                    }`}
                    title={`${q.title} (더블클릭 수정)`}
                  >
                    {q.label}. {q.title}
                  </div>
                )}

                {/* Sub-quests */}
                <div className="flex flex-col gap-1 mt-1 w-full items-center">
                  {q.children.map((c, cIdx) => {
                    const subLabel = `${q.label}-${cIdx + 1}`;
                    const isEditingSub = editing?.kind === 'sub' && editing.id === c.id;
                    return (
                      <div key={c.id} className="relative group/sub w-full flex justify-center">
                        <button
                          onClick={() => handleToggleSub(q.id, c.id)}
                          onDoubleClick={e => {
                            e.stopPropagation();
                            startEditSub(q.id, c);
                          }}
                          title="클릭: 완료 · 더블클릭: 수정"
                          className={`relative flex items-center gap-1 px-2 py-1 rounded-md text-[9px] font-black transition-all max-w-[88px] ${
                            c.done
                              ? 'bg-gradient-to-r from-rose-500/80 to-fuchsia-500/80 text-white shadow-[0_0_10px_rgba(244,63,94,0.6)] quest-glow'
                              : 'bg-zinc-800/80 text-zinc-400 border border-dashed border-zinc-700 hover:border-rose-500 hover:text-rose-300'
                          }`}
                        >
                          <span className="opacity-80">{c.done ? '✓' : subLabel}</span>
                          {isEditingSub ? null : (
                            <span className={`truncate ${c.done ? 'line-through opacity-80' : ''}`}>
                              {c.title}
                            </span>
                          )}
                          {renderBurst(c.id)}
                        </button>
                        {isEditingSub && (
                          <input
                            ref={editInputRef}
                            value={editValue}
                            onChange={e => setEditValue(e.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={e => {
                              if (e.key === 'Enter') commitEdit();
                              if (e.key === 'Escape') cancelEdit();
                            }}
                            className="absolute left-0 right-0 top-0 px-1.5 py-1 text-[9px] font-bold bg-zinc-900 border border-rose-500 rounded-md text-white focus:outline-none text-center"
                          />
                        )}
                        <button
                          onClick={() => handleRemoveSub(q.id, c.id)}
                          className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-zinc-700 hover:bg-red-500 text-white text-[8px] font-black opacity-0 group-hover/sub:opacity-100 transition-opacity flex items-center justify-center"
                          title="삭제"
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}

                  {addingChildFor === q.id ? (
                    <input
                      ref={childInputRef}
                      value={newChildTitle}
                      onChange={e => setNewChildTitle(e.target.value)}
                      onBlur={() => handleAddChild(q.id)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleAddChild(q.id);
                        if (e.key === 'Escape') {
                          setNewChildTitle('');
                          setAddingChildFor(null);
                        }
                      }}
                      placeholder="하위..."
                      className="w-20 px-1.5 py-0.5 text-[9px] font-bold bg-zinc-900 border border-rose-500 rounded text-white focus:outline-none text-center"
                    />
                  ) : (
                    <button
                      onClick={() => setAddingChildFor(q.id)}
                      className="text-[9px] font-black text-zinc-600 hover:text-rose-400 transition-colors border border-dashed border-zinc-800 hover:border-rose-500 rounded px-1.5 py-0.5"
                      title="하위 퀘스트 추가"
                    >
                      + SUB
                    </button>
                  )}
                </div>

                <button
                  onClick={() => handleRemoveQuest(q.id)}
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
