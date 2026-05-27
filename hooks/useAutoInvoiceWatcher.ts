
import { useState, useRef, useEffect, useCallback } from 'react';
import { useInvoiceMerger } from './useInvoiceMerger';
import { getKeywordsForCompany } from './useConsolidatedOrderConverter';
import { appendInvoiceRows } from '../services/firestoreService';
import type { PricingConfig } from '../types';

declare var XLSX: any;

export interface WatchLogEntry {
    id: number;
    time: string;
    fileName: string;
    status: 'success' | 'error';
    message: string;
    uploadCount?: number;
}

const normalizeNum = (val: any): string =>
    String(val ?? '').replace(/\.0$/, '').replace(/[^A-Z0-9]/gi, '').toUpperCase();

/** 업체 송장파일의 주문번호를 마스터 주문서 B열(묶음배송번호)과 매칭해 업체명 감지 */
const detectCompanyName = async (
    vendorFile: File,
    masterOrderFile: File,
    activeCompanies: string[],
    pricingConfig: PricingConfig,
): Promise<string> => {
    const [vendorBuf, masterBuf] = await Promise.all([
        vendorFile.arrayBuffer(),
        masterOrderFile.arrayBuffer(),
    ]);

    const vendorAoa: any[][] = XLSX.utils.sheet_to_json(
        XLSX.read(vendorBuf, { type: 'array' }).Sheets[XLSX.read(vendorBuf, { type: 'array' }).SheetNames[0]],
        { header: 1 }
    );
    const masterAoa: any[][] = XLSX.utils.sheet_to_json(
        XLSX.read(masterBuf, { type: 'array' }).Sheets[XLSX.read(masterBuf, { type: 'array' }).SheetNames[0]],
        { header: 1 }
    );

    // 업체 파일 헤더 및 주문번호 열 감지
    let vHeaderIdx = 0;
    for (let i = 0; i < Math.min(vendorAoa.length, 20); i++) {
        const r = (vendorAoa[i] || []).join('');
        if (r.includes('번호') || r.includes('주문') || r.includes('송장')) { vHeaderIdx = i; break; }
    }
    const vHeaders = vendorAoa[vHeaderIdx] || [];
    let vOrderIdx = vHeaders.findIndex((h: any) => {
        const v = String(h || '').replace(/\s/g, '').toLowerCase();
        return v.includes('주문번호') || v.includes('관리번호') || v.includes('묶음배송');
    });
    if (vOrderIdx === -1) vOrderIdx = 0;

    // 업체 파일에서 주문번호 샘플 추출
    const vendorNums = new Set<string>();
    for (let i = vHeaderIdx + 1; i < vendorAoa.length && vendorNums.size < 20; i++) {
        const row = vendorAoa[i];
        if (!row) continue;
        const num = normalizeNum(row[vOrderIdx]);
        if (num.length >= 5) vendorNums.add(num);
    }
    if (vendorNums.size === 0) return '';

    // 마스터 주문서 헤더 행 탐색
    let mHeaderIdx = 0;
    for (let i = 0; i < Math.min(masterAoa.length, 30); i++) {
        const r = (masterAoa[i] || []).join('');
        if (r.includes('주문번호') || r.includes('수취인') || r.includes('묶음배송')) { mHeaderIdx = i; break; }
    }

    // 각 activeCompany의 키워드 맵 생성
    const companyKeywords = new Map<string, string[]>();
    for (const company of activeCompanies) {
        companyKeywords.set(company, getKeywordsForCompany(company, pricingConfig));
    }

    // B열(index 1) 묶음배송번호로 매칭 → K열(10)/L열(11) 키워드로 업체 카운트
    const counts: Record<string, number> = {};
    for (let i = mHeaderIdx + 1; i < masterAoa.length; i++) {
        const row = masterAoa[i];
        if (!row) continue;
        const bundleNum = normalizeNum(row[1]);
        if (!bundleNum || !vendorNums.has(bundleNum)) continue;

        const groupVal = (String(row[10] || '') + ' ' + String(row[11] || ''))
            .replace(/\s+/g, '').normalize('NFC');

        let matched = '';
        let bestPos = Infinity;
        for (const [company, keywords] of companyKeywords.entries()) {
            for (const k of keywords) {
                const pos = groupVal.indexOf(k.replace(/\s+/g, '').normalize('NFC'));
                if (pos !== -1 && pos < bestPos) {
                    bestPos = pos;
                    matched = company;
                }
            }
        }
        if (matched) counts[matched] = (counts[matched] || 0) + 1;
    }

    const entries = Object.entries(counts);
    if (entries.length === 0) return '';
    return entries.sort((a, b) => b[1] - a[1])[0][0];
};

