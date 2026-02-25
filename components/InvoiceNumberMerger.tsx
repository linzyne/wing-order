
import React, { useState, useEffect } from 'react';
import { useInvoiceMerger } from '../hooks/useInvoiceMerger';
import { ArrowDownTrayIcon, CheckIcon, UploadIcon, ArrowPathIcon, BoltIcon } from './icons';

declare var XLSX: any;

const FileInputCell: React.FC<{
    id: string;
    onFileSelect: (file: File) => void;
    selectedFile: File | null;
    disabled: boolean;
}> = ({ id, onFileSelect, selectedFile, disabled }) => {
    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) onFileSelect(file);
        event.target.value = '';
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (disabled) return;
        const file = e.dataTransfer.files?.[0];
        if (file && (file.name.endsWith('.xlsx') || file.name.endsWith('.xls'))) {
            onFileSelect(file);
        }
    };

    return (
        <div className="flex items-center gap-4" onDragOver={handleDragOver} onDrop={handleDrop}>
            <label
                htmlFor={id}
                className={`flex items-center gap-2 cursor-pointer rounded-2xl px-6 py-3 text-sm font-black transition-all shadow-lg ${
                    disabled
                        ? 'bg-zinc-900 text-zinc-700 cursor-not-allowed border border-zinc-800'
                        : selectedFile
                        ? 'bg-emerald-950/20 text-emerald-400 border border-emerald-500/30'
                        : 'bg-zinc-800 text-zinc-300 border border-zinc-700 hover:border-rose-500 hover:text-rose-400'
                }`}
            >
                {selectedFile ? <CheckIcon className="w-5 h-5" /> : <UploadIcon className="w-5 h-5" />}
                <span>{selectedFile ? '업로드됨' : '파일 선택'}</span>
            </label>
            <input
                id={id}
                type="file"
                className="sr-only"
                accept=".xlsx, .xls"
                onChange={handleFileChange}
                disabled={disabled}
            />
            <span className="text-zinc-500 text-sm font-bold truncate max-w-[150px]" title={selectedFile?.name}>
                {selectedFile?.name || '파일을 선택하세요'}
            </span>
        </div>
    );
};

interface InvoiceNumberMergerProps {
    selectedCompany: string;
    orderFile: File | null;
    vendorFile: File | null;
    onVendorFileChange: (file: File | null) => void;
    batchResults?: any;
    isBatchProcessed: boolean;
}

