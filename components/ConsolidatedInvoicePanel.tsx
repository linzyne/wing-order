
import React, { useRef, useState, useCallback, useEffect } from 'react';

export interface InvoiceResult {
  fileName: string;
  businessId: string | null;
  displayName: string | null;
  status: 'done' | 'unmatched' | 'courier' | 'courier-pending';
  courierLabel?: string;
  pendingFile?: File;
}

interface MasterUploadHandlers {
  uploadVendorInvoice?: (files: File[]) => void;
  getInvoiceState?: () => { name: string; uploadCount: number }[];
  downloadInvoice?: (companyName: string) => void;
  downloadAllInvoices?: () => void;
}

interface Business { id: string; displayName: string; }

export interface CourierItem {
  id: string;
  name: string;
  label?: string;
  files: File[];
  result?: { matched: number; total: number; notFound: string[] };
  hasMatchedRows: boolean;
}

interface Props {
  businesses: Business[];
  uploadFns: Record<string, MasterUploadHandlers>;
  onClose: () => void;
  results: InvoiceResult[];
  onResultsChange: React.Dispatch<React.SetStateAction<InvoiceResult[]>>;
  onReset?: () => void;
  couriers?: CourierItem[];
  hasFakeOrders?: boolean;
  onCourierFilesAdd?: (templateId: string, files: File[]) => void;
  onCourierFileRemove?: (templateId: string, index: number) => void;
  onCourierResultDownload?: (templateId: string) => void;
  onDirectCoupangUpload?: (businessId: string) => Promise<void>;
  onCourierDirectCoupangUpload?: (templateId: string, businessId: string) => Promise<void>;
}

function detectBusiness(filename: string, businesses: Business[]): Business | null {
  const nameWithoutExt = filename.normalize('NFC').replace(/\.[^.]+$/, '');
  const lower = nameWithoutExt.toLowerCase().replace(/\s/g, '');
  const fileTokens = nameWithoutExt.toLowerCase()
    .split(/[\s_\-\.\(\)\[\]\/\\]+/)
    .filter(t => t.length >= 2);

  for (const b of businesses) {
    const bizTerms = [b.id, b.displayName]
      .flatMap(s => [s, ...s.split(/[\s_\-\.]/)])
      .filter(t => t.length >= 2)
      .map(t => t.toLowerCase().replace(/\s/g, ''));

    if (bizTerms.some(t => lower.includes(t))) return b;

    const bizName = b.displayName.toLowerCase().replace(/\s/g, '');
    const bizId = b.id.toLowerCase().replace(/\s/g, '');
    if (fileTokens.some(t => bizName.includes(t) || bizId.includes(t))) return b;
  }
  return null;
}