export const useAutoInvoiceWatcher = (masterOrderFile: File | null, pricingConfig: PricingConfig, activeCompanies: string[], businessId?: string) => {
    const { processFiles, results, status: mergeStatus, error: mergeError, reset: resetMerger } = useInvoiceMerger();
    const [watching, setWatching] = useState(false);
    const [folderName, setFolderName] = useState('');
    const [log, setLog] = useState<WatchLogEntry[]>([]);
    const [saving, setSaving] = useState(false);
    const [pendingCount, setPendingCount] = useState(0);

    const baseDirRef = useRef<any>(null);
    const seenRef = useRef<Set<string>>(new Set());
    const intervalRef = useRef<number | null>(null);
    const pendingRef = useRef<{ baseDir: any; fileName: string } | null>(null);
    const handlingRef = useRef(false);
    const mergeStatusRef = useRef(mergeStatus);
    const logIdRef = useRef(0);
    const pendingInvoiceRowsRef = useRef<any[][]>([]);

    mergeStatusRef.current = mergeStatus;

    const addLog = useCallback((entry: Omit<WatchLogEntry, 'id' | 'time'>) => {
        const now = new Date();
        const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        setLog(prev => [{ id: ++logIdRef.current, time, ...entry }, ...prev].slice(0, 30));
    }, []);

    const getTodayStr = () => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    // 병합 완료 시 파일 저장
    useEffect(() => {
        if (handlingRef.current) return;
        if (!pendingRef.current) return;
        if (mergeStatus !== 'success' && mergeStatus !== 'error') return;

        handlingRef.current = true;
        const { baseDir, fileName } = pendingRef.current;
        pendingRef.current = null;

        (async () => {
            if (mergeStatus === 'error') {
                addLog({ fileName, status: 'error', message: mergeError || '처리 실패' });
                return;
            }
            if (!results) return;

            const uploadCount = results.companyStats
                ? Object.values(results.companyStats).reduce((s, c: any) => s + c.upload, 0)
                : 0;

            try {
                // 완료 폴더에 출력 파일 저장
                const doneDir = await baseDir.getDirectoryHandle('완료', { create: true });
                const now = new Date();
                const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
                const outputName = `${getTodayStr()}_${timeStr}_업로드용.xlsx`;

                const xlsxData: ArrayBuffer = XLSX.write(results.uploadWorkbook, { bookType: 'xlsx', type: 'array' });
                const outHandle = await doneDir.getFileHandle(outputName, { create: true });
                const writable = await outHandle.createWritable();
                await writable.write(xlsxData);
                await writable.close();

                // 원본 파일: 기본 폴더에 ✓_ 붙여 이름 변경 (이동 없음)
                const origHandle = await baseDir.getFileHandle(fileName);
                const origData = await (await origHandle.getFile()).arrayBuffer();
                const checkHandle = await baseDir.getFileHandle(`✓_${fileName}`, { create: true });
                const checkWritable = await checkHandle.createWritable();
                await checkWritable.write(origData);
                await checkWritable.close();
                await baseDir.removeEntry(fileName);

                // 처리된 rows를 버퍼에 누적 (기록 버튼 누를 때 저장)
                if (results.rows.length > 0) {
                    pendingInvoiceRowsRef.current.push(results.header, ...results.rows);
                    setPendingCount(pendingInvoiceRowsRef.current.length);
                }

                if (Notification.permission === 'granted') {
                    new Notification('송장 처리 완료', {
                        body: `${fileName} → ${uploadCount}건 매칭\n완료/${outputName}`,
                    });
                }

                addLog({ fileName, status: 'success', message: `${uploadCount}건 매칭`, uploadCount });
            } catch (e: any) {
                addLog({ fileName, status: 'error', message: e.message || '저장 실패' });
                seenRef.current.delete(fileName);
            }
        })().finally(() => {
            handlingRef.current = false;
            resetMerger();
        });
    }, [mergeStatus]);

    const poll = useCallback(async () => {
        if (!baseDirRef.current || !masterOrderFile) return;
        if (mergeStatusRef.current === 'processing' || handlingRef.current) return;

        for await (const [name, handle] of baseDirRef.current.entries()) {
            if (handle.kind !== 'file') continue;
            const lname = (name as string).toLowerCase();
            if (!lname.endsWith('.xlsx') && !lname.endsWith('.xls')) continue;
            if ((name as string).startsWith('✓_')) continue;
            if (seenRef.current.has(name as string)) continue;

            seenRef.current.add(name as string);

            const file = await (handle as any).getFile();

            // 묶음배송번호로 업체 감지 → pricingConfig에서 택배사 조회
            const detectedCompany = await detectCompanyName(file, masterOrderFile, activeCompanies, pricingConfig);

            pendingRef.current = { baseDir: baseDirRef.current, fileName: name as string };
            processFiles(file, masterOrderFile, detectedCompany, true, pricingConfig);
            return;
        }
    }, [masterOrderFile, pricingConfig, activeCompanies, processFiles]);

    useEffect(() => {
        if (!watching) return;
        if (intervalRef.current !== null) clearInterval(intervalRef.current);
        intervalRef.current = window.setInterval(poll, 3000);
        return () => { if (intervalRef.current !== null) clearInterval(intervalRef.current); };
    }, [watching, poll]);

    useEffect(() => {
        return () => { if (intervalRef.current !== null) clearInterval(intervalRef.current); };
    }, []);

    const startWatching = useCallback(async () => {
        try {
            const dir = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
            baseDirRef.current = dir;
            seenRef.current.clear();
            setFolderName(dir.name);
            if (Notification.permission === 'default') {
                await Notification.requestPermission();
            }
            setWatching(true);
        } catch {
            // 사용자 취소
        }
    }, []);

    const stopWatching = useCallback(() => {
        if (intervalRef.current !== null) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
        setWatching(false);
    }, []);

    const saveToHistory = useCallback(async () => {
        const rows = pendingInvoiceRowsRef.current;
        if (rows.length === 0) return;
        setSaving(true);
        try {
            await appendInvoiceRows(getTodayStr(), rows, businessId);
            pendingInvoiceRowsRef.current = [];
            setPendingCount(0);
            addLog({ fileName: '송장내역', status: 'success', message: `${rows.length}행 기록 완료` });
        } catch (e: any) {
            addLog({ fileName: '송장내역', status: 'error', message: e.message || '기록 실패' });
        } finally {
            setSaving(false);
        }
    }, [businessId, addLog]);

    return { watching, folderName, log, startWatching, stopWatching, saveToHistory, saving, pendingCount };
};
