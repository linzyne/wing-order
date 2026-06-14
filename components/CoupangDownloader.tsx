import React, { useState, useEffect } from 'react';
import {
  loadWingCredentials, saveWingCredentials, deleteWingCredentials,
  loadDownloadMethod, saveDownloadMethod,
  type WingCredentials, type DownloadMethod,
} from '../services/coupangCredentials';
import {
  loadCoupangApiKeys, saveCoupangApiKeys, deleteCoupangApiKeys, downloadOrdersAsExcel,
  type CoupangApiKeys,
} from '../services/coupangApi';
import { Cog6ToothIcon, ArrowDownTrayIcon, ChevronDownIcon, XMarkIcon, EyeIcon, EyeSlashIcon } from './icons';

interface Business { id: string; displayName: string; }
interface CoupangDownloaderProps { businesses: Business[]; }
type OrderStatus = 'INSTRUCT' | 'ACCEPT';
interface DownloadState { loading: boolean; error: string | null; lastCount?: number; }

const EMPTY_CREDS: WingCredentials = { id: '', password: '' };
const EMPTY_KEYS: CoupangApiKeys = { accessKey: '', secretKey: '', vendorId: '' };

const CoupangDownloader: React.FC<CoupangDownloaderProps> = ({ businesses }) => {
  const [isExpanded, setIsExpanded] = useState(() => localStorage.getItem('coupang_dl_expanded') !== 'false');
  const [selectedStatus, setSelectedStatus] = useState<Record<string, OrderStatus>>({});
  const [downloadStates, setDownloadStates] = useState<Record<string, DownloadState>>({});

  const [methods, setMethods] = useState<Record<string, DownloadMethod>>({});
  const [apiKeys, setApiKeys] = useState<Record<string, CoupangApiKeys | null>>({});
  const [credentials, setCredentials] = useState<Record<string, WingCredentials | null>>({});

  // 모달
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMethod, setEditMethod] = useState<DownloadMethod>('browser');
  const [editCreds, setEditCreds] = useState<WingCredentials>(EMPTY_CREDS);
  const [editKeys, setEditKeys] = useState<CoupangApiKeys>(EMPTY_KEYS);
  const [showPassword, setShowPassword] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  useEffect(() => {
    const m: Record<string, DownloadMethod> = {};
    const ak: Record<string, CoupangApiKeys | null> = {};
    const cr: Record<string, WingCredentials | null> = {};
    for (const b of businesses) {
      m[b.id] = loadDownloadMethod(b.id);
      ak[b.id] = loadCoupangApiKeys(b.id);
      cr[b.id] = loadWingCredentials(b.id);
    }
    setMethods(m);
    setApiKeys(ak);
    setCredentials(cr);
  }, [businesses]);

  const getStatus = (id: string): OrderStatus => selectedStatus[id] ?? 'INSTRUCT';
  const getMethod = (id: string): DownloadMethod => methods[id] ?? 'browser';

  const isConfigured = (id: string) => {
    const m = getMethod(id);
    if (m === 'api') return !!apiKeys[id]?.accessKey;
    return !!credentials[id]?.id;
  };

  // ── API 다운로드 ──
  const handleApiDownload = async (business: Business) => {
    const keys = apiKeys[business.id];
    if (!keys) return;
    setDownloadStates(prev => ({ ...prev, [business.id]: { loading: true, error: null } }));
    try {
      const count = await downloadOrdersAsExcel(keys, getStatus(business.id), business.displayName);
      setDownloadStates(prev => ({ ...prev, [business.id]: { loading: false, error: null, lastCount: count } }));
    } catch (e: any) {
      setDownloadStates(prev => ({ ...prev, [business.id]: { loading: false, error: e.message ?? '오류' } }));
    }
  };

  // ── 브라우저 자동화 다운로드 ──
  const handleBrowserDownload = async (business: Business) => {
    const creds = credentials[business.id];
    if (!creds) return;
    setDownloadStates(prev => ({ ...prev, [business.id]: { loading: true, error: null } }));
    try {
      const res = await fetch('/api/wing-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: creds.id, password: creds.password, status: getStatus(business.id), businessName: business.displayName }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: '서버 오류' }));
        throw new Error(err.error ?? '다운로드 실패');
      }
      const blob = await res.blob();
      const match = (res.headers.get('Content-Disposition') ?? '').match(/filename\*=UTF-8''(.+)/);
      const fileName = match ? decodeURIComponent(match[1]) : `orders-${business.id}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fileName; a.click();
      URL.revokeObjectURL(url);
      setDownloadStates(prev => ({ ...prev, [business.id]: { loading: false, error: null } }));
    } catch (e: any) {
      setDownloadStates(prev => ({ ...prev, [business.id]: { loading: false, error: e.message ?? '오류' } }));
    }
  };

  const handleDownload = (business: Business) => {
    if (getMethod(business.id) === 'api') handleApiDownload(business);
    else handleBrowserDownload(business);
  };

  const openEdit = (id: string) => {
    const m = getMethod(id);
    setEditMethod(m);
    setEditCreds(credentials[id] ?? EMPTY_CREDS);
    setEditKeys(apiKeys[id] ?? EMPTY_KEYS);
    setShowPassword(false);
    setShowSecret(false);
    setEditingId(id);
  };

  const saveEdit = () => {
    if (!editingId) return;
    saveDownloadMethod(editingId, editMethod);
    setMethods(prev => ({ ...prev, [editingId]: editMethod }));

    if (editMethod === 'api') {
      if (editKeys.accessKey && editKeys.secretKey && editKeys.vendorId) {
        saveCoupangApiKeys(editingId, editKeys);
        setApiKeys(prev => ({ ...prev, [editingId]: editKeys }));
      } else {
        deleteCoupangApiKeys(editingId);
        setApiKeys(prev => ({ ...prev, [editingId]: null }));
      }
    } else {
      if (editCreds.id && editCreds.password) {
        saveWingCredentials(editingId, editCreds);
        setCredentials(prev => ({ ...prev, [editingId]: editCreds }));
      } else {
        deleteWingCredentials(editingId);
        setCredentials(prev => ({ ...prev, [editingId]: null }));
      }
    }
    setEditingId(null);
  };

  const clearEdit = () => {
    if (!editingId) return;
    deleteCoupangApiKeys(editingId);
    deleteWingCredentials(editingId);
    setApiKeys(prev => ({ ...prev, [editingId]: null }));
    setCredentials(prev => ({ ...prev, [editingId]: null }));
    setEditingId(null);
  };

  const editingBusiness = businesses.find(b => b.id === editingId);

  return (
    <>
      <div className="mb-4 rounded-xl border border-zinc-700/40 bg-zinc-900/60 overflow-hidden">
        <button
          onClick={() => setIsExpanded(v => { localStorage.setItem('coupang_dl_expanded', String(!v)); return !v; })}
          className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-zinc-800/40 transition-colors"
        >
          <div className="flex items-center gap-2">
            <ArrowDownTrayIcon className="w-3.5 h-3.5 text-sky-400" />
            <span className="text-[11px] font-black text-zinc-300 uppercase tracking-widest">쿠팡 주문서 다운로드</span>
          </div>
          <ChevronDownIcon className={`w-3.5 h-3.5 text-zinc-500 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
        </button>

        {isExpanded && (
          <div className="px-3 pb-3 flex flex-col gap-1.5">
            {businesses.map(b => {
              const state = downloadStates[b.id];
              const status = getStatus(b.id);
              const method = getMethod(b.id);
              const configured = isConfigured(b.id);

              return (
                <div key={b.id} className="flex items-center gap-2 py-1.5 px-2 rounded-lg bg-zinc-800/50 hover:bg-zinc-800/80 transition-colors">
                  <span className="text-[11px] font-black text-zinc-300 w-16 shrink-0 truncate">{b.displayName}</span>

                  {/* 방식 배지 */}
                  <span className={`text-[9px] font-black px-1.5 py-0.5 rounded shrink-0 ${
                    method === 'api' ? 'bg-violet-900/50 text-violet-400' : 'bg-sky-900/50 text-sky-400'
                  }`}>
                    {method === 'api' ? 'API' : '브라우저'}
                  </span>

                  {/* 상태 토글 */}
                  <div className="flex items-center p-0.5 bg-zinc-900/60 rounded-lg gap-0.5 shrink-0">
                    {(['INSTRUCT', 'ACCEPT'] as OrderStatus[]).map(s => (
                      <button
                        key={s}
                        onClick={() => setSelectedStatus(prev => ({ ...prev, [b.id]: s }))}
                        className={`px-2 py-0.5 text-[10px] font-black rounded-md transition-all ${
                          status === s ? 'bg-sky-700 text-white shadow' : 'text-zinc-500 hover:text-zinc-300'
                        }`}
                      >
                        {s === 'INSTRUCT' ? '상품준비중' : '결제완료'}
                      </button>
                    ))}
                  </div>

                  {/* 다운로드 버튼 */}
                  <button
                    onClick={() => handleDownload(b)}
                    disabled={!configured || state?.loading}
                    className={`flex items-center gap-1 px-2.5 py-1 text-[10px] font-black rounded-lg transition-all shrink-0 ${
                      !configured ? 'bg-zinc-700/40 text-zinc-600 cursor-not-allowed'
                        : state?.loading ? 'bg-sky-900 text-zinc-400 cursor-wait'
                        : 'bg-sky-700 hover:bg-sky-600 text-white shadow'
                    }`}
                  >
                    {state?.loading
                      ? <span className="w-3 h-3 border-2 border-zinc-400 border-t-transparent rounded-full animate-spin inline-block" />
                      : <ArrowDownTrayIcon className="w-3 h-3" />}
                    {state?.loading ? (method === 'browser' ? '자동화 중...' : '가져오는 중...') : '다운로드'}
                  </button>

                  {/* 상태 메시지 */}
                  <div className="flex-1 min-w-0 text-[9px] font-bold truncate">
                    {state?.error && <span className="text-red-400" title={state.error}>{state.error}</span>}
                    {!state?.error && state?.lastCount != null && <span className="text-emerald-400">{state.lastCount}건</span>}
                    {!state?.error && state?.loading && method === 'browser' && <span className="text-sky-500">브라우저가 열립니다...</span>}
                    {!configured && !state?.loading && <span className="text-zinc-600">미설정</span>}
                  </div>

                  {/* 설정 버튼 */}
                  <button
                    onClick={() => openEdit(b.id)}
                    className="p-1 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors shrink-0"
                  >
                    <Cog6ToothIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 설정 모달 */}
      {editingId && editingBusiness && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setEditingId(null)}>
          <div className="bg-zinc-900 border border-zinc-700/60 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-black text-white">{editingBusiness.displayName} — 다운로드 설정</h3>
              <button onClick={() => setEditingId(null)} className="text-zinc-500 hover:text-zinc-300"><XMarkIcon className="w-4 h-4" /></button>
            </div>

            {/* 방식 선택 */}
            <div className="flex p-1 bg-zinc-800 rounded-xl gap-1 mb-4">
              {(['browser', 'api'] as DownloadMethod[]).map(m => (
                <button
                  key={m}
                  onClick={() => setEditMethod(m)}
                  className={`flex-1 py-1.5 text-[11px] font-black rounded-lg transition-all ${
                    editMethod === m ? 'bg-zinc-600 text-white shadow' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {m === 'browser' ? '브라우저 자동화' : 'Open API'}
                </button>
              ))}
            </div>

            {editMethod === 'browser' ? (
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">Wing 아이디</span>
                  <input
                    type="text" value={editCreds.id}
                    onChange={e => setEditCreds(f => ({ ...f, id: e.target.value }))}
                    placeholder="쿠팡 Wing 로그인 아이디"
                    className="bg-zinc-800 border border-zinc-700/60 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder-zinc-600 outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">비밀번호</span>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'} value={editCreds.password}
                      onChange={e => setEditCreds(f => ({ ...f, password: e.target.value }))}
                      placeholder="비밀번호"
                      className="w-full bg-zinc-800 border border-zinc-700/60 rounded-lg px-3 py-2 pr-9 text-xs text-zinc-200 placeholder-zinc-600 outline-none"
                    />
                    <button type="button" onClick={() => setShowPassword(v => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400">
                      {showPassword ? <EyeSlashIcon className="w-3.5 h-3.5" /> : <EyeIcon className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  <span className="text-[9px] text-zinc-700">이 기기 로컬에만 저장됩니다.</span>
                </label>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">Access Key</span>
                  <input
                    type="text" value={editKeys.accessKey}
                    onChange={e => setEditKeys(f => ({ ...f, accessKey: e.target.value }))}
                    placeholder="Access Key"
                    className="bg-zinc-800 border border-zinc-700/60 rounded-lg px-3 py-2 text-xs text-zinc-200 font-mono placeholder-zinc-700 outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">Secret Key</span>
                  <div className="relative">
                    <input
                      type={showSecret ? 'text' : 'password'} value={editKeys.secretKey}
                      onChange={e => setEditKeys(f => ({ ...f, secretKey: e.target.value }))}
                      placeholder="Secret Key"
                      className="w-full bg-zinc-800 border border-zinc-700/60 rounded-lg px-3 py-2 pr-9 text-xs text-zinc-200 font-mono placeholder-zinc-700 outline-none"
                    />
                    <button type="button" onClick={() => setShowSecret(v => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400">
                      {showSecret ? <EyeSlashIcon className="w-3.5 h-3.5" /> : <EyeIcon className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">공급업체 ID (Vendor ID)</span>
                  <input
                    type="text" value={editKeys.vendorId}
                    onChange={e => setEditKeys(f => ({ ...f, vendorId: e.target.value }))}
                    placeholder="예) A0000001"
                    className="bg-zinc-800 border border-zinc-700/60 rounded-lg px-3 py-2 text-xs text-zinc-200 font-mono placeholder-zinc-700 outline-none"
                  />
                  <span className="text-[9px] text-zinc-700">Wing 어드민 › 개발자 도구 › API 키 관리</span>
                </label>
              </div>
            )}

            <div className="flex gap-2 mt-5">
              <button onClick={saveEdit} className="flex-1 py-2 bg-sky-700 hover:bg-sky-600 text-white text-xs font-black rounded-xl transition-colors">저장</button>
              <button onClick={() => setEditingId(null)} className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-xs font-black rounded-xl transition-colors">취소</button>
              <button onClick={clearEdit} className="px-3 py-2 bg-red-900/40 hover:bg-red-800/60 text-red-400 text-xs font-black rounded-xl transition-colors">삭제</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default CoupangDownloader;