const ConsolidatedInvoicePanel: React.FC<Props> = ({ businesses, uploadFns, onClose, results, onResultsChange, onReset, couriers, hasFakeOrders, onCourierFilesAdd, onCourierFileRemove, onCourierResultDownload, onDirectCoupangUpload, onCourierDirectCoupangUpload }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [downloadSnapshot, setDownloadSnapshot] = useState<{ businessId: string; displayName: string; companies: { name: string; uploadCount: number }[] }[]>([]);
  const [invoiceCountMap, setInvoiceCountMap] = useState<Record<string, number>>({});
  const [courierBizPicker, setCourierBizPicker] = useState<string | null>(null);
  const [coupangStates, setCoupangStates] = useState<Record<string, 'idle' | 'loading' | 'success'>>({});
  const [courierCoupangStates, setCourierCoupangStates] = useState<Record<string, 'idle' | 'loading' | 'success'>>({});

  const refreshInvoiceCounts = useCallback(() => {
    const map: Record<string, number> = {};
    for (const b of businesses) {
      map[b.id] = (uploadFns[b.id]?.getInvoiceState?.() ?? []).length;
    }
    setInvoiceCountMap(map);
  }, [businesses, uploadFns]);

  const refreshDownloadSnapshot = useCallback(() => {
    const snapshot = businesses
      .map(b => ({
        businessId: b.id,
        displayName: b.displayName,
        companies: uploadFns[b.id]?.getInvoiceState?.() ?? [],
      }))
      .filter(b => b.companies.length > 0);
    setDownloadSnapshot(snapshot);
    return snapshot;
  }, [businesses, uploadFns]);

  useEffect(() => {
    const t1 = setTimeout(refreshInvoiceCounts, 100);
    const t2 = setTimeout(refreshDownloadSnapshot, 200);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [refreshInvoiceCounts, refreshDownloadSnapshot]);

  // 결과 목록이 바뀔 때마다 다운로드 스냅샷도 재갱신 (파일 추가 후 반응 없음 방지)
  useEffect(() => {
    if (results.length === 0) return;
    const t = setTimeout(() => {
      refreshInvoiceCounts();
      refreshDownloadSnapshot();
    }, 3000);
    return () => clearTimeout(t);
  }, [results.length, refreshInvoiceCounts, refreshDownloadSnapshot]);

  const detectCourier = (filename: string): CourierItem | null => {
    if (!couriers || couriers.length === 0) return null;
    const lower = filename.normalize('NFC').toLowerCase().replace(/\s/g, '');

    // 1순위: 택배사 이름 + label 키워드 동시 포함 (예: "롯데택배_대행") — 가구매 키워드 불필요
    for (const c of couriers) {
      if (!c.label) continue;
      const nameTokens = c.name.toLowerCase().split(/[\s_\-택배]+/).filter(t => t.length >= 2);
      // 택배사 이름에 이미 포함된 토큰은 label 구분자로 사용하지 않음 (예: "사무실(롯데)"에서 "롯데" 제거)
      const labelTokens = c.label.toLowerCase().split(/[\s_()\[\]]+/).filter(t => t.length >= 2 && !nameTokens.includes(t));
      if (labelTokens.length > 0 && labelTokens.some(t => lower.includes(t)) && nameTokens.some(t => lower.includes(t))) return c;
    }

    if (!lower.includes('가구매')) return null;

    // 2순위: "가구매" + label 키워드 매칭
    for (const c of couriers) {
      if (c.label) {
        const labelTokens = c.label.toLowerCase().split(/[\s_()\[\]]+/).filter(t => t.length >= 2);
        if (labelTokens.some(t => lower.includes(t))) return c;
      }
    }
    // 3순위: "가구매" + 택배사 이름 매칭
    for (const c of couriers) {
      const nameTokens = c.name.toLowerCase().split(/[\s_\-택배]+/).filter(t => t.length >= 2);
      if (nameTokens.some(t => lower.includes(t))) return c;
    }
    // 4순위: "가구매" + 단일 택배사
    if (couriers.length === 1) return couriers[0];
    return null;
  };

  const processFiles = (files: File[]) => {
    const items: InvoiceResult[] = [];
    const grouped: Record<string, File[]> = {};
    const courierGrouped: Record<string, File[]> = {};

    for (const f of files) {
      const courier = detectCourier(f.name);
      if (courier) {
        courierGrouped[courier.id] = [...(courierGrouped[courier.id] || []), f];
        items.push({ fileName: f.name, businessId: null, displayName: null, status: 'courier', courierLabel: courier.label ? `${courier.name} (${courier.label})` : courier.name });
        continue;
      }
      // 파일명에 "가구매"가 있지만 자동 택배사 감지 실패 → 수동 선택 대기
      const lowerName = f.name.normalize('NFC').toLowerCase().replace(/\s/g, '');
      if (couriers && couriers.length > 0 && lowerName.includes('가구매')) {
        items.push({ fileName: f.name, businessId: null, displayName: null, status: 'courier-pending', pendingFile: f });
        continue;
      }
      const biz = detectBusiness(f.name, businesses);
      items.push({ fileName: f.name, businessId: biz?.id ?? null, displayName: biz?.displayName ?? null, status: biz ? 'done' : 'unmatched' });
      if (biz) grouped[biz.id] = [...(grouped[biz.id] || []), f];
    }

    for (const [bizId, bizFiles] of Object.entries(grouped)) {
      uploadFns[bizId]?.uploadVendorInvoice?.(bizFiles);
    }

    for (const [templateId, cFiles] of Object.entries(courierGrouped)) {
      onCourierFilesAdd?.(templateId, cFiles);
    }

    onResultsChange(prev => [...prev, ...items]);

    if (Object.keys(grouped).length > 0) {
      setTimeout(() => {
        refreshInvoiceCounts();
        refreshDownloadSnapshot();
      }, 2500);
    }
  };

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter(f => /\.(xlsx|xls)$/i.test(f.name));
    if (files.length > 0) processFiles(files);
  };

  const statusIcon = (s: InvoiceResult['status']) => {
    if (s === 'done') return <span className="text-emerald-400 font-black text-xs">✓</span>;
    if (s === 'courier') return <span className="text-violet-400 font-black text-xs">↗</span>;
    if (s === 'courier-pending') return <span className="text-violet-300 font-black text-xs">?↗</span>;
    return <span className="text-amber-400 font-black text-xs">?</span>;
  };

  const assignCourierPending = (idx: number, r: InvoiceResult, courierId: string) => {
    if (!r.pendingFile) return;
    const c = couriers?.find(c => c.id === courierId);
    if (!c) return;
    onCourierFilesAdd?.(courierId, [r.pendingFile]);
    onResultsChange(prev => prev.map((item, i) =>
      i === idx
        ? { ...item, status: 'courier' as const, courierLabel: c.label ? `${c.name} (${c.label})` : c.name, pendingFile: undefined }
        : item
    ));
  };

  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-black text-zinc-300">통합 송장 변환</span>
        <div className="flex items-center gap-2">
          {(results.length > 0 || downloadSnapshot.length > 0) && (
            <button
              onClick={() => {
                if (!window.confirm('송장 변환 패널을 초기화하시겠습니까?')) return;
                onReset?.();
                setDownloadSnapshot([]);
                setInvoiceCountMap({});
              }}
              className="text-[10px] font-black text-zinc-600 hover:text-rose-400 transition-colors"
            >
              초기화
            </button>
          )}
          <button onClick={onClose} className="text-zinc-500 hover:text-white text-sm font-black">×</button>
        </div>
      </div>

      {/* 사업자별 상태 배지 */}
      <div className="flex flex-wrap gap-1.5">
        {businesses.map(b => {
          const count = invoiceCountMap[b.id] ?? 0;
          return (
            <div
              key={b.id}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-black border ${
                count > 0
                  ? 'bg-emerald-900/20 text-emerald-300 border-emerald-700/40'
                  : 'bg-zinc-900/40 text-zinc-500 border-zinc-800'
              }`}
            >
              <span>{b.displayName}</span>
              <span className={`text-[9px] font-normal ${count > 0 ? 'text-emerald-500' : 'text-zinc-600'}`}>
                {count > 0 ? `${count}업체 완료` : '대기'}
              </span>
            </div>
          );
        })}
      </div>

      {/* 안내 */}
      <div className="bg-zinc-800/60 rounded-xl px-3 py-2 text-[10px] text-zinc-500 leading-relaxed">
        파일명에 사업자명 포함 필수 · 여러 파일 동시 가능
        <br />(예: <span className="text-zinc-300">안군_송장_0617.xlsx</span>)
        <br />가구매 운송장은 파일명에 <span className="text-violet-300">가구매 사무실</span> 또는 <span className="text-violet-300">가구매 대행</span> 포함
      </div>

      {/* 드롭 존 */}
      <div
        className={`flex flex-col items-center justify-center gap-2 h-24 rounded-2xl border-2 border-dashed cursor-pointer transition-all duration-200 ${
          isDragging
            ? 'border-emerald-400 bg-emerald-500/10'
            : 'border-zinc-700 hover:border-zinc-500 bg-zinc-900/40'
        }`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFiles(e.dataTransfer.files); }}
        onClick={() => fileInputRef.current?.click()}
      >
        <svg className="w-6 h-6 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
        </svg>
        <span className="text-[11px] text-zinc-500">
          {isDragging ? '여기에 놓으세요' : '원본 송장 드롭 또는 클릭 · 여러 파일 동시 가능'}
        </span>
      </div>

      {/* 송장 다운로드 섹션 */}
      <div className="border-t border-zinc-800/60 pt-3 flex flex-col gap-3">
        <span className="px-1 text-[10px] font-black text-zinc-500">송장 다운로드</span>
        {downloadSnapshot.length === 0 ? (
          <p className="text-[10px] text-zinc-600 text-center py-2">송장 데이터가 없습니다</p>
        ) : (
          downloadSnapshot.map(biz => (
            <div key={biz.businessId}>
              {businesses.length > 1 && (
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[13px] font-black text-white">{biz.displayName}</span>
                  <div className="flex-1 h-px bg-zinc-600" />
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                {biz.companies.map(c => {
                  const isFake = c.name === '가구매';
                  return (
                    <div key={c.name} className="flex items-center gap-1.5">
                      <span className={`text-[11px] flex-1 ${isFake ? 'text-pink-300' : 'text-white'}`}>
                        {c.name}
                      </span>
                      <span className="text-[12px] font-black text-zinc-300">{c.uploadCount}건</span>
                      <button
                        onClick={() => uploadFns[biz.businessId]?.downloadInvoice?.(c.name)}
                        className={`px-2.5 py-0.5 text-[11px] font-black rounded-lg transition-colors border ${
                          isFake
                            ? 'bg-pink-900/50 text-pink-300 hover:bg-pink-800/70 hover:text-pink-100 border-pink-700/50'
                            : 'bg-emerald-900/50 text-emerald-300 hover:bg-emerald-800/70 hover:text-emerald-100 border-emerald-700/50'
                        }`}
                      >
                        다운
                      </button>
                    </div>
                  );
                })}
              </div>
              {biz.companies.length > 0 && (
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    onClick={() => uploadFns[biz.businessId]?.downloadAllInvoices?.()}
                    className="flex-1 py-1 text-[11px] font-black rounded-lg bg-emerald-700 text-white hover:bg-emerald-600 transition-colors border border-emerald-600"
                  >
                    합산 다운로드
                  </button>
                  {onDirectCoupangUpload && (
                    <button
                      onClick={async () => {
                        setCoupangStates(prev => ({ ...prev, [biz.businessId]: 'loading' }));
                        try {
                          await onDirectCoupangUpload(biz.businessId);
                          setCoupangStates(prev => ({ ...prev, [biz.businessId]: 'success' }));
                          setTimeout(() => setCoupangStates(prev => ({ ...prev, [biz.businessId]: 'idle' })), 3000);
                        } catch (e: any) {
                          alert(e.message ?? '업로드 실패');
                          setCoupangStates(prev => ({ ...prev, [biz.businessId]: 'idle' }));
                        }
                      }}
                      disabled={coupangStates[biz.businessId] === 'loading'}
                      className={`px-3 py-1 text-[11px] font-black rounded-lg transition-colors border shrink-0 ${
                        coupangStates[biz.businessId] === 'loading'
                          ? 'bg-sky-900 text-zinc-400 cursor-wait border-sky-800'
                          : coupangStates[biz.businessId] === 'success'
                          ? 'bg-emerald-700 text-white border-emerald-600'
                          : 'bg-sky-700 text-white hover:bg-sky-600 border-sky-600'
                      }`}
                      title="쿠팡 Wing에 송장 바로 업로드"
                    >
                      {coupangStates[biz.businessId] === 'loading' ? '업로드 중...'
                        : coupangStates[biz.businessId] === 'success' ? '✓ 완료'
                        : '쿠팡 ↑'}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))
        )}
        <button
          onClick={refreshDownloadSnapshot}
          className="self-end text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors font-bold"
        >
          새로고침
        </button>
      </div>

      {/* 가구매 택배 섹션 */}
      {couriers && couriers.length > 0 && (
        <div className="border-t border-zinc-800/60 pt-3 flex flex-col gap-2">
          <span className="px-1 text-[10px] font-black text-violet-400">가구매 택배</span>
          {!hasFakeOrders ? (
            <p className="text-[10px] text-zinc-600 text-center py-1">가구매 명단을 먼저 입력해주세요</p>
          ) : (
            couriers.map(c => {
              const fullName = c.label ? `${c.name} (${c.label})` : c.name;
              return (
                <div key={c.id} className="flex flex-col gap-1.5 p-2 rounded-xl border border-violet-700/30 bg-violet-950/20">
                  <span className="text-[11px] font-black text-violet-300">{fullName}</span>
                  {/* 업로드된 파일 목록 */}
                  {c.files.length > 0 && (
                    <div className="flex flex-col gap-1">
                      {c.files.map((f, idx) => (
                        <div key={idx} className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-violet-700/30 bg-zinc-900/60">
                          <span className="text-[9px] font-black truncate flex-1 text-violet-300">{f.name}</span>
                          <button
                            onClick={() => onCourierFileRemove?.(c.id, idx)}
                            className="shrink-0 text-zinc-600 hover:text-rose-400 transition-colors text-[10px] leading-none px-0.5"
                          >✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 파일 업로드 버튼 */}
                  <label className="flex items-center justify-center gap-1.5 cursor-pointer px-3 py-1.5 rounded-xl text-[10px] font-black border border-violet-700/40 bg-zinc-900/50 text-violet-400 hover:bg-violet-900/30 hover:text-violet-200 transition-colors">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                    </svg>
                    {c.files.length > 0 ? '파일 추가' : '운송장 업로드'}
                    <input
                      type="file"
                      className="sr-only"
                      accept=".xlsx,.xls"
                      multiple
                      onChange={(e) => {
                        const fs = Array.from(e.target.files || []);
                        if (fs.length > 0) onCourierFilesAdd?.(c.id, fs);
                        e.currentTarget.value = '';
                      }}
                    />
                  </label>
                  {/* 결과 */}
                  {c.result && (
                    <div className="flex flex-col gap-1.5 bg-zinc-950/80 p-2 rounded-xl border border-zinc-800">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="bg-emerald-500 text-white text-[8px] px-1.5 py-0.5 rounded-full font-black">매칭 {c.result.matched}건</span>
                        <span className="text-zinc-500 text-[8px] font-black">/ 가구매 {c.result.total}건</span>
                        {c.result.notFound.length > 0 && (
                          <span className="bg-rose-500 text-white text-[8px] px-1.5 py-0.5 rounded-full font-black">미매칭 {c.result.notFound.length}건</span>
                        )}
                      </div>
                      {c.hasMatchedRows && (
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => onCourierResultDownload?.(c.id)}
                            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-[10px] font-black transition-colors"
                          >
                            운송장완료 다운로드 ({c.result.matched}건)
                          </button>
                          {onCourierDirectCoupangUpload && (
                            <button
                              onClick={async () => {
                                if (businesses.length === 1) {
                                  setCourierCoupangStates(prev => ({ ...prev, [c.id]: 'loading' }));
                                  try {
                                    await onCourierDirectCoupangUpload(c.id, businesses[0].id);
                                    setCourierCoupangStates(prev => ({ ...prev, [c.id]: 'success' }));
                                    setTimeout(() => setCourierCoupangStates(prev => ({ ...prev, [c.id]: 'idle' })), 3000);
                                  } catch (e: any) {
                                    alert(e.message ?? '업로드 실패');
                                    setCourierCoupangStates(prev => ({ ...prev, [c.id]: 'idle' }));
                                  }
                                } else {
                                  setCourierBizPicker(prev => prev === c.id ? null : c.id);
                                }
                              }}
                              disabled={courierCoupangStates[c.id] === 'loading'}
                              className={`px-3 py-1.5 text-[10px] font-black rounded-xl transition-colors border border-sky-600 shrink-0 ${
                                courierCoupangStates[c.id] === 'loading'
                                  ? 'bg-sky-900 text-zinc-400 cursor-wait border-sky-800'
                                  : courierCoupangStates[c.id] === 'success'
                                  ? 'bg-emerald-700 text-white border-emerald-600'
                                  : 'bg-sky-700 text-white hover:bg-sky-600'
                              }`}
                              title="쿠팡 Wing에 운송장 바로 업로드"
                            >
                              {courierCoupangStates[c.id] === 'loading' ? '업로드 중...'
                                : courierCoupangStates[c.id] === 'success' ? '✓ 완료'
                                : '쿠팡 ↑'}
                            </button>
                          )}
                        </div>
                      )}
                      {courierBizPicker === c.id && businesses.length > 1 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {businesses.map(b => (
                            <button
                              key={b.id}
                              onClick={async () => {
                                setCourierBizPicker(null);
                                setCourierCoupangStates(prev => ({ ...prev, [c.id]: 'loading' }));
                                try {
                                  await onCourierDirectCoupangUpload!(c.id, b.id);
                                  setCourierCoupangStates(prev => ({ ...prev, [c.id]: 'success' }));
                                  setTimeout(() => setCourierCoupangStates(prev => ({ ...prev, [c.id]: 'idle' })), 3000);
                                } catch (e: any) {
                                  alert(e.message ?? '업로드 실패');
                                  setCourierCoupangStates(prev => ({ ...prev, [c.id]: 'idle' }));
                                }
                              }}
                              className="px-2.5 py-1 text-[10px] font-black rounded-lg bg-sky-900/60 text-sky-300 hover:bg-sky-700 hover:text-white transition-colors border border-sky-700/50"
                            >
                              {b.displayName}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* 업로드 결과 목록 */}
      {results.length > 0 && (
        <div className="flex flex-col gap-px max-h-48 overflow-y-auto custom-scrollbar">
          {results.map((r, idx) => (
            <div key={idx} className="flex items-center gap-2 bg-zinc-900/60 rounded-lg px-2.5 py-0.5">
              <div className="w-4 flex-shrink-0 flex items-center justify-center">{statusIcon(r.status)}</div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-zinc-300 font-bold truncate">{r.fileName}</div>
                {r.status === 'courier' ? (
                  <div className="text-[9px] text-violet-400">→ {r.courierLabel} · 운송장 매칭 중</div>
                ) : r.status === 'courier-pending' ? (
                  <div className="flex items-center gap-1 flex-wrap mt-0.5">
                    <span className="text-[9px] text-violet-300 shrink-0">가구매 택배사 선택:</span>
                    {couriers?.map(c => (
                      <button
                        key={c.id}
                        onClick={() => assignCourierPending(idx, r, c.id)}
                        className="px-1.5 py-0.5 text-[9px] font-black rounded-md bg-violet-900/60 text-violet-200 hover:bg-violet-700 hover:text-white border border-violet-600/40 transition-colors"
                      >
                        {c.label ? `${c.name} (${c.label})` : c.name}
                      </button>
                    ))}
                  </div>
                ) : r.displayName ? (
                  <div className="text-[9px] text-zinc-500">→ {r.displayName} · 워크스테이션 처리 중</div>
                ) : (
                  <div className="text-[9px] text-amber-500">사업자 감지 실패 (파일명에 사업자명 포함 필요)</div>
                )}
              </div>
              <button
                onClick={() => onResultsChange(prev => prev.filter((_, i) => i !== idx))}
                className="shrink-0 text-zinc-600 hover:text-red-400 transition-colors text-[10px] leading-none px-0.5"
              >✕</button>
            </div>
          ))}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        multiple
        className="hidden"
        onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
};

export default ConsolidatedInvoicePanel;
