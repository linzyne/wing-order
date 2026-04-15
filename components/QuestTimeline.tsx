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
const MEMO_STORAGE_KEY = 'quest-memos-v1';

interface Memo {
  id: string;
  title: string;
}

const loadMemos = (): Memo[] => {
  try {
    const raw = localStorage.getItem(MEMO_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((m: any) => ({ id: String(m.id), title: String(m.title ?? '') }));
  } catch {}
  return [];
};

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
  const [insertingAt, setInsertingAt] = useState<number | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [addingChildFor, setAddingChildFor] = useState<string | null>(null);
  const [newChildTitle, setNewChildTitle] = useState('');
  const [editing, setEditing] = useState<{ kind: 'quest' | 'sub'; id: string; parentId?: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [burstId, setBurstId] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const [memos, setMemos] = useState<Memo[]>(loadMemos);
  const [addingMemo, setAddingMemo] = useState(false);
  const [newMemoTitle, setNewMemoTitle] = useState('');
  const [editingMemoId, setEditingMemoId] = useState<string | null>(null);
  const [editMemoValue, setEditMemoValue] = useState('');
  const memoInputRef = useRef<HTMLInputElement>(null);
  const memoEditInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try { localStorage.setItem(MEMO_STORAGE_KEY, JSON.stringify(memos)); } catch {}
  }, [memos]);
  useEffect(() => { if (addingMemo) memoInputRef.current?.focus(); }, [addingMemo]);
  useEffect(() => {
    if (editingMemoId) {
      memoEditInputRef.current?.focus();
      memoEditInputRef.current?.select();
    }
  }, [editingMemoId]);

  const handleAddMemo = () => {
    const title = newMemoTitle.trim();
    if (!title) { setAddingMemo(false); return; }
    setMemos(prev => [...prev, { id: uid(), title }]);
    setNewMemoTitle('');
    setAddingMemo(false);
  };
  const handleRemoveMemo = (id: string) => {
    setMemos(prev => prev.filter(m => m.id !== id));
  };
  const startEditMemo = (m: Memo) => {
    setEditingMemoId(m.id);
    setEditMemoValue(m.title);
  };
  const commitMemoEdit = () => {
    if (!editingMemoId) return;
    const value = editMemoValue.trim();
    if (!value) { setEditingMemoId(null); return; }
    setMemos(prev => prev.map(m => (m.id === editingMemoId ? { ...m, title: value } : m)));
    setEditingMemoId(null);
  };
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
    if (adding || insertingAt !== null) inputRef.current?.focus();
  }, [adding, insertingAt]);
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
    persist(prev => {
      const next = [...prev, { id: uid(), label: '', title, done: false, children: [] }];
      return next.map((q, i) => ({ ...q, label: nextLetter(i) }));
    });
    setNewTitle('');
    setAdding(false);
  };

  const handleInsertAt = (index: number) => {
    const title = newTitle.trim();
    if (!title) {
      setInsertingAt(null);
      return;
    }
    persist(prev => {
      const next = [...prev];
      next.splice(index, 0, { id: uid(), label: '', title, done: false, children: [] });
      return next.map((q, i) => ({ ...q, label: nextLetter(i) }));
    });
    setNewTitle('');
    setInsertingAt(null);
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
        <span className="absolute inset-0 rounded-lg quest-flash pointer-events-none" />
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
      <div className="absolute inset-[2px] rounded-2xl quest-grid-bg pointer-events-none opacity-20" />
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
            onClick={() => { setInsertingAt(null); setNewTitle(''); setAdding(true); }}
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
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-rose-500 via-fuchsia-500 to-amber-400 transition-all duration-700 ease-out overflow-hidden"
          style={{ width: `${progress}%` }}
        >
          <div className="absolute inset-0 quest-shine" />
        </div>
        {progress > 0 && (
          <div
            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow-[0_0_12px_rgba(244,63,94,0.9)] transition-all duration-700"
            style={{ left: `calc(${progress}% - 6px)` }}
          />
        )}
      </div>

      {/* Quest nodes */}
      <div className="relative flex items-start flex-wrap gap-x-1 gap-y-3 pb-1">
        {quests.length === 0 && !adding && (
          <div className="w-full text-center py-6 text-zinc-600 font-bold text-xs tracking-widest uppercase">
            ▸ No Active Quests — Press <span className="text-rose-400">+ ADD QUEST</span> to begin
          </div>
        )}
        {quests.map((q, idx) => {
          const isEditingThis = editing?.kind === 'quest' && editing.id === q.id;
          const isInsertingHere = insertingAt === idx;
          return (
            <React.Fragment key={q.id}>
              {/* Insert zone before this item */}
              {isInsertingHere ? (
                <div className="flex-shrink-0 flex flex-col items-center gap-2 pt-0.5" style={{ minWidth: 100 }}>
                  <div className="h-10 min-w-[44px] px-3.5 rounded-lg bg-zinc-800 border border-rose-500 flex items-center justify-center font-black text-rose-400 text-base animate-pulse">
                    {nextLetter(idx)}
                  </div>
                  <input
                    ref={inputRef}
                    value={newTitle}
                    onChange={e => setNewTitle(e.target.value)}
                    onBlur={() => handleInsertAt(idx)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleInsertAt(idx);
                      if (e.key === 'Escape') {
                        setNewTitle('');
                        setInsertingAt(null);
                      }
                    }}
                    placeholder="할일..."
                    className="w-28 px-2 py-1.5 text-sm font-bold bg-zinc-800 border border-rose-500 rounded-md text-white focus:outline-none focus:ring-1 focus:ring-rose-400 text-center"
                  />
                </div>
              ) : (
                idx > 0 && (
                  <button
                    onClick={() => {
                      setNewTitle('');
                      setInsertingAt(idx);
                      setAdding(false);
                    }}
                    className="flex-shrink-0 self-start pt-4 px-0.5 group/ins"
                    title="여기에 추가"
                  >
                    <span className="block w-4 h-[3px] rounded-full bg-zinc-800 group-hover/ins:bg-rose-500 group-hover/ins:shadow-[0_0_8px_rgba(244,63,94,0.7)] transition-all relative">
                      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] font-black text-zinc-700 group-hover/ins:text-rose-400 transition-colors">+</span>
                    </span>
                  </button>
                )
              )}
              <div
                className="flex-shrink-0 flex flex-col items-center gap-2 group relative"
                style={{ minWidth: 100, maxWidth: 160 }}
              >
                <button
                  onClick={() => handleToggleQuest(q.id)}
                  onDoubleClick={e => {
                    e.stopPropagation();
                    startEditQuest(q);
                  }}
                  title="클릭: 완료 · 더블클릭: 수정"
                  className={`relative h-10 min-w-[44px] px-3.5 rounded-lg flex items-center justify-center font-black text-base transition-all duration-300 ${
                    q.done
                      ? 'bg-gradient-to-br from-rose-400 via-fuchsia-500 to-amber-400 text-white shadow-[0_0_20px_rgba(244,63,94,0.8)] scale-105 quest-glow'
                      : 'bg-zinc-800/90 text-zinc-400 border border-zinc-700 hover:border-rose-500 hover:text-rose-300 quest-idle'
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
                    className="w-40 px-2 py-1 text-sm font-bold bg-zinc-800 border border-rose-500 rounded-md text-white focus:outline-none focus:ring-1 focus:ring-rose-400 text-center"
                  />
                ) : (
                  <div
                    onDoubleClick={() => startEditQuest(q)}
                    className={`text-sm font-black text-center leading-snug cursor-text px-1 break-words ${
                      q.done ? 'text-rose-300 line-through opacity-70' : 'text-zinc-200'
                    }`}
                    title={`${q.title} (더블클릭 수정)`}
                  >
                    {q.label}. {q.title}
                  </div>
                )}

                {/* Sub-quests */}
                <div className="flex flex-col gap-1.5 mt-0.5 w-full items-stretch">
                  {q.children.map((c, cIdx) => {
                    const subLabel = `${q.label}-${cIdx + 1}`;
                    const isEditingSub = editing?.kind === 'sub' && editing.id === c.id;
                    if (isEditingSub) {
                      return (
                        <input
                          key={c.id}
                          ref={editInputRef}
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={e => {
                            if (e.key === 'Enter') commitEdit();
                            if (e.key === 'Escape') cancelEdit();
                          }}
                          className="w-full px-2 py-1.5 text-xs font-bold bg-zinc-900 border border-rose-500 rounded-md text-white focus:outline-none focus:ring-1 focus:ring-rose-400 text-center"
                        />
                      );
                    }
                    return (
                      <div key={c.id} className="relative group/sub w-full flex">
                        <button
                          onClick={() => handleToggleSub(q.id, c.id)}
                          onDoubleClick={e => {
                            e.stopPropagation();
                            startEditSub(q.id, c);
                          }}
                          title="클릭: 완료 · 더블클릭: 수정"
                          className={`relative flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-black transition-all w-full ${
                            c.done
                              ? 'bg-gradient-to-r from-rose-500/80 to-fuchsia-500/80 text-white shadow-[0_0_10px_rgba(244,63,94,0.6)] quest-glow'
                              : 'bg-zinc-800/80 text-zinc-300 border border-zinc-700 hover:border-rose-500 hover:text-rose-300'
                          }`}
                        >
                          <span className="opacity-80 flex-shrink-0">{c.done ? '✓' : subLabel}</span>
                          <span className={`truncate flex-1 text-left ${c.done ? 'line-through opacity-80' : ''}`}>
                            {c.title}
                          </span>
                          {renderBurst(c.id)}
                        </button>
                        <button
                          onClick={() => handleRemoveSub(q.id, c.id)}
                          className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-zinc-700 hover:bg-red-500 text-white text-[9px] font-black opacity-0 group-hover/sub:opacity-100 transition-opacity flex items-center justify-center z-10"
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
                      placeholder="하위 할일..."
                      className="w-full px-2 py-1.5 text-xs font-bold bg-zinc-900 border border-rose-500 rounded-md text-white focus:outline-none focus:ring-1 focus:ring-rose-400 text-center"
                    />
                  ) : (
                    <button
                      onClick={() => setAddingChildFor(q.id)}
                      className="text-[11px] font-black text-zinc-500 hover:text-rose-400 transition-colors border border-dashed border-zinc-800 hover:border-rose-500 rounded-md px-2 py-1"
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
          <div className="flex-shrink-0 flex flex-col items-center gap-2 ml-1" style={{ minWidth: 100 }}>
            <div className="h-10 min-w-[44px] px-3.5 rounded-lg bg-zinc-800 border border-rose-500 flex items-center justify-center font-black text-rose-400 text-base animate-pulse">
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
              className="w-40 px-2 py-1.5 text-sm font-bold bg-zinc-800 border border-rose-500 rounded-md text-white focus:outline-none focus:ring-1 focus:ring-rose-400 text-center"
            />
          </div>
        )}
      </div>

      {/* Memo row — 메모 전용, 작은 사이즈, 사이안 컬러 */}
      <div className="relative mt-3 pt-3 border-t border-zinc-800/60 flex items-center flex-wrap gap-1.5">
        <span className="text-[9px] font-black text-cyan-500/80 tracking-widest uppercase mr-1">Memo</span>
        {memos.map(m => {
          const isEditingThis = editingMemoId === m.id;
          if (isEditingThis) {
            return (
              <input
                key={m.id}
                ref={memoEditInputRef}
                value={editMemoValue}
                onChange={e => setEditMemoValue(e.target.value)}
                onBlur={commitMemoEdit}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitMemoEdit();
                  if (e.key === 'Escape') setEditingMemoId(null);
                }}
                className="h-5 px-1.5 text-[10px] font-bold bg-zinc-900 border border-cyan-500 rounded text-white focus:outline-none focus:ring-1 focus:ring-cyan-400 text-center"
                style={{ width: Math.max(40, editMemoValue.length * 7 + 16) }}
              />
            );
          }
          return (
            <div key={m.id} className="relative group/memo">
              <button
                onDoubleClick={() => startEditMemo(m)}
                title="더블클릭 수정"
                className="h-5 px-1.5 rounded bg-cyan-950/60 border border-cyan-800/60 hover:border-cyan-500 text-cyan-200 hover:text-cyan-100 text-[10px] font-black transition-all"
              >
                {m.title}
              </button>
              <button
                onClick={() => handleRemoveMemo(m.id)}
                className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-zinc-700 hover:bg-red-500 text-white text-[8px] font-black opacity-0 group-hover/memo:opacity-100 transition-opacity flex items-center justify-center"
                title="삭제"
              >
                ×
              </button>
            </div>
          );
        })}
        {addingMemo ? (
          <input
            ref={memoInputRef}
            value={newMemoTitle}
            onChange={e => setNewMemoTitle(e.target.value)}
            onBlur={handleAddMemo}
            onKeyDown={e => {
              if (e.key === 'Enter') handleAddMemo();
              if (e.key === 'Escape') { setNewMemoTitle(''); setAddingMemo(false); }
            }}
            placeholder="메모..."
            className="h-5 w-24 px-1.5 text-[10px] font-bold bg-zinc-900 border border-cyan-500 rounded text-white focus:outline-none focus:ring-1 focus:ring-cyan-400 text-center"
          />
        ) : (
          <button
            onClick={() => { setNewMemoTitle(''); setAddingMemo(true); }}
            className="h-5 px-1.5 rounded border border-dashed border-cyan-800/60 hover:border-cyan-500 text-cyan-600 hover:text-cyan-300 text-[10px] font-black transition-all"
            title="메모 추가"
          >
            +
          </button>
        )}
      </div>
    </div>
  );
};

export default QuestTimeline;
