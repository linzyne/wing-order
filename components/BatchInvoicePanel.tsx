
import React, { useRef, useState, useCallback, useEffect } from 'react';
import type { PricingConfig } from '../types';
import { useBatchInvoice } from '../hooks/useBatchInvoice';

interface BatchInvoicePanelProps {
    masterOrderFile: File | null;
    pricingConfig: PricingConfig;
    activeCompanies: string[];
    businessId?: string;
    onInvoiceReady?: (companyName: string) => void;
    onInvoiceDownloaded?: (companyName: string) => void;
}

const BatchInvoicePanel: React.FC<BatchInvoicePanelProps> = ({
    masterOrderFile, pricingConfig, activeCompanies, businessId, onInvoiceReady, onInvoiceDownloaded,
}) => {
    const { items, addFiles, downloadItem, downloadAll, clearCompleted, clearAll, isProcessing } = useBatchInvoice(
        masterOrderFile, pricingConfig, activeCompanies, businessId
    );
    const inputRef = useRef<HTMLInputElement>(null);
    const [dragging, setDragging] = useState(false);

    const handleFiles = useCallback((files: FileList | null) => {
        if (!files) return;
        const xlsx = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.xlsx') || f.name.toLowerCase().endsWith('.xls'));
        if (xlsx.length === 0) return;
        addFiles(xlsx);
    }, [addFiles]);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDragging(false);
        handleFiles(e.dataTransfer.files);
    }, [handleFiles]);

    // 새로 완료된 항목 감지 → 불 켜기
    const prevDoneIdsRef = useRef<Set<number>>(new Set());
    useEffect(() => {
        items.forEach(item => {
            if (item.status === 'done' && !item.downloaded && !prevDoneIdsRef.current.has(item.id)) {
                prevDoneIdsRef.current.add(item.id);
                onInvoiceReady?.(item.companyName);
            }
        });
    }, [items]);

    const statusIcon = (status: string) => {
        if (status === 'queued') return <span className="text-zinc-600 text-[10px]">대기</span>;
        if (status === 'detecting') return <span className="text-sky-400 text-[10px] animate-pulse">감지중</span>;
        if (status === 'processing') return <span className="text-amber-400 text-[10px] animate-pulse">처리중</span>;
        if (status === 'error') return <span className="text-red-400 text-[10px]">오류</span>;
        return null;
    };

    const doneItems = items.filter(i => i.status === 'done');
    const pendingItems = items.filter(i => i.status !== 'done');

    return (
        <div className="mx-6 mb-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="flex items-center justify-between gap-4 mb-3">
                <div className="flex items-center gap-3">
                    <span className="text-xs font-black text-zinc-400 uppercase tracking-widest">일괄 송장 처리</span>
                    {isProcessing && <span className="text-[10px] text-amber-400 animate-pulse">처리 중...</span>}
                </div>
                <div className="flex items-center gap-2">
                    {!masterOrderFile && (
                        <span className="text-[10px] text-zinc-600">마스터발주서 업로드 후 사용 가능</span>
                    )}
                    {items.length > 0 && (
                        <button onClick={clearAll} className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors">전체삭제</button>
                    )}
                    <button
                        onClick={() => inputRef.current?.click()}
                        disabled={!masterOrderFile}
                        className="text-xs font-black px-4 py-2 rounded-xl bg-sky-600 text-white hover:bg-sky-500 transition-all shadow-lg shadow-sky-900/30 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:shadow-none"
                    >
                        송장파일 업로드
                    </button>
                    <input
                        ref={inputRef}
                        type="file"
                        multiple
                        accept=".xlsx,.xls"
                        className="hidden"
                        onChange={e => { handleFiles(e.target.files); e.target.value = ''; }}
                    />
                </div>
            </div>

            {/* 드래그앤드롭 영역 */}
            <div
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                onClick={() => masterOrderFile && inputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl py-4 px-4 text-center cursor-pointer transition-all ${
                    dragging
                        ? 'border-sky-500 bg-sky-500/10'
                        : masterOrderFile
                        ? 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800/30'
                        : 'border-zinc-800 cursor-not-allowed'
                }`}
            >
                <p className="text-[11px] text-zinc-500">
                    {dragging ? '여기에 놓으세요' : '여러 업체의 송장 파일을 한번에 드래그하거나 클릭해서 업로드'}
                </p>
            </div>

            {/* 처리 중 목록 */}
            {pendingItems.length > 0 && (
                <div className="mt-3 space-y-1.5">
                    {pendingItems.map(item => (
                        <div key={item.id} className="flex items-center gap-2 text-[11px]">
                            {statusIcon(item.status)}
                            <span className="text-zinc-500 truncate flex-1">{item.file.name}</span>
                        </div>
                    ))}
                </div>
            )}

            {/* 완료 목록 */}
            {doneItems.length > 0 && (
                <div className="mt-3 border-t border-zinc-800 pt-3 space-y-1.5">
                    {doneItems.length > 1 && (
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] text-zinc-500">
                                총 {doneItems.reduce((s, i) => s + i.uploadCount, 0)}건
                            </span>
                            <button
                                onClick={() => downloadAll((company) => onInvoiceDownloaded?.(company))}
                                className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-[10px] font-black hover:bg-emerald-500 transition-all shadow-emerald-900/30 shadow-md"
                            >
                                통합 다운로드
                            </button>
                        </div>
                    )}
                    {doneItems.map(item => (
                        <div key={item.id} className="flex items-center gap-2 text-[11px]">
                            <span className={item.downloaded ? 'text-zinc-600' : 'text-emerald-400'}>✓</span>
                            <span className={`font-black shrink-0 ${item.downloaded ? 'text-zinc-600' : 'text-white'}`}>
                                {item.companyName || '미감지'}
                            </span>
                            <span className="text-zinc-500 truncate flex-1">{item.file.name}</span>
                            <span className={`shrink-0 ${item.downloaded ? 'text-zinc-600' : 'text-zinc-400'}`}>
                                {item.uploadCount}건
                            </span>
                            {!item.downloaded ? (
                                <button
                                    onClick={() => {
                                        downloadItem(item.id, (company) => onInvoiceDownloaded?.(company));
                                    }}
                                    className="shrink-0 px-3 py-1 rounded-lg bg-emerald-600 text-white text-[10px] font-black hover:bg-emerald-500 transition-all shadow-emerald-900/30 shadow-md"
                                >
                                    다운로드
                                </button>
                            ) : (
                                <span className="shrink-0 text-[10px] text-zinc-700">완료</span>
                            )}
                        </div>
                    ))}
                    {doneItems.some(i => i.downloaded) && (
                        <button onClick={clearCompleted} className="text-[10px] text-zinc-700 hover:text-zinc-500 transition-colors mt-1">
                            완료된 항목 지우기
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

export default BatchInvoicePanel;
