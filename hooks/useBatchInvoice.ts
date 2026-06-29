
import { useState, useRef, useCallback, useEffect } from 'react';
import { useInvoiceMerger } from './useInvoiceMerger';
import { detectCompanyName } from './useAutoInvoiceWatcher';
import type { PricingConfig } from '../types';
import { getBusinessInfo } from '../types';

declare var XLSX: any;

export interface BatchInvoiceItem {
    id: number;
    file: File;
    status: 'queued' | 'detecting' | 'processing' | 'done' | 'error';
    companyName: string;
    uploadCount: number;
    workbook: any;
    uploadFileName: string;
    errorMessage?: string;
    downloaded: boolean;
}

export const useBatchInvoice = (
    masterOrderFile: File | null,
    pricingConfig: PricingConfig,
    activeCompanies: string[],
    businessId?: string,
    allOrderFiles?: File[]
) => {
    const { processFiles, results, status: mergeStatus, error: mergeError, reset: resetMerger } = useInvoiceMerger();
    const [items, setItems] = useState<BatchInvoiceItem[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);

    const queueRef = useRef<BatchInvoiceItem[]>([]);
    const handlingRef = useRef(false);
    const currentIdRef = useRef<number | null>(null);
    const itemIdRef = useRef(0);

    const processNext = useCallback(async () => {
        if (handlingRef.current || !masterOrderFile) return;
        const next = queueRef.current.shift();
        if (!next) { setIsProcessing(false); return; }

        handlingRef.current = true;
        currentIdRef.current = next.id;
        setIsProcessing(true);

        setItems(prev => prev.map(i => i.id === next.id ? { ...i, status: 'detecting' } : i));

        try {
            const company = await detectCompanyName(next.file, masterOrderFile, activeCompanies, pricingConfig);
            setItems(prev => prev.map(i => i.id === next.id ? { ...i, status: 'processing', companyName: company } : i));
            const orderFiles: File[] = [masterOrderFile, ...(allOrderFiles || [])];
            processFiles(next.file, orderFiles, company, true, pricingConfig);
        } catch {
            handlingRef.current = false;
            currentIdRef.current = null;
            setItems(prev => prev.map(i => i.id === next.id ? { ...i, status: 'error', errorMessage: '업체 감지 실패' } : i));
            processNext();
        }
    }, [masterOrderFile, pricingConfig, activeCompanies, processFiles]);

    useEffect(() => {
        if (!handlingRef.current || currentIdRef.current === null) return;
        if (mergeStatus !== 'success' && mergeStatus !== 'error') return;

        const itemId = currentIdRef.current;
        currentIdRef.current = null;
        handlingRef.current = false;

        if (mergeStatus === 'success' && results) {
            const uploadCount = results.companyStats
                ? Object.values(results.companyStats).reduce((s, c: any) => s + c.upload, 0)
                : 0;
            setItems(prev => prev.map(i => i.id === itemId ? {
                ...i, status: 'done', uploadCount,
                workbook: results.uploadWorkbook,
                uploadFileName: results.uploadFileName,
            } : i));
        } else {
            setItems(prev => prev.map(i => i.id === itemId ? {
                ...i, status: 'error', errorMessage: mergeError || '처리 실패',
            } : i));
        }

        resetMerger();
        setTimeout(() => processNext(), 50);
    }, [mergeStatus]);

    const addFiles = useCallback((files: File[]) => {
        if (!masterOrderFile) return;
        const newItems: BatchInvoiceItem[] = files.map(f => ({
            id: ++itemIdRef.current,
            file: f,
            status: 'queued' as const,
            companyName: '',
            uploadCount: 0,
            workbook: null,
            uploadFileName: '',
            downloaded: false,
        }));
        setItems(prev => [...prev, ...newItems]);
        queueRef.current.push(...newItems);
        processNext();
    }, [masterOrderFile, processNext]);

    const downloadItem = useCallback((id: number, onDownloaded?: (companyName: string) => void) => {
        setItems(prev => {
            const item = prev.find(i => i.id === id);
            if (item?.workbook && !item.downloaded) {
                XLSX.writeFile(item.workbook, item.uploadFileName);
                onDownloaded?.(item.companyName);
                return prev.map(i => i.id === id ? { ...i, downloaded: true } : i);
            }
            return prev;
        });
    }, []);

    const downloadAll = useCallback((onDownloaded?: (companyName: string) => void) => {
        const bizShort = getBusinessInfo(businessId ?? '')?.displayName || '';
        setItems(prev => {
            const doneItems = prev.filter(i => i.status === 'done' && i.workbook);
            if (doneItems.length === 0) return prev;

            let header: any[] | null = null;
            const allRows: any[][] = [];
            for (const item of doneItems) {
                const ws = item.workbook.Sheets[item.workbook.SheetNames[0]];
                const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
                if (aoa.length < 1) continue;
                if (!header) header = aoa[0];
                for (let i = 1; i < aoa.length; i++) {
                    if (aoa[i]?.some((c: any) => c != null && c !== '')) allRows.push(aoa[i]);
                }
            }
            if (!header || allRows.length === 0) return prev;

            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...allRows]), '업로드용');
            const d = new Date();
            const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            XLSX.writeFile(wb, `${dateStr}_${bizShort ? bizShort + '_' : ''}통합[송장].xlsx`);

            doneItems.forEach(item => onDownloaded?.(item.companyName));
            return prev.map(i => i.status === 'done' ? { ...i, downloaded: true } : i);
        });
    }, [businessId]);

    const clearCompleted = useCallback(() => {
        setItems(prev => prev.filter(i => i.status !== 'done' || !i.downloaded));
    }, []);

    const clearAll = useCallback(() => {
        setItems([]);
        queueRef.current = [];
        setIsProcessing(false);
    }, []);

    return { items, addFiles, downloadItem, downloadAll, clearCompleted, clearAll, isProcessing };
};
