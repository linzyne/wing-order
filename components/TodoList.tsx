import React, { useState } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { PlusIcon, TrashIcon } from './icons';
import { useTodos } from '../hooks/useFirestore';
import type { TodoItem, BusinessId, DayOfWeek } from '../types';
import { DAYS_OF_WEEK } from '../types';

// 요일별 색상 매핑 (인라인 스타일 - Tailwind purge 무관)
const DAY_COLORS: Record<string, { color: string; bg: string; border: string }> = {
  '월': { color: '#fb7185', bg: 'rgba(244,63,94,0.2)',  border: 'rgba(244,63,94,0.4)' },   // 로즈
  '화': { color: '#fb923c', bg: 'rgba(249,115,22,0.2)', border: 'rgba(249,115,22,0.4)' },  // 오렌지
  '수': { color: '#fbbf24', bg: 'rgba(245,158,11,0.2)', border: 'rgba(245,158,11,0.4)' },  // 앰버(노랑)
  '목': { color: '#34d399', bg: 'rgba(16,185,129,0.2)', border: 'rgba(16,185,129,0.4)' },  // 에메랄드
  '금': { color: '#60a5fa', bg: 'rgba(59,130,246,0.2)', border: 'rgba(59,130,246,0.4)' },  // 블루
  '토': { color: '#a78bfa', bg: 'rgba(139,92,246,0.2)', border: 'rgba(139,92,246,0.4)' },  // 바이올렛
  '일': { color: '#f87171', bg: 'rgba(239,68,68,0.2)',  border: 'rgba(239,68,68,0.4)' },   // 레드
};

// 요일 그룹별 정렬: 요일없음 → 월→일 → 완료
const sortByDayGroup = (todoList: TodoItem[]): TodoItem[] => {
  const incomplete = todoList.filter(t => !t.completed);
  const completed = todoList.filter(t => t.completed);
  const noDay = incomplete.filter(t => !t.day);
  const byDay: Record<string, TodoItem[]> = {};
  for (const day of DAYS_OF_WEEK) {
    byDay[day] = incomplete.filter(t => t.day === day);
  }
  return [...noDay, ...DAYS_OF_WEEK.flatMap(day => byDay[day]), ...completed];
};

const getDayInlineStyle = (day?: string): React.CSSProperties => {
  if (!day || !DAY_COLORS[day]) return {};
  const c = DAY_COLORS[day];
  return { color: c.color, backgroundColor: c.bg, borderColor: c.border };
};

interface TodoListProps {
  businessId: BusinessId;
}

