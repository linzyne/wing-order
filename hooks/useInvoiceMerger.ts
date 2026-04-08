
import { useState, useCallback } from 'react';
import type { ProcessingStatus, PricingConfig, PlatformConfigs } from '../types';
import { getBusinessInfo } from '../types';
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

const getCourierName = (companyName: string, pricingConfig?: PricingConfig) => {
    // 설정에서 택배사명이 지정되어 있으면 사용
    if (pricingConfig?.[companyName]?.courierName) {
        return pricingConfig[companyName].courierName;
    }
    // 폴백: 기존 하드코딩 로직
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

export interface PlatformUploadResult {
    workbook: any;
    fileName: string;
    count: number;
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
    platformUploadWorkbooks?: Record<string, PlatformUploadResult>; // 플랫폼별 업로드 파일
}

export const useInvoiceMerger = () => {
    const [status, setStatus] = useState<ProcessingStatus>('idle');
    const [error, setError] = useState<string | null>(null);
    const [results, setResults] = useState<ProcessedResult | null>(null);

    const buildInvoiceMap = async (vendorData: ArrayBuffer, companyName: string, pricingConfig?: PricingConfig) => {
        const vendorWorkbook = XLSX.read(vendorData, { type: 'array' });
        const vendorSheet = vendorWorkbook.Sheets[vendorWorkbook.SheetNames[0]];
        const vendorAoa: any[][] = XLSX.utils.sheet_to_json(vendorSheet, { header: 1 });
        if (!vendorAoa || vendorAoa.length === 0) return new Map<string, string[]>();

        let vOrderIdx = -1, vInvIdx = -1;
        const vendorConfig = pricingConfig?.[companyName];
        if (vendorConfig?.vendorInvoiceFieldMap && vendorConfig.vendorInvoiceFieldMap.length > 0) {
            vOrderIdx = vendorConfig.vendorInvoiceFieldMap.indexOf('orderNumber');
            vInvIdx = vendorConfig.vendorInvoiceFieldMap.indexOf('trackingNumber');
            if (vOrderIdx === -1) vOrderIdx = 0;
        } else if (companyName === '고랭지김치') { vOrderIdx = 9; vInvIdx = 6; }
        else if (['연두', '총각김치', '포기김치', '배추김치', '총각김치,포기김치'].includes(companyName)) { vOrderIdx = 9; vInvIdx = 4; }
        else if (companyName === '제이제이' || companyName === '귤_제이') { vOrderIdx = 8; vInvIdx = 10; }
        else if (companyName === '신선마켓' || companyName === '귤_신선') { vOrderIdx = 3; vInvIdx = 17; }
        else if (companyName === '귤_초록') { vOrderIdx = 15; vInvIdx = 6; }
        else if (companyName === '답도' || companyName === '한라봉_답도') { vOrderIdx = 0; vInvIdx = 10; }
        else {
            let vHeaderIdx = 0;
            for (let i = 0; i < Math.min(vendorAoa.length, 20); i++) {
                const rowStr = (vendorAoa[i] || []).join('');
                if (rowStr.includes('번호') || rowStr.includes('송장') || rowStr.includes('운송장') || rowStr.includes('접수')) { vHeaderIdx = i; break; }
            }
            const vHeaders = vendorAoa[vHeaderIdx] || [];
            vOrderIdx = findColIdx(vHeaders, ['주문번호', '관리번호', 'ID', '오더번호', '오더넘버', '접수번호', '고객주문번호']);
            vInvIdx = findColIdx(vHeaders, ['송장', '운송장', '등기', '장번호', '배송번호', '화물추적', '트래킹', 'tracking', 'invoice']);
            if (vOrderIdx === -1) vOrderIdx = 0;

            // 헤더에서 송장번호 컬럼을 못 찾으면 데이터에서 자동 감지 (10자리 이상 숫자)
            if (vInvIdx === -1) {
                for (let ri = vHeaderIdx + 1; ri < Math.min(vendorAoa.length, vHeaderIdx + 5); ri++) {
                    const dataRow = vendorAoa[ri];
                    if (!dataRow) continue;
                    for (let ci = 0; ci < dataRow.length; ci++) {
                        if (ci === vOrderIdx) continue;
                        const cellVal = String(dataRow[ci] || '').replace(/\s/g, '');
                        if (/^\d{10,}$/.test(cellVal)) { vInvIdx = ci; break; }
                    }
                    if (vInvIdx !== -1) break;
                }
            }
        }

        const invoiceMap = new Map<string, string[]>();
        console.log(`[송장디버그] 업체: ${companyName}, vOrderIdx: ${vOrderIdx}, vInvIdx: ${vInvIdx}`);
        console.log(`[송장디버그] 송장파일 헤더(첫 행):`, vendorAoa[0]);
        console.log(`[송장디버그] 송장파일 총 행수: ${vendorAoa.length}`);
        if (vendorAoa.length > 1) console.log(`[송장디버그] 송장파일 데이터 샘플(2행):`, vendorAoa[1]);
        for (const row of vendorAoa) {
            if (!row || row.length <= Math.max(vOrderIdx, vInvIdx)) continue;
            const key = normalizeOrderNum(row[vOrderIdx]);
            const val = normalizeValue(row[vInvIdx]);
            if (key && val.length >= 5) {
                const existing = invoiceMap.get(key) || [];
                if (!existing.includes(val)) invoiceMap.set(key, [...existing, val]);
            }
        }
        console.log(`[송장디버그] invoiceMap 크기: ${invoiceMap.size}`);
        if (invoiceMap.size > 0) {
            const sample = Array.from(invoiceMap.entries()).slice(0, 3);
            console.log(`[송장디버그] invoiceMap 샘플:`, sample);
        }
        return invoiceMap;
    };

    const processFiles = useCallback(async (vendorFile: File, orderFile: File, companyName: string, skipGroupCheck: boolean = true, pricingConfig?: PricingConfig, orderPlatformMap?: Map<string, string>, platformConfigs?: PlatformConfigs, businessId?: string) => {
        try {
            setStatus('processing'); setError(null);
            const bizShort = getBusinessInfo(businessId ?? '')?.shortName || '';
            const orderWb = XLSX.read(await orderFile.arrayBuffer(), { type: 'array' });
            const orderAoa: any[][] = XLSX.utils.sheet_to_json(orderWb.Sheets[orderWb.SheetNames[0]], { header: 1 });
            let headerIdx = 0;
            for (let i = 0; i < Math.min(orderAoa.length, 30); i++) {
                const rowStr = (orderAoa[i] || []).join('');
                if (rowStr.includes('주문번호') || rowStr.includes('주문정보') || rowStr.includes('받는분') || rowStr.includes('수취인')) { headerIdx = i; break; }
            }

            const invoiceMap = await buildInvoiceMap(await vendorFile.arrayBuffer(), companyName, pricingConfig);
            console.log(`[송장디버그] processFiles - 업체: ${companyName}, businessId: ${businessId}`);
            console.log(`[송장디버그] 주문서 총 행수: ${orderAoa.length}, headerIdx: ${headerIdx}`);
            console.log(`[송장디버그] 주문서 헤더:`, orderAoa[headerIdx]);

            // 송장 양식 헤더가 있으면 사용, 없으면 발주서 헤더 사용
            const companyConfig = pricingConfig?.[companyName];
            const useCustomInvoiceHeaders = companyConfig?.invoiceHeaders && companyConfig.invoiceHeaders.length > 0;
            const orderHeader = orderAoa[headerIdx];
            const invoiceHeader = useCustomInvoiceHeaders ? companyConfig.invoiceHeaders! : orderHeader;

            const isCustomIdx = ['연두', '총각김치', '포기김치', '배추김치', '총각김치,포기김치', '고랭지김치', '제이제이', '귤_제이', '신선마켓', '귤_신선', '귤_초록', '답도', '한라봉_답도', '팜플로우', '웰그린'].includes(companyName);
            let targetOrderIdx = isCustomIdx ? 2 : findColIdx(orderHeader, ['주문번호', '주문정보', '오더번호', '접수번호']);
            let targetInvIdx = isCustomIdx ? 4 : findColIdx(invoiceHeader, ['운송장', '송장번호', '송장']);
            let targetCourierIdx = isCustomIdx ? 3 : findColIdx(invoiceHeader, ['택배사', '배송사']);
            let targetQtyIdx = findColIdx(orderHeader, ['수량']);

            if (targetOrderIdx === -1) {
                throw new Error("주문서에서 '주문번호' 열을 찾을 수 없습니다.");
            }

            // 헤더 매핑: 발주서 헤더 → 송장 헤더 인덱스 매핑
            const headerMapping: Record<number, number> = {};
            if (useCustomInvoiceHeaders) {
                for (let i = 0; i < orderHeader.length; i++) {
                    const orderColName = String(orderHeader[i] || '').toLowerCase().trim();
                    for (let j = 0; j < invoiceHeader.length; j++) {
                        const invColName = String(invoiceHeader[j] || '').toLowerCase().trim();
                        if (orderColName === invColName ||
                            (orderColName.includes('받는') && invColName.includes('받는')) ||
                            (orderColName.includes('전화') && invColName.includes('전화')) ||
                            (orderColName.includes('주소') && invColName.includes('주소')) ||
                            (orderColName.includes('상품') && invColName.includes('상품')) ||
                            (orderColName.includes('품목') && invColName.includes('품목')) ||
                            (orderColName.includes('수량') && invColName.includes('수량')) ||
                            (orderColName.includes('주문') && invColName.includes('주문')) ||
                            (orderColName.includes('배송') && invColName.includes('배송'))) {
                            headerMapping[i] = j;
                            break;
                        }
                    }
                }
            }

            const mgmtRows: any[][] = [invoiceHeader];
            const uploadRows: any[][] = [invoiceHeader];
            let uploadCount = 0, mgmtCount = 0;
            const failures: FailureDetail[] = [];
            // 플랫폼별 업로드 데이터 (플랫폼명 → 데이터 행 배열)
            const platformUploadData: Record<string, any[][]> = {};

            const targetKeywords = getKeywordsForCompany(companyName, pricingConfig);
            console.log(`[송장디버그] targetOrderIdx: ${targetOrderIdx}, targetInvIdx: ${targetInvIdx}, isCustomIdx: ${isCustomIdx}`);
            console.log(`[송장디버그] skipGroupCheck: ${skipGroupCheck}, targetKeywords:`, targetKeywords);

            let debugSkippedByGroup = 0;
            let debugSkippedNoInvoice = 0;
            let debugMatched = 0;

            for (let i = headerIdx + 1; i < orderAoa.length; i++) {
                const row = orderAoa[i]; if (!row) continue;

                if (!skipGroupCheck) {
                    const rowGroupValue = String(row[GROUP_ID_COL_IDX] || '').replace(/\s+/g, '');
                    const isGroupMatched = targetKeywords.some(k => rowGroupValue.includes(k.replace(/\s+/g, '')));
                    if (!isGroupMatched) { debugSkippedByGroup++; continue; }
                }

                const orderNum = normalizeOrderNum(row[targetOrderIdx]);
                const invoices = invoiceMap.get(orderNum);
                if (invoices && invoices.length > 0) {
                    debugMatched++;
                    uploadCount++;
                    invoices.forEach(inv => {
                        mgmtCount++;
                        let newRow: any[];

                        // 커스텀 헤더 사용 시 데이터 재배치
                        if (useCustomInvoiceHeaders) {
                            newRow = new Array(invoiceHeader.length).fill('');
                            // 발주서 데이터를 송장 헤더에 매핑
                            for (let oldIdx = 0; oldIdx < row.length; oldIdx++) {
                                const newIdx = headerMapping[oldIdx];
                                if (newIdx !== undefined) {
                                    newRow[newIdx] = row[oldIdx];
                                }
                            }
                        } else {
                            newRow = [...row];
                        }

                        if (targetInvIdx !== -1) newRow[targetInvIdx] = inv;
                        if (targetCourierIdx !== -1) newRow[targetCourierIdx] = getCourierName(companyName, pricingConfig);
                        if (invoices.length > 1 && targetQtyIdx !== -1) newRow[targetQtyIdx] = 1;
                        mgmtRows.push(newRow);
                    });

                    // 플랫폼별 업로드 행 분기
                    const rowPlatform = orderPlatformMap?.get(orderNum) || null;
                    if (rowPlatform && platformConfigs?.[rowPlatform]?.invoiceColumns) {
                        // 비-쿠팡 플랫폼: 해당 플랫폼 양식으로 업로드 행 생성
                        const invMapping = platformConfigs[rowPlatform].invoiceColumns!;
                        const maxCol = Math.max(invMapping.orderNumber, invMapping.trackingNumber, invMapping.courierName ?? 0) + 1;
                        const pRow = new Array(maxCol).fill('');
                        pRow[invMapping.orderNumber] = row[targetOrderIdx];
                        pRow[invMapping.trackingNumber] = invoices[0];
                        if (invMapping.courierName !== undefined) pRow[invMapping.courierName] = getCourierName(companyName, pricingConfig);
                        if (!platformUploadData[rowPlatform]) platformUploadData[rowPlatform] = [];
                        platformUploadData[rowPlatform].push(pRow);
                    } else {
                        // 쿠팡 (기본): 기존 로직 그대로
                        let upRow: any[];
                        if (useCustomInvoiceHeaders) {
                            upRow = new Array(invoiceHeader.length).fill('');
                            for (let oldIdx = 0; oldIdx < row.length; oldIdx++) {
                                const newIdx = headerMapping[oldIdx];
                                if (newIdx !== undefined) {
                                    upRow[newIdx] = row[oldIdx];
                                }
                            }
                        } else {
                            upRow = [...row];
                        }

                        if (targetInvIdx !== -1) upRow[targetInvIdx] = invoices[0];
                        if (targetCourierIdx !== -1) upRow[targetCourierIdx] = getCourierName(companyName, pricingConfig);
                        uploadRows.push(upRow);
                    }
                } else {
                    failures.push({ orderNum, recipient: String(row[26] || '알수없음'), reason: '송장 미매칭' });
                }
            }

            // 플랫폼별 업로드 워크북 생성
            const platformUploadWorkbooks: Record<string, PlatformUploadResult> = {};
            const now = new Date();
            const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            for (const [platform, rows] of Object.entries(platformUploadData)) {
                const invMapping = platformConfigs![platform].invoiceColumns!;
                const invSampleHeaders = platformConfigs![platform].sampleHeaders;
                let pHeader: any[];
                if (invSampleHeaders && invSampleHeaders.length > 0) {
                    // 실제 송장 업로드 양식 헤더 사용
                    pHeader = [...invSampleHeaders];
                    // 데이터 행도 양식 길이에 맞춤
                    const fullRows = rows.map(r => {
                        const full = new Array(pHeader.length).fill('');
                        for (let c = 0; c < r.length && c < full.length; c++) full[c] = r[c];
                        return full;
                    });
                    rows.splice(0, rows.length, ...fullRows);
                } else {
                    const maxCol = Math.max(invMapping.orderNumber, invMapping.trackingNumber, invMapping.courierName ?? 0) + 1;
                    pHeader = new Array(maxCol).fill('');
                    pHeader[invMapping.orderNumber] = '주문번호';
                    pHeader[invMapping.trackingNumber] = '운송장번호';
                    if (invMapping.courierName !== undefined) pHeader[invMapping.courierName] = '택배사';
                }
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([pHeader, ...rows]), '업로드용');
                platformUploadWorkbooks[platform] = {
                    workbook: wb,
                    fileName: `${dateStr} [${bizShort ? bizShort + ' ' : ''}${companyName}] ${platform}_업로드용_송장.xlsx`,
                    count: rows.length
                };
            }

            const mgmtWb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(mgmtWb, XLSX.utils.aoa_to_sheet(mgmtRows), "기록용");
            const uploadWb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(uploadWb, XLSX.utils.aoa_to_sheet(uploadRows), "업로드용");
            setResults({
                mgmtWorkbook: mgmtWb,
                uploadWorkbook: uploadWb,
                mgmtFileName: `${dateStr} [${bizShort ? bizShort + ' ' : ''}${companyName}] 기록용_송장.xlsx`,
                uploadFileName: `${dateStr} [${bizShort ? bizShort + ' ' : ''}${companyName}] 업로드용_송장.xlsx`,
                companyStats: { [companyName]: { mgmt: mgmtCount, upload: uploadCount, failures } },
                header: invoiceHeader,
                rows: mgmtRows.slice(1),
                uploadRows: uploadRows.slice(1),
                platformUploadWorkbooks: Object.keys(platformUploadWorkbooks).length > 0 ? platformUploadWorkbooks : undefined
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
