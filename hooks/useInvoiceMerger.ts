
import { useState, useCallback } from 'react';
import type { ProcessingStatus } from '../types';
import { getKeywordsForCompany } from './useConsolidatedOrderConverter';

declare var XLSX: any;

const GROUP_ID_COL_IDX = 10; // K열

const normalizeValue = (val: any): string => val == null ? '' : String(val).replace(/\s+/g, '').trim().toUpperCase();
const normalizeOrderNum = (val: any): string => {
    if (val == null) return '';
    let str = String(val).trim();
    if (str.endsWith('.0')) str = str.substring(0, str.length - 2);
    return str.replace(/[^A-Z0-9]/gi, '').toUpperCase();
};

const findColIdx = (row: any[], keywords: string[]): number => {
    if (!row) return -1;
    return row.findIndex(cell => {
        const val = String(cell || '').replace(/\s+/g, '').toLowerCase();
        return keywords.some(k => val.includes(k.toLowerCase()));
    });
};

const getCourierName = (companyName: string) => {
    if (companyName === '신선마켓' || companyName === '귤_신선' || companyName === '고랭지김치') return '롯데택배';
    if (['홍게', '홍게2', '귤_초록', '꽃게', '답도', '한라봉_답도'].includes(companyName)) return 'CJ 대한통운';
    if (companyName === '제이제이' || companyName === '귤_제이') return '한진택배';
    if (companyName === '웰그린' || companyName === '팜플로우') return '롯데택배';
    return '우체국';
};

export interface FailureDetail {
    orderNum: string;
    recipient: string;
    reason: string;
}

export interface CompanyStat {
    mgmt: number;
    upload: number;
    failures: FailureDetail[];
}

export interface ProcessedResult {
    mgmtWorkbook: any;
    uploadWorkbook: any;
    mgmtFileName: string;
    uploadFileName: string;
    companyStats?: Record<string, CompanyStat>;
    header: any[]; // 원본 헤더 추가
    rows: any[][]; // 송장 시트 통합을 위한 로우 데이터 (기록용)
    uploadRows: any[][]; // 업로드용 병합을 위한 로우 데이터
}

