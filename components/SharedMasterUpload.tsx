import React, { useRef, useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface UploadResult {
  fileName: string;
  businessId: string | null;
  displayName: string | null;
  mode: 'master' | 'batch';
  status: 'pending' | 'uploading' | 'done' | 'error' | 'unmatched';
  round?: number;
  error?: string;
}

interface MasterUploadHandlers {
  uploadMaster: (file: File) => Promise<void>;
  uploadBatch: (file: File) => Promise<void>;
  getNextRound?: () => number;
  deleteBatchRound?: (round: number) => boolean;
  clearMaster?: () => void;
  getOrderState?: () => { name: string; rounds: { round: number; hasData: boolean; count: number }[] }[];
  downloadCompanyMerged?: (companyName: string) => void;
  downloadCompanyRound?: (companyName: string, round: number) => void;
  downloadAllCompanies?: () => void;
  getCompanyClosed?: (companyName: string) => boolean;
  getCompanyRecorded?: (companyName: string) => boolean;
  toggleCompanyClosed?: (companyName: string) => void;
  toggleCompanyRecord?: (companyName: string) => Promise<void>;
  setWorkDate?: (date: string) => void;
  getWorkDate?: () => string;
  uploadVendorInvoice?: (files: File[]) => void;
  getInvoiceState?: () => { name: string; uploadCount: number }[];
  downloadInvoice?: (companyName: string) => void;
  getLastSettlementSummaries?: () => { companyName: string; kakaoText: string; excelText: string }[];
}

interface Business { id: string; displayName: string; }

interface Props {
  businesses: Business[];
  uploadFns: Record<string, MasterUploadHandlers>;
  onClose: () => void;
  results: UploadResult[];
  onResultsChange: React.Dispatch<React.SetStateAction<UploadResult[]>>;
  warningBusinessIds?: Set<string>;
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

const SharedMasterUpload: React.FC<Props> = ({ businesses, uploadFns, onClose, results, onResultsChange, warningBusinessIds }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showDownload, setShowDownload] = useState(true);
  const [downloadSnapshot, setDownloadSnapshot] = useState<{ businessId: string; displayName: string; companies: { name: string; rounds: { round: number; hasData: boolean; count: number }[] }[] }[]>([]);
  const [nextRounds, setNextRounds] = useState<Record<string, number>>({});
  const [companyClosedMap, setCompanyClosedMap] = useState<Record<string, boolean>>({});
  const [companyRecordedMap, setCompanyRecordedMap] = useState<Record<string, boolean>>({});
  const [downloadedButtons, setDownloadedButtons] = useState<Set<string>>(new Set());
  const [settlementCompany, setSettlementCompany] = useState<string | null>(null);
  const [copiedSettlement, setCopiedSettlement] = useState<string | null>(null);
  const [globalWorkDate, setGlobalWorkDate] = useState<string>(() => new Date().toLocaleDateString('en-CA'));

  // 마운트 시 첫 번째 사업자의 작업날짜를 가져와 표시값 동기화
  useEffect(() => {
    for (const b of businesses) {
      const d = uploadFns[b.id]?.getWorkDate?.();
      if (d) { setGlobalWorkDate(d); break; }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleGlobalWorkDateChange = (date: string) => {
    setGlobalWorkDate(date);
    businesses.forEach(b => uploadFns[b.id]?.setWorkDate?.(date));
  };

  const refreshNextRounds = useCallback(() => {
    const next: Record<string, number> = {};
    for (const b of businesses) {
      next[b.id] = uploadFns[b.id]?.getNextRound?.() ?? 1;
    }
    setNextRounds(next);
  }, [businesses, uploadFns]);

  useEffect(() => {
    const t = setTimeout(refreshNextRounds, 100);
    return () => clearTimeout(t);
  }, [refreshNextRounds]);

  useEffect(() => {
    const snapshot = refreshDownloadSnapshot();
    const closedMap: Record<string, boolean> = {};
    const recordedMap: Record<string, boolean> = {};
    for (const biz of snapshot) {
      for (const company of biz.companies) {
        const key = `${biz.businessId}_${company.name}`;
        closedMap[key] = uploadFns[biz.businessId]?.getCompanyClosed?.(company.name) ?? false;
        recordedMap[key] = uploadFns[biz.businessId]?.getCompanyRecorded?.(company.name) ?? false;
      }
    }
    setCompanyClosedMap(closedMap);
    setCompanyRecordedMap(recordedMap);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshDownloadSnapshot = useCallback(() => {
    const snapshot = businesses
      .map(b => ({
        businessId: b.id,
        displayName: b.displayName,
        companies: uploadFns[b.id]?.getOrderState?.() ?? [],
      }))
      .filter(b => b.companies.length > 0);
    setDownloadSnapshot(snapshot);
    return snapshot;
  }, [businesses, uploadFns]);

  const handleBulkToggleClosed = () => {
    const snapshot = refreshDownloadSnapshot();
    const entries = snapshot.flatMap(biz =>
      biz.companies.map(c => ({ bizId: biz.businessId, companyName: c.name }))
    );
    const freshMap: Record<string, boolean> = {};
    entries.forEach(({ bizId, companyName }) => {
      freshMap[`${bizId}_${companyName}`] = uploadFns[bizId]?.getCompanyClosed?.(companyName) ?? false;
    });
    const allClosed = entries.length > 0 && entries.every(({ bizId, companyName }) => freshMap[`${bizId}_${companyName}`]);
    const next = !allClosed;
    entries.forEach(({ bizId, companyName }) => {
      if ((freshMap[`${bizId}_${companyName}`] ?? false) !== next)
        uploadFns[bizId]?.toggleCompanyClosed?.(companyName);
    });
    setCompanyClosedMap(prev => {
      const u = { ...prev, ...freshMap };
      entries.forEach(({ bizId, companyName }) => { u[`${bizId}_${companyName}`] = next; });
      return u;
    });
  };

  const handleBulkToggleRecorded = async () => {
    const snapshot = refreshDownloadSnapshot();
    const entries = snapshot.flatMap(biz =>
      biz.companies.map(c => ({ bizId: biz.businessId, companyName: c.name }))
    );
    const freshMap: Record<string, boolean> = {};
    entries.forEach(({ bizId, companyName }) => {
      freshMap[`${bizId}_${companyName}`] = uploadFns[bizId]?.getCompanyRecorded?.(companyName) ?? false;
    });
    const allRecorded = entries.length > 0 && entries.every(({ bizId, companyName }) => freshMap[`${bizId}_${companyName}`]);
    const next = !allRecorded;
    // 워크스테이션 각 업체의 기록 버튼을 실제로 한 번씩 눌러주는 것과 동일하게, 하나씩 저장이
    // 끝나길 기다렸다가 다음 업체로 넘어간다 (동시에 쏘면 같은 사업자 문서를 서로 덮어써서
    // 일부 업체만 기록되는 문제가 있었음)
    for (const { bizId, companyName } of entries) {
      if ((freshMap[`${bizId}_${companyName}`] ?? false) !== next) {
        await uploadFns[bizId]?.toggleCompanyRecord?.(companyName);
      }
    }
    const updatedMap: Record<string, boolean> = { ...freshMap };
    entries.forEach(({ bizId, companyName }) => {
      updatedMap[`${bizId}_${companyName}`] = uploadFns[bizId]?.getCompanyRecorded?.(companyName) ?? false;
    });
    setCompanyRecordedMap(prev => ({ ...prev, ...updatedMap }));
  };

  const bulkAllClosed = (() => {
    const entries = downloadSnapshot.flatMap(biz =>
      biz.companies.map(c => `${biz.businessId}_${c.name}`)
    );
    return entries.length > 0 && entries.every(k => companyClosedMap[k] ?? false);
  })();
  const bulkAllRecorded = (() => {
    const entries = downloadSnapshot.flatMap(biz =>
      biz.companies.map(c => `${biz.businessId}_${c.name}`)
    );
    return entries.length > 0 && entries.every(k => companyRecordedMap[k] ?? false);
  })();

  const handleToggleDownload = () => {
    if (!showDownload) {
      const snapshot = refreshDownloadSnapshot();
      const closedMap: Record<string, boolean> = {};
      const recordedMap: Record<string, boolean> = {};
      for (const biz of snapshot) {
        for (const company of biz.companies) {
          const key = `${biz.businessId}_${company.name}`;
          closedMap[key] = uploadFns[biz.businessId]?.getCompanyClosed?.(company.name) ?? false;
          recordedMap[key] = uploadFns[biz.businessId]?.getCompanyRecorded?.(company.name) ?? false;
        }
      }
      setCompanyClosedMap(closedMap);
      setCompanyRecordedMap(recordedMap);
    }
    setShowDownload(v => !v);
  };

  const processFiles = async (files: File[]) => {
    // 모드를 파일별로 사업자 상태 기준으로 자동 감지
    const items: UploadResult[] = files.map(f => {
      const biz = detectBusiness(f.name, businesses);
      const nextRound = biz ? (uploadFns[biz.id]?.getNextRound?.() ?? 1) : undefined;
      const mode: 'master' | 'batch' = nextRound === 1 ? 'master' : 'batch';
      return {
        fileName: f.name,
        businessId: biz?.id ?? null,
        displayName: biz?.displayName ?? null,
        mode,
        status: biz ? 'pending' : 'unmatched',
        round: nextRound,
      };
    });
    const offset = results.length;
    onResultsChange(prev => [...prev, ...items]);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const resultIdx = offset + i;
      if (!item.businessId) continue;
      const handlers = uploadFns[item.businessId];
      if (!handlers) {
        onResultsChange(prev => prev.map((r, idx) => idx === resultIdx ? { ...r, status: 'error', error: '핸들러 없음 (패널 미로드)' } : r));
        continue;
      }
      onResultsChange(prev => prev.map((r, idx) => idx === resultIdx ? { ...r, status: 'uploading' } : r));
      try {
        if (item.mode === 'master') {
          await handlers.uploadMaster(files[i]);
        } else {
          await handlers.uploadBatch(files[i]);
        }
        onResultsChange(prev => prev.map((r, idx) => idx === resultIdx ? { ...r, status: 'done' } : r));
      } catch (e: any) {
        onResultsChange(prev => prev.map((r, idx) => idx === resultIdx ? { ...r, status: 'error', error: e?.message ?? '오류' } : r));
      }
    }
    refreshNextRounds();
    // 스냅샷을 즉시 + 워크스테이션 처리 완료 타이밍에 맞춰 반복 갱신
    setTimeout(() => { refreshNextRounds(); refreshDownloadSnapshot(); }, 300);
    setTimeout(() => { refreshDownloadSnapshot(); }, 1500);
    setTimeout(() => { refreshDownloadSnapshot(); }, 4000);
  };

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter(f => /\.(xlsx|xls)$/i.test(f.name));
    if (files.length === 0) return;
    processFiles(files);
  };

  const handleRemoveResult = (globalIdx: number, r: UploadResult) => {
    let removed = true;
    if (r.mode === 'master' && r.businessId) {
      uploadFns[r.businessId]?.clearMaster?.();
    } else if (r.mode === 'batch' && r.businessId && r.round != null) {
      removed = uploadFns[r.businessId]?.deleteBatchRound?.(r.round) ?? true;
    }
    if (removed) {
      onResultsChange(prev => prev.filter((_, idx) => idx !== globalIdx));
      refreshNextRounds();
    }
  };

  const statusIcon = (s: UploadResult['status']) => {
    if (s === 'done') return <span className="text-emerald-400 font-black text-xs">✓</span>;
    if (s === 'error') return <span className="text-red-400 font-black text-xs">✗</span>;
    if (s === 'unmatched') return <span className="text-amber-400 font-black text-xs">?</span>;
    if (s === 'uploading') return <div className="w-3 h-3 border border-violet-400 border-t-transparent rounded-full animate-spin" />;
    return <div className="w-2 h-2 rounded-full bg-zinc-600" />;
  };

  const roundColors = (round: number) => {
    if (round === 1) return { text: 'text-violet-400', bg: 'bg-violet-900/40 text-violet-300 border-violet-700/40 hover:bg-violet-800/60 hover:text-violet-100' };
    if (round === 2) return { text: 'text-sky-400', bg: 'bg-sky-900/40 text-sky-300 border-sky-700/40 hover:bg-sky-800/60 hover:text-sky-100' };
    if (round === 3) return { text: 'text-emerald-400', bg: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/40 hover:bg-emerald-800/60 hover:text-emerald-100' };
    if (round === 4) return { text: 'text-amber-400', bg: 'bg-amber-900/40 text-amber-300 border-amber-700/40 hover:bg-amber-800/60 hover:text-amber-100' };
    return { text: 'text-rose-400', bg: 'bg-rose-900/40 text-rose-300 border-rose-700/40 hover:bg-rose-800/60 hover:text-rose-100' };
  };

  const roundLabel = (round: number) =>
    <span className={roundColors(round).text}>{round}차</span>;

  const indexedResults = results.map((r, idx) => ({ ...r, globalIdx: idx }));

  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-black text-zinc-300">공통 주문서 업로드</span>
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={globalWorkDate}
            onChange={(e) => handleGlobalWorkDateChange(e.target.value)}
            title="작업날짜 (전체 사업자에 동시 적용)"
            className="bg-zinc-800 text-zinc-300 border border-zinc-700 rounded-lg px-1.5 py-0.5 text-[10px] font-bold focus:outline-none focus:border-indigo-500 transition-colors"
          />
          <button
            onClick={handleBulkToggleClosed}
            title={bulkAllClosed ? '전체 마감 해제' : '전체 업체 마감 처리'}
            className={`px-2 py-0.5 rounded text-[10px] font-black tracking-tight border transition-all ${
              bulkAllClosed
                ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                : 'bg-transparent text-zinc-600 border-zinc-700 hover:text-zinc-400 hover:border-zinc-500'
            }`}
          >
            마감
          </button>
          <button
            onClick={handleBulkToggleRecorded}
            title={bulkAllRecorded ? '전체 기록 해제' : '전체 업체 기록하기'}
            className={`px-2 py-0.5 rounded text-[10px] font-black tracking-tight border transition-all ${
              bulkAllRecorded
                ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                : 'bg-transparent text-zinc-600 border-zinc-700 hover:text-zinc-400 hover:border-zinc-500'
            }`}
          >
            기록
          </button>
          <button onClick={onClose} className="text-zinc-500 hover:text-white text-sm font-black">×</button>
        </div>
      </div>

      {/* 업체별 현재 차수 상태 배지 */}
      <div className="flex flex-wrap gap-1.5">
        {businesses.map(b => {
          const round = nextRounds[b.id] ?? 1;
          const needsMaster = round === 1;
          const hasWarning = warningBusinessIds?.has(b.id) ?? false;
          return (
            <div
              key={b.id}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-black border ${
                needsMaster
                  ? 'bg-amber-900/20 text-amber-300 border-amber-700/40'
                  : 'bg-emerald-900/20 text-emerald-300 border-emerald-700/40'
              }`}
            >
              <span>{b.displayName}</span>
              <span className={`text-[9px] font-normal ${needsMaster ? 'text-amber-500' : 'text-emerald-500'}`}>
                {needsMaster ? '1차 필요' : `${round}차 대기`}
              </span>
              {hasWarning && (
                <span title="워크스테이션에 경고가 있습니다" className="text-amber-400 text-[10px] leading-none">⚠</span>
              )}
            </div>
          );
        })}
      </div>

      {/* 안내 */}
      <div className="bg-zinc-800/60 rounded-xl px-3 py-2 text-[10px] text-zinc-500 leading-relaxed">
        파일명에 사업자명 포함 필수 · <span className="text-zinc-300">1차/N차 자동 감지</span>
        <br />(예: <span className="text-zinc-300">조에_0616.xlsx</span>, <span className="text-zinc-300">안군_0617.xlsx</span>)
      </div>

      {/* 드롭 존 */}
      <div
        className={`flex flex-col items-center justify-center gap-2 h-24 rounded-2xl border-2 border-dashed cursor-pointer transition-all duration-200 ${
          isDragging
            ? 'border-violet-400 bg-violet-500/10'
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
          {isDragging ? '여기에 놓으세요' : '파일 드롭 또는 클릭 · 여러 파일 동시 가능'}
        </span>
      </div>

      {/* 발주서 다운로드 섹션 */}
      <div className="border-t border-zinc-800/60 pt-3">
        <button
          onClick={handleToggleDownload}
          className="w-full flex items-center justify-between px-1 py-0.5 text-[10px] font-black text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <span>발주서 다운로드</span>
          <svg
            className={`w-3 h-3 transition-transform duration-200 ${showDownload ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {showDownload && (
          <div className="mt-2 flex flex-col gap-3">
            {/* 사업자별 전체합산 버튼 */}
            {downloadSnapshot.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pb-2 border-b border-zinc-800/60">
                {downloadSnapshot.map(biz => (
                  <button
                    key={biz.businessId}
                    onClick={() => uploadFns[biz.businessId]?.downloadAllCompanies?.()}
                    className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-black rounded-lg bg-violet-900/40 text-violet-300 hover:bg-violet-800/60 hover:text-violet-100 transition-colors border border-violet-700/40"
                  >
                    {biz.displayName} 전체합산
                  </button>
                ))}
              </div>
            )}
            {downloadSnapshot.length === 0 ? (
              <p className="text-[10px] text-zinc-600 text-center py-2">발주 데이터가 없습니다</p>
            ) : (() => {
              // 업체 기준으로 피벗: 각 사업자의 companyOrder 순서를 존중해 글로벌 업체 목록 구성
              const companyOrder: string[] = [];
              const seen = new Set<string>();
              for (const biz of downloadSnapshot) {
                for (const company of biz.companies) {
                  if (!seen.has(company.name)) { seen.add(company.name); companyOrder.push(company.name); }
                }
              }
              return companyOrder.map(companyName => {
                const bizEntries = downloadSnapshot
                  .map(biz => ({ biz, company: biz.companies.find(c => c.name === companyName) }))
                  .filter((e): e is { biz: typeof downloadSnapshot[0]; company: NonNullable<typeof e.company> } => !!e.company);
                if (bizEntries.length === 0) return null;

                // 업체 단위 마감/기록 상태: 같은 업체명이 여러 사업자에 걸쳐 있을 때, "하나라도"(OR) 기준으로
                // 배지를 켜면 실제로는 기록 안 된 사업자가 있어도 켜진 것처럼 보이고, 토글 시에도 이미
                // 목표상태와 같은 사업자는 건너뛰어 조용히 누락된다. "전부 다"(AND) 기준으로 통일한다.
                const allClosedKey = bizEntries.every(({ biz }) => companyClosedMap[`${biz.businessId}_${companyName}`] ?? false);
                const allRecordedKey = bizEntries.every(({ biz }) => companyRecordedMap[`${biz.businessId}_${companyName}`] ?? false);

                const handleToggleAllClosed = () => {
                  const next = !allClosedKey;
                  bizEntries.forEach(({ biz }) => {
                    const mapKey = `${biz.businessId}_${companyName}`;
                    const cur = companyClosedMap[mapKey] ?? false;
                    if (cur !== next) uploadFns[biz.businessId]?.toggleCompanyClosed?.(companyName);
                  });
                  setCompanyClosedMap(prev => {
                    const u = { ...prev };
                    bizEntries.forEach(({ biz }) => { u[`${biz.businessId}_${companyName}`] = next; });
                    return u;
                  });
                };

                const handleToggleAllRecorded = async () => {
                  const next = !allRecordedKey;
                  // 워크스테이션의 업체별 기록 버튼을 하나씩 실제로 누르는 것과 동일하게 순차 처리
                  for (const { biz } of bizEntries) {
                    const mapKey = `${biz.businessId}_${companyName}`;
                    const cur = companyRecordedMap[mapKey] ?? false;
                    if (cur !== next) await uploadFns[biz.businessId]?.toggleCompanyRecord?.(companyName);
                  }
                  setCompanyRecordedMap(prev => {
                    const u = { ...prev };
                    bizEntries.forEach(({ biz }) => {
                      u[`${biz.businessId}_${companyName}`] = uploadFns[biz.businessId]?.getCompanyRecorded?.(companyName) ?? false;
                    });
                    return u;
                  });
                };

                return (
                  <div key={companyName}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-sm font-black text-white tracking-tight">{companyName}</span>
                      <button
                        onClick={() => setSettlementCompany(companyName)}
                        className="shrink-0 px-2 py-0.5 rounded text-[11px] font-black tracking-tight border transition-all bg-transparent text-rose-500 border-rose-700/50 hover:text-rose-300 hover:border-rose-500"
                      >
                        정산
                      </button>
                      <button
                        onClick={handleToggleAllClosed}
                        title={allClosedKey ? '마감 해제 (전체 사업자)' : '마감 처리 (전체 사업자)'}
                        className={`shrink-0 px-2 py-0.5 rounded text-[11px] font-black tracking-tight border transition-all ${
                          allClosedKey
                            ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                            : 'bg-transparent text-zinc-600 border-zinc-700 hover:text-zinc-400 hover:border-zinc-500'
                        }`}
                      >
                        마감
                      </button>
                      <button
                        onClick={handleToggleAllRecorded}
                        title={allRecordedKey ? '기록 해제 (전체 사업자)' : '기록하기 (전체 사업자)'}
                        className={`shrink-0 px-2 py-0.5 rounded text-[11px] font-black tracking-tight border transition-all ${
                          allRecordedKey
                            ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                            : 'bg-transparent text-zinc-600 border-zinc-700 hover:text-zinc-400 hover:border-zinc-500'
                        }`}
                      >
                        기록
                      </button>
                      <div className="flex-1 h-px bg-zinc-700" />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {bizEntries.map(({ biz, company }) => {
                        const totalCount = company.rounds.reduce((s, r) => s + (r.count ?? 0), 0);
                        return (
                          <div key={biz.businessId} className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[11px] text-zinc-400 w-16 shrink-0 truncate font-bold" title={biz.displayName ?? ''}>{biz.displayName}</span>
                            <button
                              onClick={() => { uploadFns[biz.businessId]?.downloadCompanyMerged?.(companyName); setDownloadedButtons(prev => { const next = new Set(prev); next.add(`${biz.businessId}_${companyName}_merged`); company.rounds.forEach(r => next.add(`${biz.businessId}_${companyName}_${r.round}`)); return next; }); }}
                              className={`px-2.5 py-0.5 text-[11px] font-black rounded-lg transition-colors border ${downloadedButtons.has(`${biz.businessId}_${companyName}_merged`) ? 'bg-zinc-800/50 text-zinc-600 border-transparent' : 'bg-teal-700 text-white hover:bg-teal-600 border-teal-600'}`}
                            >
                              합산{totalCount > 0 ? ` ${totalCount}` : ''}
                            </button>
                            {company.rounds.filter(r => r.hasData).map(r => (
                              <button
                                key={r.round}
                                onClick={() => { uploadFns[biz.businessId]?.downloadCompanyRound?.(companyName, r.round); setDownloadedButtons(prev => new Set(prev).add(`${biz.businessId}_${companyName}_${r.round}`)); }}
                                className={`px-2.5 py-0.5 text-[11px] font-black rounded-lg transition-colors border ${downloadedButtons.has(`${biz.businessId}_${companyName}_${r.round}`) ? 'bg-zinc-800/50 text-zinc-600 border-transparent' : roundColors(r.round).bg}`}
                              >
                                {r.round}차{r.count > 0 ? ` ${r.count}` : ''}
                              </button>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              });
            })()}
            <button
              onClick={refreshDownloadSnapshot}
              className="self-end text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors font-bold"
            >
              새로고침
            </button>
          </div>
        )}
      </div>

      {/* 업로드 결과 통합 목록 */}
      {indexedResults.length > 0 && (
        <div className="flex flex-col gap-px max-h-48 overflow-y-auto custom-scrollbar">
          {indexedResults.map(r => (
            <div key={r.globalIdx} className="flex items-center gap-2 bg-zinc-900/60 rounded-lg px-2.5 py-0.5">
              <div className="w-4 flex-shrink-0 flex items-center justify-center">{statusIcon(r.status)}</div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-zinc-300 font-bold truncate">{r.fileName}</div>
                {r.status === 'error' && r.error ? (
                  <div className="text-[9px] text-red-400 font-bold">{r.error}</div>
                ) : r.displayName ? (
                  <div className="text-[9px] text-zinc-500">
                    → {r.displayName} · {r.round != null ? roundLabel(r.round) : ''}
                  </div>
                ) : (
                  <div className="text-[9px] text-amber-500">사업자 감지 실패</div>
                )}
              </div>
              {(r.status === 'done' || r.status === 'error') && r.businessId && (
                <button
                  onClick={() => handleRemoveResult(r.globalIdx, r)}
                  className="shrink-0 text-zinc-600 hover:text-red-400 transition-colors text-[10px] leading-none px-0.5"
                  title="이 업로드 취소"
                >✕</button>
              )}
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

      {settlementCompany && createPortal(
        <SettlementPopup
          companyName={settlementCompany}
          businesses={businesses}
          uploadFns={uploadFns}
          copiedId={copiedSettlement}
          onCopy={(id, text) => { navigator.clipboard.writeText(text); setCopiedSettlement(id); setTimeout(() => setCopiedSettlement(null), 2000); }}
          onClose={() => setSettlementCompany(null)}
        />,
        document.body
      )}
    </div>
  );
};

interface SettlementPopupProps {
  companyName: string;
  businesses: { id: string; displayName: string }[];
  uploadFns: Record<string, MasterUploadHandlers>;
  copiedId: string | null;
  onCopy: (id: string, text: string) => void;
  onClose: () => void;
}

const SettlementPopup: React.FC<SettlementPopupProps> = ({ companyName, businesses, uploadFns, copiedId, onCopy, onClose }) => {
  const [isInterim, setIsInterim] = useState(false);

  // 해당 업체의 사업자별 정산 수집
  const bizList: { businessId: string; displayName: string; kakaoText: string; excelText: string }[] = [];
  for (const b of businesses) {
    const summaries = uploadFns[b.id]?.getLastSettlementSummaries?.() ?? [];
    const match = summaries.find(s => s.companyName === companyName);
    if (match?.kakaoText) {
      bizList.push({ businessId: b.id, displayName: b.displayName, kakaoText: match.kakaoText, excelText: match.excelText });
    }
  }

  const SEP = '==============';
  const combinedKakao = bizList.map(b => `${SEP}\n${b.kakaoText}`).join('\n\n\n');
  const combinedExcel = bizList.map(b => b.excelText).join('\n');

  const kakaoTextToCopy = isInterim ? `[중간집계]\n${combinedKakao}` : combinedKakao;

  return (
    <div
      style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 99999, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.75)' }}
      onClick={onClose}
    >
      <div
        style={{ background: '#18181b', borderRadius: '20px', padding: '20px', width: '92vw', maxWidth: '520px', maxHeight: '85vh', display: 'flex', flexDirection: 'column', border: '1px solid #3f3f46', boxShadow: '0 25px 60px rgba(0,0,0,0.7)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', flexShrink: 0 }}>
          <span style={{ color: '#fff', fontWeight: 900, fontSize: '13px' }}>{companyName} 정산 요약</span>
          <button onClick={onClose} style={{ color: '#71717a', fontSize: '18px', fontWeight: 700, background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        {bizList.length === 0 ? (
          <p style={{ color: '#71717a', fontSize: '12px', textAlign: 'center', padding: '24px 0' }}>정산 데이터가 없습니다. 발주서를 먼저 업로드해주세요.</p>
        ) : (
          <>
            {/* 공통 버튼: 전체 사업자 합산 복사 */}
            <div style={{ display: 'flex', gap: '6px', marginBottom: '14px', flexShrink: 0, flexWrap: 'wrap' }}>
              <button
                onClick={() => setIsInterim(v => !v)}
                style={{ padding: '6px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 900, border: `1px solid ${isInterim ? '#f59e0b' : '#3f3f46'}`, background: isInterim ? '#78350f' : '#27272a', color: isInterim ? '#fcd34d' : '#71717a', cursor: 'pointer', transition: 'all 0.15s' }}
              >중간집계</button>
              <button
                onClick={() => onCopy(`${companyName}_kakao`, kakaoTextToCopy)}
                style={{ padding: '6px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 900, border: `1px solid ${copiedId === `${companyName}_kakao` ? '#10b981' : '#3f3f46'}`, background: copiedId === `${companyName}_kakao` ? '#10b981' : '#27272a', color: copiedId === `${companyName}_kakao` ? '#fff' : '#f472b6', cursor: 'pointer', transition: 'all 0.15s' }}
              >{copiedId === `${companyName}_kakao` ? '복사됨!' : '카톡용'}</button>
              <button
                onClick={() => onCopy(`${companyName}_excel`, combinedExcel)}
                style={{ padding: '6px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 900, border: `1px solid ${copiedId === `${companyName}_excel` ? '#10b981' : '#3f3f46'}`, background: copiedId === `${companyName}_excel` ? '#10b981' : '#27272a', color: copiedId === `${companyName}_excel` ? '#fff' : '#818cf8', cursor: 'pointer', transition: 'all 0.15s' }}
              >{copiedId === `${companyName}_excel` ? '복사됨!' : '엑셀용'}</button>
              <button
                onClick={onClose}
                style={{ padding: '6px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 900, border: '1px solid #3f3f46', background: '#27272a', color: '#a1a1aa', cursor: 'pointer' }}
                title="닫고 워크스테이션에서 수정"
              >수정</button>
            </div>

            {/* 전체 정산 내용 한 번에 표시 */}
            <div style={{ overflowY: 'auto' }}>
              {isInterim && (
                <div style={{ color: '#fcd34d', fontWeight: 900, fontSize: '13px', fontFamily: 'monospace', marginBottom: '6px' }}>[중간집계]</div>
              )}
              <pre style={{ color: '#e4e4e7', fontSize: '13px', fontFamily: 'monospace', whiteSpace: 'pre-wrap', lineHeight: 1.7, margin: 0 }}>{combinedKakao}</pre>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default SharedMasterUpload;
