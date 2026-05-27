
import React from 'react';
import type { PricingConfig } from '../types';
import { useAutoInvoiceWatcher } from '../hooks/useAutoInvoiceWatcher';

interface AutoWatcherPanelProps {
    masterOrderFile: File | null;
    pricingConfig: PricingConfig;
    activeCompanies: string[];
    businessId?: string;
}

const AutoWatcherPanel: React.FC<AutoWatcherPanelProps> = ({ masterOrderFile, pricingConfig, activeCompanies, businessId }) => {
    const { watching, folderName, log, startWatching, stopWatching, saveToHistory, saving, pendingCount } = useAutoInvoiceWatcher(masterOrderFile, pricingConfig, activeCompanies, businessId);

    return (
        <div className="mx-6 mb-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${watching ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`} />
                    <span className="text-xs font-black text-zinc-400 uppercase tracking-widest">자동 송장 감시</span>
                    {watching && folderName && (
                        <span className="text-xs text-zinc-500 font-mono truncate max-w-[200px]" title={folderName}>{folderName}</span>
                    )}
                    {watching && (
                        <span className="text-[10px] text-zinc-600">오늘 날짜 폴더 자동 감시 중 • 3초마다 체크</span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    {!masterOrderFile && !watching && (
                        <span className="text-[10px] text-zinc-600">마스터발주서 업로드 후 사용 가능</span>
                    )}
                    <button
                        onClick={saveToHistory}
                        disabled={pendingCount === 0 || saving}
                        className="text-xs font-black px-4 py-2 rounded-xl bg-amber-600 text-white hover:bg-amber-500 transition-all shadow-lg shadow-amber-900/30 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:shadow-none"
                    >
                        {saving ? '기록 중...' : pendingCount > 0 ? `기록 (${pendingCount}행)` : '기록'}
                    </button>
                    {watching ? (
                        <button
                            onClick={stopWatching}
                            className="text-xs font-black px-4 py-2 rounded-xl bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white transition-all border border-zinc-700"
                        >
                            감시 중지
                        </button>
                    ) : (
                        <button
                            onClick={startWatching}
                            disabled={!masterOrderFile}
                            className="text-xs font-black px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-500 transition-all shadow-lg shadow-emerald-900/30 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:shadow-none"
                        >
                            폴더 감시 시작
                        </button>
                    )}
                </div>
            </div>

            {log.length > 0 && (
                <div className="mt-3 border-t border-zinc-800 pt-3 space-y-1.5 max-h-32 overflow-y-auto">
                    {log.map(entry => (
                        <div key={entry.id} className="flex items-center gap-2 text-[11px]">
                            <span className="text-zinc-600 font-mono w-10 shrink-0">{entry.time}</span>
                            <span className={entry.status === 'success' ? 'text-emerald-400 shrink-0' : 'text-red-400 shrink-0'}>
                                {entry.status === 'success' ? '✓' : '✗'}
                            </span>
                            <span className="text-zinc-400 truncate">{entry.fileName}</span>
                            <span className={`shrink-0 font-black ${entry.status === 'success' ? 'text-zinc-500' : 'text-red-500'}`}>
                                {entry.message}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default AutoWatcherPanel;
