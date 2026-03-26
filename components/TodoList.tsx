import React, { useState } from 'react';
import { PlusIcon, TrashIcon } from './icons';
import { useTodos } from '../hooks/useFirestore';
import type { TodoItem, BusinessId } from '../types';

interface TodoListProps {
  businessId: BusinessId;
}

const TodoList: React.FC<TodoListProps> = ({ businessId }) => {
  const { todos, saveTodos, isLoading } = useTodos(businessId);
  const [newTodoText, setNewTodoText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [draggedId, setDraggedId] = useState<string | null>(null);

  const addTodo = () => {
    if (!newTodoText.trim()) return;

    const newTodo: TodoItem = {
      id: Date.now().toString(),
      text: newTodoText.trim(),
      completed: false,
      createdAt: Date.now(),
    };

    saveTodos([...todos, newTodo]);
    setNewTodoText('');
  };

  const toggleTodo = (id: string) => {
    const updatedTodos = todos.map(todo =>
      todo.id === id ? { ...todo, completed: !todo.completed } : todo
    );
    saveTodos(updatedTodos);
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

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      addTodo();
    }
  };

  const handleEditKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      saveEdit();
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  };

  // 드래그 앤 드롭 핸들러
  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, id: string) => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>, targetId: string) => {
    e.preventDefault();

    if (!draggedId || draggedId === targetId) {
      setDraggedId(null);
      return;
    }

    const draggedIndex = todos.findIndex(todo => todo.id === draggedId);
    const targetIndex = todos.findIndex(todo => todo.id === targetId);

    if (draggedIndex === -1 || targetIndex === -1) {
      setDraggedId(null);
      return;
    }

    const newTodos = [...todos];
    const [draggedItem] = newTodos.splice(draggedIndex, 1);
    newTodos.splice(targetIndex, 0, draggedItem);

    saveTodos(newTodos);
    setDraggedId(null);
  };

  const handleDragEnd = () => {
    setDraggedId(null);
  };

  return (
    <div className="bg-zinc-900 rounded-2xl border border-zinc-800 shadow-xl overflow-hidden h-fit sticky top-2">
      <div className="bg-gradient-to-r from-rose-500 to-rose-600 px-4 py-3">
        <h2 className="text-base font-black text-white">메모 & 할일</h2>
      </div>

      <div className="p-4">
        {/* 입력 영역 */}
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={newTodoText}
            onChange={(e) => setNewTodoText(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="할일 추가..."
            className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm placeholder-zinc-500 focus:outline-none focus:border-rose-500 transition-colors"
          />
          <button
            onClick={addTodo}
            disabled={!newTodoText.trim()}
            className="px-3 py-2 bg-rose-500 hover:bg-rose-600 disabled:bg-zinc-700 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
          >
            <PlusIcon className="w-5 h-5" />
          </button>
        </div>

        {/* 투두 리스트 */}
        <div className="space-y-1.5 max-h-[calc(100vh-200px)] overflow-y-auto pr-1">
          {todos.length === 0 ? (
            <p className="text-zinc-500 text-sm text-center py-8">할일이 없습니다</p>
          ) : (
            todos.map((todo) => (
              <div
                key={todo.id}
                draggable
                onDragStart={(e) => handleDragStart(e, todo.id)}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, todo.id)}
                onDragEnd={handleDragEnd}
                className={`flex items-start gap-2 p-2 bg-zinc-800 rounded-lg hover:bg-zinc-750 transition-colors group cursor-move ${
                  draggedId === todo.id ? 'opacity-50' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={todo.completed}
                  onChange={() => toggleTodo(todo.id)}
                  className="mt-0.5 w-4 h-4 rounded border-zinc-600 text-rose-500 focus:ring-rose-500 focus:ring-offset-0 cursor-pointer"
                />

                {editingId === todo.id ? (
                  <input
                    type="text"
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    onKeyDown={handleEditKeyPress}
                    onBlur={saveEdit}
                    autoFocus
                    className="flex-1 px-2 py-1 bg-zinc-700 border border-rose-500 rounded text-white text-sm focus:outline-none"
                  />
                ) : (
                  <span
                    onDoubleClick={() => startEdit(todo.id, todo.text)}
                    className={`flex-1 text-sm break-words cursor-text ${
                      todo.completed
                        ? 'line-through text-zinc-500'
                        : 'text-zinc-200'
                    }`}
                    title="더블클릭하여 수정"
                  >
                    {todo.text}
                  </span>
                )}

                <button
                  onClick={() => deleteTodo(todo.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 hover:bg-zinc-700 rounded transition-all"
                >
                  <TrashIcon className="w-4 h-4 text-zinc-400 hover:text-rose-500" />
                </button>
              </div>
            ))
          )}
        </div>

        {/* 통계 */}
        {todos.length > 0 && (
          <div className="mt-4 pt-4 border-t border-zinc-800 text-xs text-zinc-500 font-bold">
            완료: {todos.filter(t => t.completed).length} / 전체: {todos.length}
          </div>
        )}
      </div>
    </div>
  );
};

export default TodoList;
