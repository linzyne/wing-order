
import { useState, useCallback } from 'react';

export interface BatchInvoiceRecord {
    id: string;
    recordedAt: string;
    businessId?: string;
    entries: { companyName: string; uploadCount: number }[];
    totalCount: number;
}

const getKey = (businessId?: string) =>
    businessId ? `batchInvoiceHistory_${businessId}` : 'batchInvoiceHistory';

export const useBatchInvoiceHistory = (businessId?: string) => {
    const key = getKey(businessId);

    const [history, setHistory] = useState<BatchInvoiceRecord[]>(() => {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : [];
        } catch {
            return [];
        }
    });

    const addRecord = useCallback(
        (entries: { companyName: string; uploadCount: number }[]) => {
            const record: BatchInvoiceRecord = {
                id: Date.now().toString(),
                recordedAt: new Date().toISOString(),
                businessId,
                entries,
                totalCount: entries.reduce((s, e) => s + e.uploadCount, 0),
            };
            setHistory(prev => {
                const next = [record, ...prev];
                localStorage.setItem(key, JSON.stringify(next));
                return next;
            });
            return record;
        },
        [key, businessId]
    );

    const removeRecord = useCallback(
        (id: string) => {
            setHistory(prev => {
                const next = prev.filter(r => r.id !== id);
                localStorage.setItem(key, JSON.stringify(next));
                return next;
            });
        },
        [key]
    );

    const clearHistory = useCallback(() => {
        setHistory([]);
        localStorage.removeItem(key);
    }, [key]);

    return { history, addRecord, removeRecord, clearHistory };
};