export const useInvoiceMerger = () => {
    const [status, setStatus] = useState<ProcessingStatus>('idle');
    const [error, setError] = useState<string | null>(null);
    const [results, setResults] = useState<ProcessedResult | null>(null);

    const buildInvoiceMap = async (vendorData: ArrayBuffer, companyName: string) => {
        const vendorWorkbook = XLSX.read(vendorData, { type: 'array' });
        const vendorSheet = vendorWorkbook.Sheets[vendorWorkbook.SheetNames[0]];
        const vendorAoa: any[][] = XLSX.utils.sheet_to_json(vendorSheet, { header: 1 });
        if (!vendorAoa || vendorAoa.length === 0) return new Map<string, string[]>();

        let vOrderIdx = -1, vInvIdx = -1;
        if (companyName === '고랭지김치') { vOrderIdx = 9; vInvIdx = 6; }
        else if (['연두', '총각김치', '포기김치', '배추김치', '총각김치,포기김치'].includes(companyName)) { vOrderIdx = 9; vInvIdx = 4; }
        else if (companyName === '제이제이' || companyName === '귤_제이') { vOrderIdx = 8; vInvIdx = 10; }
        else if (companyName === '신선마켓' || companyName === '귤_신선') { vOrderIdx = 3; vInvIdx = 17; }
        else if (companyName === '귤_초록') { vOrderIdx = 15; vInvIdx = 6; }
        else if (companyName === '답도' || companyName === '한라봉_답도') { vOrderIdx = 0; vInvIdx = 10; }
        else {
            let vHeaderIdx = 0;
            for (let i = 0; i < Math.min(vendorAoa.length, 20); i++) {
                const rowStr = (vendorAoa[i] || []).join('');
                if (rowStr.includes('번호') || rowStr.includes('송장')) { vHeaderIdx = i; break; }
            }
            const vHeaders = vendorAoa[vHeaderIdx] || [];
            vOrderIdx = findColIdx(vHeaders, ['주문번호', '관리번호', 'ID']);
            vInvIdx = findColIdx(vHeaders, ['송장', '운송장', '등기']);
            if (vOrderIdx === -1) vOrderIdx = 0;
        }

        const invoiceMap = new Map<string, string[]>();
        for (const row of vendorAoa) {
            if (!row || row.length <= Math.max(vOrderIdx, vInvIdx)) continue;
            const key = normalizeOrderNum(row[vOrderIdx]);
            const val = normalizeValue(row[vInvIdx]);
            if (key && val.length >= 5) {
                const existing = invoiceMap.get(key) || [];
                if (!existing.includes(val)) invoiceMap.set(key, [...existing, val]);
            }
        }
        return invoiceMap;
    };

    const processFiles = useCallback(async (vendorFile: File, orderFile: File, companyName: string, skipGroupCheck: boolean = true) => {
        try {
            setStatus('processing'); setError(null);
            const orderWb = XLSX.read(await orderFile.arrayBuffer(), { type: 'array' });
            const orderAoa: any[][] = XLSX.utils.sheet_to_json(orderWb.Sheets[orderWb.SheetNames[0]], { header: 1 });
            let headerIdx = 0;
            for (let i = 0; i < Math.min(orderAoa.length, 30); i++) if ((orderAoa[i] || []).join('').includes('주문번호')) { headerIdx = i; break; }
            
            const invoiceMap = await buildInvoiceMap(await vendorFile.arrayBuffer(), companyName);
            const orderHeader = orderAoa[headerIdx];
            const isCustomIdx = ['연두', '총각김치', '포기김치', '배추김치', '총각김치,포기김치', '고랭지김치', '제이제이', '귤_제이', '신선마켓', '귤_신선', '귤_초록', '답도', '한라봉_답도', '팜플로우', '웰그린'].includes(companyName);
            let targetOrderIdx = isCustomIdx ? 2 : findColIdx(orderHeader, ['주문번호']);
            let targetInvIdx = isCustomIdx ? 4 : findColIdx(orderHeader, ['운송장', '송장번호']);
            let targetCourierIdx = isCustomIdx ? 3 : findColIdx(orderHeader, ['택배사', '배송사']);
            let targetQtyIdx = findColIdx(orderHeader, ['수량']);

            if (targetOrderIdx === -1) {
                throw new Error("주문서에서 '주문번호' 열을 찾을 수 없습니다.");
            }

            const mgmtRows: any[][] = [orderHeader];
            const uploadRows: any[][] = [orderHeader];
            let uploadCount = 0, mgmtCount = 0;
            const failures: FailureDetail[] = [];

            const targetKeywords = getKeywordsForCompany(companyName);

            for (let i = headerIdx + 1; i < orderAoa.length; i++) {
                const row = orderAoa[i]; if (!row) continue;
                
                if (!skipGroupCheck) {
                    // 공백 제거 비교
                    const rowGroupValue = String(row[GROUP_ID_COL_IDX] || '').replace(/\s+/g, '');
                    const isGroupMatched = targetKeywords.some(k => rowGroupValue.includes(k.replace(/\s+/g, '')));
                    if (!isGroupMatched) continue;
                }
                
                const orderNum = normalizeOrderNum(row[targetOrderIdx]);
                const invoices = invoiceMap.get(orderNum);
                if (invoices && invoices.length > 0) {
                    uploadCount++;
                    invoices.forEach(inv => {
                        mgmtCount++; const newRow = [...row]; 
                        if (targetInvIdx !== -1) newRow[targetInvIdx] = inv;
                        if (targetCourierIdx !== -1) newRow[targetCourierIdx] = getCourierName(companyName);
                        if (invoices.length > 1 && targetQtyIdx !== -1) newRow[targetQtyIdx] = 1;
                        mgmtRows.push(newRow);
                    });
                    const upRow = [...row]; 
                    if (targetInvIdx !== -1) upRow[targetInvIdx] = invoices[0];
                    if (targetCourierIdx !== -1) upRow[targetCourierIdx] = getCourierName(companyName);
                    uploadRows.push(upRow);
                } else {
                    failures.push({ orderNum, recipient: String(row[26] || '알수없음'), reason: '송장 미매칭' });
                }
            }
            const mgmtWb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(mgmtWb, XLSX.utils.aoa_to_sheet(mgmtRows), "기록용");
            const uploadWb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(uploadWb, XLSX.utils.aoa_to_sheet(uploadRows), "업로드용");
            const dateStr = new Date().toISOString().slice(0, 10);
            setResults({ 
                mgmtWorkbook: mgmtWb, 
                uploadWorkbook: uploadWb, 
                mgmtFileName: `${dateStr} [${companyName}] 기록용_송장.xlsx`, 
                uploadFileName: `${dateStr} [${companyName}] 업로드용_송장.xlsx`, 
                companyStats: { [companyName]: { mgmt: mgmtCount, upload: uploadCount, failures } }, 
                header: orderHeader,
                rows: mgmtRows.slice(1),
                uploadRows: uploadRows.slice(1)
            });
            setStatus('success');
        } catch (err: any) { 
            console.error("Merge Error:", err);
            setError(err.message); 
            setStatus('error'); 
        }
    }, []);

    const reset = () => { setStatus('idle'); setError(null); setResults(null); };
    return { status, error, processFiles, reset, results };
};