const InvoiceNumberMerger: React.FC<InvoiceNumberMergerProps> = ({ selectedCompany, orderFile, vendorFile, onVendorFileChange, batchResults, isBatchProcessed }) => {
    const [fileInputKey, setFileInputKey] = useState(Date.now());
    const [showFailures, setShowFailures] = useState(false);
    // Fix: Remove 'stats' as it is not returned by the useInvoiceMerger hook.
    const { status, processFiles, reset, results } = useInvoiceMerger();

    useEffect(() => {
        if (!orderFile && status !== 'idle') handleReset();
    }, [orderFile, status]);

    const handleProcess = () => {
        if (vendorFile && orderFile) processFiles(vendorFile, orderFile, selectedCompany);
    };

    const handleReset = () => {
        onVendorFileChange(null);
        reset();
        setShowFailures(false);
        setFileInputKey(Date.now());
    };
    
    const handleDownload = (type: 'mgmt' | 'upload') => {
        const targetResults = isBatchProcessed ? batchResults : results;
        if (!targetResults) return;
        if (type === 'mgmt') XLSX.writeFile(targetResults.mgmtWorkbook, targetResults.mgmtFileName);
        else XLSX.writeFile(targetResults.uploadWorkbook, targetResults.uploadFileName);
    };

    const companyStat = isBatchProcessed 
        ? batchResults?.companyStats?.[selectedCompany] 
        : (results?.companyStats?.[selectedCompany]);

    const showSuccess = isBatchProcessed ? !!companyStat : status === 'success';

    const getInvoiceRuleText = (name: string) => {
        if (name === '고랭지김치') return '업체파일 주문:J, 송장:G | 통합주문서 주문:C';
        if (['총각김치', '배추김치', '포기김치'].includes(name)) return '업체파일 주문:J, 송장:E | 통합주문서 주문:C';
        if (name === '귤_제이') return '업체파일 주문:I, 송장:K | 통합주문서 주문:C';
        if (name === '귤_신선') return '업체파일 주문:D, 송장:R | 통합주문서 주문:C';
        if (name === '귤_초록') return '업체파일 주문:P, 송장:G | 통합주문서 주문:C';
        return '병합 규칙: 주문번호/송장 키워드 자동 찾기';
    };

    const renderActionCell = () => {
        if (status === 'processing') {
            return (
                <div className="flex items-center justify-center text-rose-500 font-black animate-pulse">
                    <svg className="animate-spin h-5 w-5 mr-3" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span>병합 중</span>
                </div>
            );
        }

        if (showSuccess && companyStat) {
            // 매칭된 건수가 0건일 때의 사유 확인 강조 UI
            if (companyStat.upload === 0 && companyStat.failures.length > 0) {
                return (
                    <div className="flex items-center gap-3 animate-fade-in relative">
                        <div className="flex flex-col items-center gap-2">
                            <span className="text-red-500 font-black text-[10px] uppercase tracking-tighter">매칭 결과 없음 (0건)</span>
                            <button 
                                onClick={() => setShowFailures(!showFailures)} 
                                className="bg-zinc-800 text-red-500 border border-red-500/50 py-3 px-6 rounded-2xl hover:bg-zinc-700 shadow-xl flex items-center gap-2 transition-transform hover:scale-105"
                            >
                                <span className="text-lg">⚠️</span>
                                <span className="text-xs font-black">누락 사유 {companyStat.failures.length}건 확인</span>
                            </button>
                        </div>
                        {!isBatchProcessed && (
                            <button onClick={handleReset} className="absolute -right-10 p-2 text-zinc-600 hover:text-rose-500 transition-colors">
                                <ArrowPathIcon className="w-5 h-5" />
                            </button>
                        )}
                    </div>
                );
            }

            return (
                <div className="flex items-center gap-3 animate-fade-in relative">
                    <div className="flex flex-col items-center gap-1.5">
                        <div className="text-emerald-400 font-black text-xs">기록: {companyStat.mgmt}행</div>
                        <button 
                            onClick={() => handleDownload('mgmt')} 
                            className="bg-emerald-600 text-white w-[90px] h-[90px] rounded-[1.8rem] hover:bg-emerald-700 shadow-lg flex flex-col items-center justify-center gap-1 transition-transform hover:scale-105"
                            title="모든 송장 포함 (마진 기록용)"
                        >
                            <ArrowDownTrayIcon className="w-7 h-7" />
                            <span className="text-xs font-black">기록용 받기</span>
                        </button>
                    </div>
                    <div className="flex flex-col items-center gap-1.5">
                        <div className="text-rose-400 font-black text-xs">업로드: {companyStat.upload}건</div>
                        <button 
                            onClick={() => handleDownload('upload')} 
                            className="bg-rose-500 text-white w-[90px] h-[90px] rounded-[1.8rem] hover:bg-rose-600 shadow-lg flex flex-col items-center justify-center gap-1 transition-transform hover:scale-105"
                            title="주문당 1개 송장 (쿠팡 업로드용)"
                        >
                            <ArrowDownTrayIcon className="w-7 h-7" />
                            <span className="text-xs font-black">업로드 받기</span>
                        </button>
                    </div>
                    
                    {companyStat.failures && companyStat.failures.length > 0 && (
                        <div className="flex flex-col items-center gap-1.5 ml-1">
                            <div className="text-red-500 font-black text-xs">누락: {companyStat.failures.length}건</div>
                            <button 
                                onClick={() => setShowFailures(!showFailures)} 
                                className="bg-zinc-800 text-red-500 border border-red-900/30 w-[90px] h-[90px] rounded-[1.8rem] hover:bg-zinc-700 shadow-lg flex flex-col items-center justify-center gap-1 transition-transform hover:scale-105"
                            >
                                <span className="text-xl">⚠️</span>
                                <span className="text-xs font-black">누락 사유</span>
                            </button>
                        </div>
                    )}

                    {!isBatchProcessed && (
                        <button onClick={handleReset} className="absolute -right-10 p-2 text-zinc-600 hover:text-rose-500 transition-colors">
                            <ArrowPathIcon className="w-5 h-5" />
                        </button>
                    )}
                </div>
            );
        }

        if (status === 'error') {
            return (
                <div className="flex items-center justify-center gap-3">
                    <span className="text-red-500 font-black text-sm">실패</span>
                    <button onClick={handleReset} className="p-3 text-zinc-600 hover:text-rose-500"><ArrowPathIcon className="w-5 h-5" /></button>
                </div>
            );
        }

        return (
            <button
                onClick={handleProcess}
                disabled={!vendorFile || !orderFile}
                className="w-full flex items-center justify-center gap-2 bg-rose-500 text-white font-black py-4 px-6 rounded-2xl hover:bg-rose-600 transition-all disabled:bg-zinc-800 disabled:text-zinc-600 shadow-xl shadow-rose-900/20"
            >
                <BoltIcon className="w-5 h-5" />
                <span>병합 실행</span>
            </button>
        );
    };
    
    return (
        <>
        <tr className="border-b border-zinc-900 hover:bg-zinc-800/30 transition-colors">
            <td className="px-10 py-10">
                <div className="font-black text-white text-2xl">{selectedCompany}</div>
                <div className="text-xs text-rose-500/80 font-black mt-1">{getInvoiceRuleText(selectedCompany)}</div>
                <div className="text-[10px] text-zinc-600 font-bold mt-0.5 tracking-wider uppercase">Order Matching Process</div>
            </td>
            <td className="px-10 py-10">
                <FileInputCell
                    id={`vendor-${selectedCompany.replace(/\s/g, '-')}-${fileInputKey}`}
                    onFileSelect={(file) => onVendorFileChange(file)}
                    selectedFile={vendorFile}
                    disabled={status !== 'idle' || isBatchProcessed}
                />
            </td>
            <td className="px-10 py-10 flex justify-center w-[350px]">
                {renderActionCell()}
            </td>
        </tr>
        {showFailures && companyStat && companyStat.failures.length > 0 && (
            <tr>
                <td colSpan={3} className="px-10 py-6 bg-red-950/10 border-b border-red-900/20">
                    <div className="flex items-center justify-between mb-4">
                        <h4 className="text-red-500 font-black text-lg flex items-center gap-2">
                            <span>🚫</span> {selectedCompany} 누락 상세 리포트
                        </h4>
                        <button onClick={() => setShowFailures(false)} className="text-zinc-500 hover:text-white text-sm font-bold">닫기</button>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        {companyStat.failures.map((f: any, idx: number) => (
                            <div key={idx} className="bg-zinc-900/80 p-3 rounded-xl border border-red-900/30 flex flex-col gap-1">
                                <div className="flex justify-between items-center">
                                    <span className="text-zinc-200 font-black text-sm">{f.recipient}</span>
                                    <span className="text-[10px] bg-red-500/20 text-red-400 px-2 py-0.5 rounded-full font-bold">{f.reason}</span>
                                </div>
                                <div className="text-zinc-500 text-[10px] font-mono select-all">주문번호: {f.orderNum}</div>
                            </div>
                        ))}
                    </div>
                </td>
            </tr>
        )}
        </>
    );
};

export default InvoiceNumberMerger;