// 드래그 가능한 개별 투두 아이템 컴포넌트
const SortableTodoItem: React.FC<{
  todo: TodoItem;
  editingId: string | null;
  editingText: string;
  setEditingText: (text: string) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onStartEdit: (id: string, text: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDayChange: (id: string, day: DayOfWeek | undefined) => void;
}> = ({ todo, editingId, editingText, setEditingText, onToggle, onDelete, onStartEdit, onSaveEdit, onCancelEdit, onDayChange }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: todo.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const handleEditKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      onSaveEdit();
    } else if (e.key === 'Escape') {
      onCancelEdit();
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-start gap-2 p-2 rounded-lg transition-all duration-300 group ${
        todo.completed
          ? 'bg-emerald-900/20 border border-emerald-800/30'
          : 'bg-zinc-800 hover:bg-zinc-750'
      }`}
    >
      {/* 드래그 핸들 */}
      <button
        {...attributes}
        {...listeners}
        className="mt-0.5 cursor-grab active:cursor-grabbing text-zinc-600 hover:text-zinc-400 touch-none"
        tabIndex={-1}
      >
        <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="5" cy="3" r="1.5" />
          <circle cx="11" cy="3" r="1.5" />
          <circle cx="5" cy="8" r="1.5" />
          <circle cx="11" cy="8" r="1.5" />
          <circle cx="5" cy="13" r="1.5" />
          <circle cx="11" cy="13" r="1.5" />
        </svg>
      </button>

      <input
        type="checkbox"
        checked={todo.completed}
        onChange={() => onToggle(todo.id)}
        className={`mt-0.5 w-4 h-4 rounded border-zinc-600 focus:ring-offset-0 cursor-pointer ${
          todo.completed
            ? 'text-emerald-500 focus:ring-emerald-500'
            : 'text-rose-500 focus:ring-rose-500'
        }`}
      />

      {editingId === todo.id ? (
        <input
          type="text"
          value={editingText}
          onChange={(e) => setEditingText(e.target.value)}
          onKeyDown={handleEditKeyPress}
          onBlur={onSaveEdit}
          autoFocus
          className="flex-1 px-2 py-1 bg-zinc-700 border border-rose-500 rounded text-white text-sm focus:outline-none"
        />
      ) : (
        <span
          onDoubleClick={() => onStartEdit(todo.id, todo.text)}
          className={`flex-1 text-sm break-words cursor-text transition-colors duration-300 ${
            todo.completed
              ? 'text-emerald-400 font-semibold'
              : 'text-zinc-200'
          }`}
          title="더블클릭하여 수정"
        >
          {todo.completed && '✓ '}{todo.text}
        </span>
      )}

      <select
        value={todo.day || ''}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onDayChange(todo.id, (e.target.value || undefined) as DayOfWeek | undefined)}
        className="w-10 px-0 py-0.5 text-center text-xs rounded border cursor-pointer focus:outline-none focus:border-rose-500 appearance-none font-bold bg-zinc-800 border-zinc-700 text-zinc-500"
        style={getDayInlineStyle(todo.day)}
      >
        <option value="">-</option>
        {DAYS_OF_WEEK.map(day => (
          <option key={day} value={day}>{day}</option>
        ))}
      </select>

      <button
        onClick={() => onDelete(todo.id)}
        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-zinc-700 rounded transition-all"
      >
        <TrashIcon className="w-4 h-4 text-zinc-400 hover:text-rose-500" />
      </button>
    </div>
  );
};

const TodoList: React.FC<TodoListProps> = ({ businessId }) => {
  const { todos, saveTodos, isLoading } = useTodos(businessId);
  const [newTodoText, setNewTodoText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [newTodoDay, setNewTodoDay] = useState<DayOfWeek | undefined>(undefined);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const addTodo = () => {
    if (!newTodoText.trim()) return;

    const newTodo: TodoItem = {
      id: Date.now().toString(),
      text: newTodoText.trim(),
      completed: false,
      createdAt: Date.now(),
      day: newTodoDay,
    };

    // 새 메모를 맨 앞에 추가, 요일 선택 시 해당 요일 그룹으로 자동 정렬
    const newList = [newTodo, ...todos];
    saveTodos(newTodoDay ? sortByDayGroup(newList) : newList);
    setNewTodoText('');
    setNewTodoDay(undefined);
  };

  const toggleTodo = (id: string) => {
    const updatedTodos = todos.map(todo =>
      todo.id === id ? { ...todo, completed: !todo.completed } : todo
    );
    saveTodos(sortByDayGroup(updatedTodos));
  };

  const deleteTodo = (id: string) => {
    saveTodos(todos.filter(todo => todo.id !== id));
  };

  const startEdit = (id: string, text: string) => {
    setEditingId(id);
    setEditingText(text);
  };

  const saveEdit = () => {
    if (!editingId || !editingText.trim()) {
      setEditingId(null);
      return;
    }

    const updatedTodos = todos.map(todo =>
      todo.id === editingId ? { ...todo, text: editingText.trim() } : todo
    );
    saveTodos(updatedTodos);
    setEditingId(null);
    setEditingText('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingText('');
  };

  const changeTodoDay = (id: string, day: DayOfWeek | undefined) => {
    const updatedTodos = todos.map(todo =>
      todo.id === id ? { ...todo, day } : todo
    );
    // 요일 변경 시 해당 요일 그룹 위치로 자동 이동
    saveTodos(sortByDayGroup(updatedTodos));
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      addTodo();
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = todos.findIndex(t => t.id === active.id);
    const newIndex = todos.findIndex(t => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    saveTodos(arrayMove(todos, oldIndex, newIndex));
  };

  return (
    <div className="glass rounded-2xl shadow-xl overflow-hidden h-fit sticky top-2">
      <div className="bg-zinc-800/80 border-b border-zinc-700/50 px-4 py-2.5">
        <h2 className="text-[13px] font-black text-white tracking-wide">메모 & 할일</h2>
      </div>

      <div className="p-4">
        {/* 입력 영역 */}
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={newTodoText}
            onChange={(e) => setNewTodoText(e.target.value)}
            onKeyDown={handleKeyPress}
            placeholder="할일 추가..."
            className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
          />
          <select
            value={newTodoDay || ''}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setNewTodoDay((e.target.value || undefined) as DayOfWeek | undefined)}
            className="w-14 px-1 py-2 text-center text-sm rounded-lg border cursor-pointer focus:outline-none focus:border-zinc-500 appearance-none font-bold bg-zinc-800 border-zinc-700 text-zinc-500"
            style={getDayInlineStyle(newTodoDay)}
          >
            <option value="">요일</option>
            {DAYS_OF_WEEK.map(day => (
              <option key={day} value={day}>{day}</option>
            ))}
          </select>
          <button
            onClick={addTodo}
            disabled={!newTodoText.trim()}
            className="px-3 py-2 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed rounded-lg transition-colors"
          >
            <PlusIcon className="w-5 h-5" />
          </button>
        </div>

        {/* 투두 리스트 */}
        <div className="space-y-1.5 max-h-[calc(100vh-200px)] overflow-y-auto pr-1">
          {todos.length === 0 ? (
            <p className="text-zinc-500 text-sm text-center py-8">할일이 없습니다</p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={todos.map(t => t.id)}
                strategy={verticalListSortingStrategy}
              >
                {todos.map((todo) => (
                  <SortableTodoItem
                    key={todo.id}
                    todo={todo}
                    editingId={editingId}
                    editingText={editingText}
                    setEditingText={setEditingText}
                    onToggle={toggleTodo}
                    onDelete={deleteTodo}
                    onStartEdit={startEdit}
                    onSaveEdit={saveEdit}
                    onCancelEdit={cancelEdit}
                    onDayChange={changeTodoDay}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>

        {/* 통계 */}
        {todos.length > 0 && (
          <div className="mt-4 pt-4 border-t border-zinc-800 text-xs font-bold flex items-center gap-1">
            <span className="text-emerald-400">✓ {todos.filter(t => t.completed).length}</span>
            <span className="text-zinc-600">/</span>
            <span className="text-zinc-500">{todos.length}</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default TodoList;
