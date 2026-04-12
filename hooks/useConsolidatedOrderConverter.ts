
import { useState, useCallback, useEffect } from 'react';
import { GoogleGenAI } from "@google/genai";
import type { ProcessingStatus, AnalysisResult, PricingConfig, CompanyConfig, ProductPricing, ExcludedOrder, ManualOrder, UnmatchedOrder, OrderFormFieldKey, VendorInvoiceFieldKey } from '../types';
import { BUSINESS_INFO, getBusinessInfo } from '../types';
import { findProductConfig } from '../pricing';

declare var XLSX: any;

export interface OrderItem {
    registeredProductName: string; // 등록상품명 (원본 엑셀)
    registeredOptionName: string;  // 등록옵션명 (원본 엑셀)
    matchedProductKey: string;     // 매칭된 품목키 (summary 키와 동일)
    qty: number;
}

export type ProcessedResult = {
    workbook: any;
    fileName: string;
    summary: AnalysisResult;
    depositSummary: string;
    depositSummaryExcel: string;
    dailySummaries: { date: string, content: string }[];
    rows: any[][];
    registeredProductNames: Record<string, string>;
    orderItems: OrderItem[];
};

export const getKeywordsForCompany = (companyName: string, pricingConfig?: PricingConfig): string[] => {
    // 하드코딩 폴백 (기존 사용자 localStorage에 keywords 없을 때)
    const hardcoded: Record<string, string[]> = {
        '제이제이': ['귤_제이', '은갈치', '순살 갈치', '한라봉_J'],
        '귤_제이': ['귤_제이', '은갈치', '순살 갈치', '한라봉_J'],
        '연두': ['총각김치', '포기김치', '배추김치'],
        '답도': ['한라봉', '답도', '한라봉_답도'],
        '한라봉_답도': ['한라봉', '답도', '한라봉_답도'],
        '웰그린': ['구좌 당근', '과일선물세트', '부사 사과', '부사사과'],
        '팜플로우': ['과일선물세트'],
    };

    // config에 keywords가 있으면 우선 사용, 없으면 하드코딩 폴백
    const configKeywords = pricingConfig?.[companyName]?.keywords;
    const base = configKeywords && configKeywords.length > 0
        ? configKeywords
        : (hardcoded[companyName] || companyName.split(',').map(s => s.trim()));
    const keywords = new Set<string>(base);

    // pricingConfig에서 사용자가 설정한 aliases(별칭)도 동적으로 추가
    if (pricingConfig?.[companyName]?.products) {
        for (const product of Object.values(pricingConfig[companyName].products)) {
            if (product.aliases) product.aliases.forEach(a => { if (a) keywords.add(a); });
        }
    }

    return Array.from(keywords);
};

class StatsManager {
    total: Record<string, { count: number, totalPrice: number }> = {};
    daily: Record<string, Record<string, { count: number, totalPrice: number }>> = {};
    senderName: string;
    constructor(senderName: string = '안군농원') { this.senderName = senderName; }

    add(displayName: string, count: number, price: number, dateStr: string | null) {
        if (!this.total[displayName]) this.total[displayName] = { count: 0, totalPrice: 0 };
        this.total[displayName].count += count;
        this.total[displayName].totalPrice += count * price;

        if (dateStr) {
            if (!this.daily[dateStr]) this.daily[dateStr] = {};
            if (!this.daily[dateStr][displayName]) this.daily[dateStr][displayName] = { count: 0, totalPrice: 0 };
            this.daily[dateStr][displayName].count += count;
            this.daily[dateStr][displayName].totalPrice += count * price;
        }
    }

    generateText(data: Record<string, { count: number, totalPrice: number }>, title: string): string {
        const totalCount = Object.values(data).reduce((acc, curr) => acc + curr.count, 0);
        let grandTotal = 0;
        const lines = [title, `총주문수\t${totalCount}개`, ''];
        Object.entries(data)
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
            .forEach(([name, stat]) => {
                lines.push(`${name}\t${stat.count}개\t${stat.totalPrice.toLocaleString()}원`);
                grandTotal += stat.totalPrice;
            });
        lines.push('', `총 합계\t\t${grandTotal.toLocaleString()}원`, `(입금자 ${this.senderName})`);
        return lines.join('\n');
    }

    generateExcelText(data: Record<string, { count: number, totalPrice: number }>, title: string): string {
        const entries = Object.entries(data).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
        const totalCount = entries.reduce((acc, [, s]) => acc + s.count, 0);
        const grandTotal = entries.reduce((acc, [, s]) => acc + s.totalPrice, 0);
        const lines: string[] = [];
        entries.forEach(([name, stat], idx) => {
            let col1 = idx === 0 ? title : idx === 1 ? `총 ${totalCount}개` : '';
            let line = `${col1}\t${name}\t${stat.count}개\t${stat.totalPrice.toLocaleString()}`;
            if (idx === entries.length - 1) line += `\t${grandTotal.toLocaleString()}`;
            lines.push(line);
        });
        return lines.join('\n');
    }
}

const findHeaderRowIndex = (aoa: any[][]): number => {
    for (let i = 0; i < Math.min(aoa.length, 20); i++) {
        const row = aoa[i];
        if (!row) continue;
        const rowStr = row.join(' ').toLowerCase();
        if (rowStr.includes('주문번호') || (rowStr.includes('수취인') && rowStr.includes('전화번호')) || rowStr.includes('상품명') || rowStr.includes('그룹')) return i;
    }
    return 0;
};

const parseDateFromRow = (row: any[], dateColIdx: number): string | null => {
    if (dateColIdx === -1) return null;
    const val = row[dateColIdx];
    if (!val) return null;
    const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
    try {
        if (typeof val === 'number') {
            const d = new Date((val - 25569) * 86400 * 1000);
            return `${d.getMonth() + 1}/${d.getDate()} (${weekdays[d.getDay()]})`;
        }
        const date = new Date(String(val).trim());
        if (!isNaN(date.getTime())) return `${date.getMonth() + 1}/${date.getDate()} (${weekdays[date.getDay()]})`;
    } catch (e) { }
    return null;
};

const findBestMatchForProduct = async (
    ai: GoogleGenAI | null,
    cache: Map<string, [string, ProductPricing] | null>,
    companyName: string,
    rawProductName: string,
    companyProducts: { [productKey: string]: ProductPricing },
    fallbackMatcher: (config: PricingConfig, companyName: string, productName: string) => [string, ProductPricing & { margin: number }] | null,
    pricingConfig: PricingConfig
): Promise<[string, ProductPricing] | null> => {
    const cacheKey = `${companyName}::${rawProductName}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey)!;

    let availableEntries = Object.entries(companyProducts);
    if (availableEntries.length === 0) return null;

    if (companyName === '웰그린') {
        if (rawProductName.includes('A급')) {
            availableEntries = availableEntries.filter(([, p]) => p.displayName.includes('★A급'));
        } else {
            availableEntries = availableEntries.filter(([, p]) => !p.displayName.includes('★A급'));
        }
    }

    if (availableEntries.length === 1) return [availableEntries[0][0], availableEntries[0][1]];

    const lowerRaw = rawProductName.toLowerCase();

    // 0. 정확한 siteProductName 매칭 (가장 우선)
    // rawProductName에 siteProductName이 포함되어 있는지 확인
    let bestSiteMatch: { entry: [string, ProductPricing]; len: number } | null = null;
    for (const entry of availableEntries) {
        const siteName = entry[1].siteProductName;
        if (siteName && lowerRaw.includes(siteName.toLowerCase())) {
            if (!bestSiteMatch || siteName.length > bestSiteMatch.len) {
                bestSiteMatch = { entry, len: siteName.length };
            }
        }
    }
    if (bestSiteMatch) {
        const result: [string, ProductPricing] = [bestSiteMatch.entry[0], bestSiteMatch.entry[1]];
        cache.set(cacheKey, result);
        return result;
    }

    // aliases 매칭 (Legacy support)
    let bestAlias: { entry: [string, ProductPricing]; len: number } | null = null;
    for (const entry of availableEntries) {
        const aliases = entry[1].aliases;
        if (!aliases) continue;
        for (const alias of aliases) {
            if (alias && lowerRaw.includes(alias.toLowerCase())) {
                if (!bestAlias || alias.length > bestAlias.len) {
                    bestAlias = { entry, len: alias.length };
                }
            }
        }
    }
    if (bestAlias) {
        const result: [string, ProductPricing] = [bestAlias.entry[0], bestAlias.entry[1]];
        cache.set(cacheKey, result);
        return result;
    }

    // 정규화 매칭: 쉼표/마침표/공백/특수문자(★☆※) 차이를 무시하고 displayName으로 매칭
    const normalize = (s: string) => s.toLowerCase().replace(/[★☆※,.\s]/g, '');
    const normalizedRaw = normalize(rawProductName);
    let bestNormMatch: { entry: [string, ProductPricing]; len: number } | null = null;
    for (const entry of availableEntries) {
        const normDisplay = normalize(entry[1].displayName);
        if (normalizedRaw.includes(normDisplay)) {
            if (!bestNormMatch || normDisplay.length > bestNormMatch.len) {
                bestNormMatch = { entry, len: normDisplay.length };
            }
        }
    }
    if (bestNormMatch) {
        const result: [string, ProductPricing] = [bestNormMatch.entry[0], bestNormMatch.entry[1]];
        cache.set(cacheKey, result);
        return result;
    }

    if (ai) {
        const availableDisplayNames = availableEntries.map(([, product]) => product.displayName);
        const prompt = `주문서 상품명 '${rawProductName}'와 가장 일치하는 품목을 골라줘. 품목 리스트:\n${availableDisplayNames.join('\n')}\n정확한 이름만 답변해줘.`;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            const response = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: prompt,
                config: { temperature: 0 }
            });
            clearTimeout(timeout);
            const matchedDisplayName = response.text?.trim();
            const matchedEntry = availableEntries.find(([, product]) => product.displayName === matchedDisplayName);
            if (matchedEntry) {
                const result: [string, ProductPricing] = [matchedEntry[0], matchedEntry[1]];
                cache.set(cacheKey, result);
                return result;
            }
        } catch (e) {
            console.warn(`[매칭][${companyName}] AI 매칭 실패 (타임아웃/에러): '${rawProductName}'`, e);
        }
    }

    const fallbackResult = fallbackMatcher(pricingConfig, companyName, rawProductName);
    if (!fallbackResult) {
        console.warn(`[매칭][${companyName}] ⚠️ 매칭 완전 실패 - 발주서 누락됨: '${rawProductName}'`);
    }
    cache.set(cacheKey, fallbackResult as [string, ProductPricing] | null);
    return fallbackResult as [string, ProductPricing] | null;
};

const generateWorkbookForCompany = async (
    ai: GoogleGenAI | null,
    cache: Map<string, [string, ProductPricing] | null>,
    pricingConfig: PricingConfig,
    json: any[][],
    companyName: string,
    fakeOrderNumbers: Set<string>,
    excludedOrders: ExcludedOrder[],
    manualOrders: ManualOrder[] = [],
    unmatchedOrders: UnmatchedOrder[] = [],
    businessId?: string
): Promise<[string, ProcessedResult | null]> => {
    try {
        const companyConfig = pricingConfig[companyName];
        if (!companyConfig) return [companyName, null];

        const bizInfo = getBusinessInfo(businessId || '') || BUSINESS_INFO['안군농원'];
        const senderName = bizInfo.senderName;
        const senderPhone = bizInfo.phone;
        const senderAddress = bizInfo.address;
        const stats = new StatsManager(senderName);
        const summary: AnalysisResult = {};
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const weekdays = ['일', '월', '화', '수', '목', '금', '토'];

        let headerRow: string[] = [];
        let outputRows: any[][] = [];
        const registeredProductNames: Record<string, string> = {};
        const orderItems: OrderItem[] = [];

        if (json.length > 0) {
            const headers = json[0].map(h => String(h).trim());
            const dateHeaders = ['주문일시', '주문일', '결제일', '발주발송일', '접수일'];
            const dateColIdx = headers.findIndex(h => dateHeaders.some(dh => h.includes(dh)));

            const groupColIdx = 10;
            const productColIdx = 11;
            const quantityColIdx = 22;
            const sourceOrderNumberIdx = 2;
            const recipientNameCol = 26;
            const recipientPhoneCol = 27;
            let optionColIdx = headers.findIndex(h => h.includes('옵션정보'));
            if (optionColIdx === -1) {
                optionColIdx = headers.findIndex(h => h.includes('옵션') && !h.includes('관리코드') && !h.includes('번호'));
            }
            // 등록상품명/등록옵션명 컬럼 탐색 (원본 데이터 검증용)
            let regProductColIdx = headers.findIndex(h => h === '등록상품명');
            if (regProductColIdx === -1) regProductColIdx = headers.findIndex(h => h.includes('등록상품'));
            if (regProductColIdx === -1) regProductColIdx = productColIdx;
            let regOptionColIdx = headers.findIndex(h => h === '등록옵션명');
            if (regOptionColIdx === -1) regOptionColIdx = headers.findIndex(h => h.includes('등록옵션'));
            if (regOptionColIdx === -1) regOptionColIdx = optionColIdx;
            const hasYeolmuProducts = Object.values(companyConfig.products).some(p => p.displayName.startsWith('열무김치'));

            for (let i = 1; i < json.length; i++) {
                const row = json[i];
                if (!row) continue;
                const orderNumber = String(row[sourceOrderNumberIdx] || '').trim();
                const recipientName = String(row[recipientNameCol] || '').trim();
                const productName = String(row[productColIdx] || '').trim();
                const phone = String(row[recipientPhoneCol] || '').trim();

                const qty = parseInt(String(row[quantityColIdx] || row[22]), 10);
                const validQty = (isNaN(qty) || qty < 1) ? 1 : qty;

                if (row[7]) {
                    const sd = new Date(String(row[7]).trim());
                    if (!isNaN(sd.getTime()) && (sd.getTime() - today.getTime()) / (1000 * 60 * 60 * 24) > 7) {
                        excludedOrders.push({ companyName, recipientName, productName, phone, orderNumber: `${orderNumber} (출고예정일 7일 초과)`, qty: validQty, groupName: String(row[groupColIdx] || '').trim() });
                        continue;
                    }
                }

                if (fakeOrderNumbers.has(orderNumber)) {
                    excludedOrders.push({ companyName, recipientName, productName, phone, orderNumber: `${orderNumber} (제외)`, qty: validQty });
                    continue;
                }

                if (isNaN(qty) || qty < 1) {
                    unmatchedOrders.push({ companyName, recipientName, productName: `${productName} (수량 오류: ${row[quantityColIdx]})`, phone, orderNumber, qty: 1 });
                    continue;
                }

                let rawProductName = `${row[groupColIdx] || ''} ${row[productColIdx] || ''}`.trim();
                if (optionColIdx !== -1 && row[optionColIdx]) {
                    rawProductName += ' ' + String(row[optionColIdx]).trim();
                }
                // 등록상품명 "열무김치" + 데이터 "연두김치": kg 무게 찾아서 "열무김치 Xkg"로 변환
                if (hasYeolmuProducts && (rawProductName.includes('연두김치') || productName === '연두김치' || /^\d+\s*kg$/i.test(productName))) {
                    const kgMatch = rawProductName.match(/(\d+)\s*kg/i);
                    if (kgMatch) {
                        rawProductName = `열무김치 ${kgMatch[1]}kg`;
                    } else {
                        for (let col = 12; col <= 21; col++) {
                            const m = String(row[col] || '').match(/(\d+)\s*kg/i);
                            if (m) { rawProductName = `열무김치 ${m[1]}kg`; break; }
                        }
                    }
                }
                const productConfigTuple = await findBestMatchForProduct(ai, cache, companyName, rawProductName, companyConfig.products, findProductConfig, pricingConfig);

                if (productConfigTuple) {
                    const [productKey, config] = productConfigTuple;
                    const splitCount = config.orderSplitCount && config.orderSplitCount > 1 ? config.orderSplitCount : 1;
                    const poRowQty = qty * splitCount; // 발주서 행 수만 분할
                    const shipping = splitCount > 1 && config.shippingCost ? config.shippingCost : 0;

                    if (!summary[productKey]) summary[productKey] = { count: 0, totalPrice: 0 };
                    summary[productKey].count += qty;
                    summary[productKey].totalPrice += qty * config.supplyPrice + shipping;

                    const dateStr = parseDateFromRow(row, dateColIdx);
                    if (shipping > 0) {
                        stats.add(config.displayName, 1, config.supplyPrice + shipping, dateStr);
                        if (qty > 1) stats.add(config.displayName, qty - 1, config.supplyPrice, dateStr);
                    } else {
                        stats.add(config.displayName, qty, config.supplyPrice, dateStr);
                    }

                    if (!registeredProductNames[config.displayName]) {
                        registeredProductNames[config.displayName] = String(row[groupColIdx] || '').trim();
                    }
                    await pushToOutputRows(companyName, outputRows, row, config, poRowQty, pricingConfig, senderName, senderPhone, senderAddress);
                    orderItems.push({
                        registeredProductName: String(row[regProductColIdx] || '').trim(),
                        registeredOptionName: String(row[regOptionColIdx] || '').trim(),
                        matchedProductKey: productKey,
                        qty,
                    });
                } else {
                    console.error(`[발주서][${companyName}] ❌ 품목 매칭 실패로 주문 누락! 수취인: ${recipientName}, 상품: ${rawProductName}, 주문번호: ${orderNumber}`);
                    unmatchedOrders.push({ companyName, recipientName, productName: rawProductName, phone, orderNumber, qty });
                }
            }
        }

        for (const mo of manualOrders) {
            const productConfigTuple = await findBestMatchForProduct(ai, cache, companyName, mo.productName, companyConfig.products, findProductConfig, pricingConfig);
            // 매칭 실패 시에도 수동 주문은 반드시 포함 (원래 입력 품목명 사용)
            const [productKey, config] = productConfigTuple || [mo.productName, { displayName: mo.productName, supplyPrice: 0 } as ProductPricing];
            const moSplitCount = config.orderSplitCount && config.orderSplitCount > 1 ? config.orderSplitCount : 1;
            const moPoRowQty = mo.qty * moSplitCount; // 발주서 행 수만 분할
            const moShipping = moSplitCount > 1 && config.shippingCost ? config.shippingCost : 0;

            if (!summary[productKey]) summary[productKey] = { count: 0, totalPrice: 0 };
            summary[productKey].count += mo.qty;
            summary[productKey].totalPrice += mo.qty * config.supplyPrice + moShipping;

            if (moShipping > 0) {
                stats.add(config.displayName, 1, config.supplyPrice + moShipping, todayStr);
                if (mo.qty > 1) stats.add(config.displayName, mo.qty - 1, config.supplyPrice, todayStr);
            } else {
                stats.add(config.displayName, mo.qty, config.supplyPrice, todayStr);
            }
            await pushManualToOutputRows(companyName, outputRows, mo, config, pricingConfig, senderName, senderPhone, senderAddress, moPoRowQty);
        }

        headerRow = getHeaderForCompany(companyName, companyConfig);

        if (outputRows.length === 0 && Object.keys(summary).length === 0) return [companyName, null];
        const ws = XLSX.utils.aoa_to_sheet([headerRow, ...outputRows]);
        ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: headerRow.length - 1, r: 0 } }) };
        ws['!cols'] = headerRow.map(() => ({ wch: 15 }));

        const newWb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(newWb, ws, `발주서`);
        const dateTitle = `${today.getMonth() + 1}/${today.getDate()} (${weekdays[today.getDay()]})`;
        const bizShort = getBusinessInfo(businessId || '')?.shortName || '';
        const summaryTitle = bizShort ? `${dateTitle} (${companyName}) ${bizShort}` : `${dateTitle} (${companyName})`;
        const depositSummary = stats.generateText(stats.total, summaryTitle);
        const depositSummaryExcel = stats.generateExcelText(stats.total, dateTitle);
        const dailySummaries = Object.keys(stats.daily).sort().map(date => ({ date, content: stats.generateText(stats.daily[date], date) }));
        return [companyName, { workbook: newWb, fileName: `${todayStr} ${bizShort ? bizShort + ' ' : ''}${companyName} 발주서.xlsx`, summary, depositSummary, depositSummaryExcel, dailySummaries, rows: outputRows, registeredProductNames, orderItems }];
    } catch (error) {
        console.error("Error generating workbook:", error);
        return [companyName, null];
    }
};

export function getHeaderForCompany(companyName: string, config: CompanyConfig): string[] {
    if (companyName === '팜플로우') return ['출고번호', '받으시는 분 이름', '받으시는 분 전화', '받는분 주소', '배송메세지', '품목명', '수량', '보내시는 분', '보내시는 분 전화', '보내시는분 주소', '메모1', '택배사', '송장번호'];
    if (companyName === '웰그린') return ['', '쇼핑몰주문번호', '쇼핑몰', '상품명', '옵션(품목명)', '수량', '배송메세지', '', '', '받는분성명', '주문자', '받는분연락처', '주문자연락처', '', '우편번호', '받는분주소(전체, 분할)', '', '판매처연락처', '판매처주소'];
    if (companyName === '답도' || companyName === '한라봉_답도') return ['주문번호', '기재안해도됨', '송하인', '송하인 연락처', '수취인', '수취인 연락처', '주소', '상품명', '수량', '배송 메세지', '송장번호'];
    if (companyName === '제이제이' || companyName === '귤_제이') return ['송하인', '송하인주소', '송하인연락처', '품목', '받는분성명', '받는분주소', '받는분연락처', '배송메시지', '주문번호', '택배사', '송장번호'];
    if (companyName === '신선마켓' || companyName === '귤_신선') return ['주문번호', '품목명', '수량', '받는사람', '전화번호', '', '', '우편번호', '주소', '배송메세지'];
    if (companyName === '고랭지김치') return ['주문번호', '보내는사람', '전화번호1', '전화번호2', '우편번호', '주소', '받는사람', '전화번호1', '전화번호2', '우편번호', '주소', '상품명1', '상품상세1', '수량(A타입)', '수량(B타입)', '배송메시지', '운임구분', '운임'];
    if (['연두', '총각김치', '포기김치', '배추김치'].includes(companyName)) return ['주문번호', '고객주문처명', '수취인명', '수취인 우편번호', '수취인 주소', '수취인 전화번호', '수취인 이동통신', '상품명', '상품모델', '배송메세지', '비고', '수량', '신청건수', '포장재', '부피단위'];
    return config.orderFormHeaders?.length ? config.orderFormHeaders : ['받는사람', '전화번호', '주소', '품목명', '수량', '배송메세지', '주문번호'];
}

/** 헤더명에서 필드 타입을 자동 추정 (전화번호/주소를 이름보다 먼저 체크) */
export function inferVendorInvoiceField(h: string): VendorInvoiceFieldKey {
    const lower = h.toLowerCase().replace(/\s+/g, '');
    if (lower.includes('주문번호') || lower.includes('관리번호') || lower.includes('오더번호') || lower.includes('오더넘버') || lower.includes('접수번호') || lower.includes('고객주문번호') || lower === 'id') return 'orderNumber';
    if (lower.includes('송장') || lower.includes('운송장') || lower.includes('등기') || lower.includes('배송번호') || lower.includes('화물추적') || lower.includes('트래킹') || lower.includes('tracking') || lower.includes('invoice')) return 'trackingNumber';
    return 'empty';
}

export function inferFieldFromHeader(h: string): OrderFormFieldKey {
    if (h.includes('받는분연락처') || h.includes('전화번호') || h.includes('핸드폰') || h.includes('휴대폰') || (h.includes('연락처') && !h.includes('발송인') && !h.includes('업체'))) return 'recipientPhone';
    if (h.includes('우편번호')) return 'recipientZipcode';
    if (h.includes('받는분주소') || (h.includes('주소') && !h.includes('발송인') && !h.includes('업체') && !h.includes('송하인') && !h.includes('보내는'))) return 'recipientAddress';
    if (h.includes('받는분성명') || h.includes('받는사람') || h.includes('수취인') || h.includes('수령인')) return 'recipientName';
    if (h.includes('발송인전') || h.includes('발송인연락') || h.includes('업체전화') || h.includes('보내는사람전화')) return 'senderPhone';
    if (h.includes('발송인주소') || h.includes('업체주소') || h.includes('보내는사람주소')) return 'senderAddress';
    if (h.includes('발송인') || h.includes('송하인') || h.includes('업체명') || h.includes('보내는사람')) return 'senderName';
    if (h.includes('제품명') || h.includes('품목') || h.includes('상품명') || h.includes('품번') || h.includes('스토어상품')) return 'productName';
    if (h.includes('옵션')) return 'empty';
    if (h.includes('수량') || h.includes('주문수량')) return 'qty';
    if (h.includes('주문번호') || h.includes('주문정보')) return 'orderNumber';
    if (h.includes('배송메') || h.includes('배송시사항') || h.includes('배송요청') || h.includes('배송사항')) return 'deliveryMessage';
    if (h.includes('일자')) return 'empty';
    return 'empty';
}

/** 일반 주문: 필드 키 → 값 변환 */
function resolveFieldValue(field: OrderFormFieldKey, row: any[], orderName: string, senderName: string, senderPhone: string, senderAddress: string): any {
    switch (field) {
        case 'recipientName':    return String(row[26] || '');
        case 'recipientPhone':   return String(row[27] || '');
        case 'recipientZipcode': return String(row[28] || '');
        case 'recipientAddress': return String(row[29] || '');
        case 'deliveryMessage':  return String(row[30] || '');
        case 'productName':      return orderName;
        case 'qty':              return 1;
        case 'orderNumber':      return String(row[2] || '');
        case 'senderName':       return senderName;
        case 'senderPhone':      return senderPhone;
        case 'senderAddress':    return senderAddress;
        case 'empty': default:   return '';
    }
}

/** 수동 주문: 필드 키 → 값 변환 */
function resolveManualFieldValue(field: OrderFormFieldKey, mo: ManualOrder, orderName: string, senderName: string, senderPhone: string, senderAddress: string): any {
    switch (field) {
        case 'recipientName':    return mo.recipientName;
        case 'recipientPhone':   return mo.phone;
        case 'recipientZipcode': return '';
        case 'recipientAddress': return mo.address;
        case 'deliveryMessage':  return '';
        case 'productName':      return orderName;
        case 'qty':              return 1;
        case 'orderNumber':      return '수동';
        case 'senderName':       return senderName;
        case 'senderPhone':      return senderPhone;
        case 'senderAddress':    return senderAddress;
        case 'empty': default:   return '';
    }
}

async function pushToOutputRows(companyName: string, outputRows: any[][], row: any[], config: ProductPricing, qty: number, pricingConfig: PricingConfig, senderName: string = '안군농원', senderPhone: string = '01042626343', senderAddress: string = '제주도') {
    const orderName = config.orderFormName || config.displayName;
    if (companyName === '팜플로우') {
        for (let j = 0; j < qty; j++) {
            const or = new Array(13).fill('');
            or[0] = String(row[2] || ''); or[1] = String(row[26] || ''); or[2] = String(row[27] || ''); or[3] = String(row[29] || '');
            or[4] = String(row[30] || ''); or[5] = orderName; or[6] = 1; or[7] = senderName; or[8] = senderPhone; or[9] = senderAddress;
            outputRows.push(or);
        }
    } else if (companyName === '웰그린') {
        for (let j = 0; j < qty; j++) {
            const or = new Array(19).fill('');
            or[1] = String(row[2] || ''); or[2] = '안군농원'; or[3] = String(row[11] || ''); or[4] = orderName; or[5] = 1;
            or[6] = String(row[30] || ''); or[9] = String(row[26] || ''); or[10] = String(row[26] || ''); or[11] = String(row[27] || '');
            or[12] = String(row[27] || ''); or[14] = String(row[28] || ''); or[15] = String(row[29] || ''); or[17] = '01042626343';
            outputRows.push(or);
        }
    } else if (companyName === '답도' || companyName === '한라봉_답도') {
        for (let j = 0; j < qty; j++) {
            const or = new Array(11).fill('');
            or[0] = String(row[2] || ''); or[2] = '안군농원'; or[3] = '01042626343'; or[4] = String(row[26] || ''); or[5] = String(row[27] || ''); or[6] = String(row[29] || ''); or[7] = orderName; or[8] = 1; or[9] = String(row[30] || '');
            outputRows.push(or);
        }
    } else if (['연두', '총각김치', '포기김치', '배추김치'].includes(companyName)) {
        for (let j = 0; j < qty; j++) {
            const or = new Array(15).fill('');
            or[0] = String(row[2] || ''); // 주문번호
            or[1] = '안군농원'; // 고객주문처명
            or[2] = String(row[26] || ''); // 수취인명
            or[3] = String(row[28] || ''); // 우편번호
            or[4] = String(row[29] || ''); // 주소
            or[5] = String(row[27] || ''); // 전화번호
            or[6] = String(row[27] || ''); // 이동통신
            or[7] = orderName; // 상품명
            or[8] = orderName; // 상품모델
            or[9] = String(row[30] || ''); // 배송메세지
            or[11] = 1; // 수량
            or[12] = 1; // 신청건수
            outputRows.push(or);
        }
    } else if (companyName === '제이제이' || companyName === '귤_제이') {
        for (let j = 0; j < qty; j++) {
            const or = new Array(11).fill('');
            or[0] = senderName;                // 송하인
            or[1] = senderAddress;             // 송하인주소
            or[2] = senderPhone;               // 송하인연락처
            or[3] = orderName;                 // 품목
            or[4] = String(row[26] || '');      // 받는분성명
            or[5] = String(row[29] || '');      // 받는분주소
            or[6] = String(row[27] || '');      // 받는분연락처
            or[7] = String(row[30] || '');      // 배송메시지
            or[8] = String(row[2] || '');       // 주문번호
            outputRows.push(or);
        }
    } else if (companyName === '고랭지김치') {
        for (let j = 0; j < qty; j++) {
            const or = new Array(18).fill('');
            or[0] = String(row[2] || ''); // 주문번호
            or[1] = '미래찬';
            or[2] = '070-5222-6543';
            or[3] = '070-5222-6543';
            or[4] = '25346';
            or[5] = '강원 평창군 방림면 평창대로84-15';
            or[6] = String(row[26] || ''); // 받는사람
            or[7] = String(row[27] || ''); // 전화번호1
            or[8] = String(row[27] || ''); // 전화번호2
            or[9] = String(row[28] || ''); // 우편번호
            or[10] = String(row[29] || ''); // 주소
            or[11] = orderName; // 상품명1
            or[12] = orderName; // 상품상세1

            // 수량 분류 규칙 (A타입 / B타입)
            const prodName = config.displayName.toLowerCase();
            if (prodName.includes('7kg') || prodName.includes('10kg')) {
                or[14] = 1; // 수량(B타입)
            } else {
                or[13] = 1; // 수량(A타입) - 기본값 포함
            }

            or[15] = String(row[30] || ''); // 배송메시지
            outputRows.push(or);
        }
    } else {
        const customHeaders = pricingConfig[companyName]?.orderFormHeaders || [];
        const fieldMap = pricingConfig[companyName]?.orderFormFieldMap;
        for (let j = 0; j < qty; j++) {
            if (customHeaders.length > 0) {
                const or = new Array(customHeaders.length).fill('');
                customHeaders.forEach((h, idx) => {
                    const field = (fieldMap?.[idx] || inferFieldFromHeader(h)) as OrderFormFieldKey;
                    or[idx] = resolveFieldValue(field, row, orderName, senderName, senderPhone, senderAddress);
                });
                outputRows.push(or);
            } else {
                outputRows.push([String(row[26] || ''), String(row[27] || ''), String(row[29] || ''), orderName, 1, String(row[30] || ''), String(row[2] || '')]);
            }
        }
    }
}

async function pushManualToOutputRows(companyName: string, outputRows: any[][], mo: ManualOrder, config: ProductPricing, pricingConfig: PricingConfig, senderName: string = '안군농원', senderPhone: string = '01042626343', senderAddress: string = '제주도', overrideQty?: number) {
    const orderName = config.orderFormName || config.displayName;
    const rowQty = overrideQty ?? mo.qty;
    if (companyName === '팜플로우') {
        for (let j = 0; j < rowQty; j++) {
            const or = new Array(13).fill('');
            or[0] = '수동'; or[1] = mo.recipientName; or[2] = mo.phone; or[3] = mo.address; or[5] = orderName; or[6] = 1; or[7] = '안군농원'; or[8] = '01042626343'; or[9] = '제주도';
            outputRows.push(or);
        }
    } else if (companyName === '웰그린') {
        for (let j = 0; j < rowQty; j++) {
            const or = new Array(19).fill('');
            or[1] = '수동'; or[2] = '안군농원'; or[4] = orderName; or[5] = 1; or[9] = mo.recipientName; or[10] = mo.recipientName; or[11] = mo.phone; or[12] = mo.phone; or[15] = mo.address; or[17] = '01042626343';
            outputRows.push(or);
        }
    } else if (companyName === '답도' || companyName === '한라봉_답도') {
        for (let j = 0; j < rowQty; j++) {
            const or = new Array(11).fill('');
            or[0] = '수동'; or[2] = '안군농원'; or[3] = '01042626343'; or[4] = mo.recipientName; or[5] = mo.phone; or[6] = mo.address; or[7] = orderName; or[8] = 1;
            outputRows.push(or);
        }
    } else if (['연두', '총각김치', '포기김치', '배추김치'].includes(companyName)) {
        for (let j = 0; j < rowQty; j++) {
            const or = new Array(15).fill('');
            or[0] = '수동';
            or[1] = '안군농원';
            or[2] = mo.recipientName;
            or[4] = mo.address;
            or[5] = mo.phone;
            or[6] = mo.phone;
            or[7] = orderName;
            or[8] = orderName;
            or[11] = 1;
            or[12] = 1;
            outputRows.push(or);
        }
    } else if (companyName === '고랭지김치') {
        for (let j = 0; j < rowQty; j++) {
            const or = new Array(18).fill('');
            or[0] = '수동';
            or[1] = '미래찬';
            or[2] = '070-5222-6543';
            or[3] = '070-5222-6543';
            or[4] = '25346';
            or[5] = '강원 평창군 방림면 평창대로84-15';
            or[6] = mo.recipientName;
            or[7] = mo.phone;
            or[8] = mo.phone;
            or[10] = mo.address;
            or[11] = orderName;
            or[12] = orderName;

            const prodName = config.displayName.toLowerCase();
            if (prodName.includes('7kg') || prodName.includes('10kg')) {
                or[14] = 1; // 수량(B타입)
            } else {
                or[13] = 1; // 수량(A타입)
            }
            outputRows.push(or);
        }
    } else if (companyName === '제이제이' || companyName === '귤_제이') {
        for (let j = 0; j < rowQty; j++) {
            const or = new Array(11).fill('');
            or[0] = senderName;          // 송하인
            or[1] = senderAddress;       // 송하인주소
            or[2] = senderPhone;         // 송하인연락처
            or[3] = orderName;           // 품목
            or[4] = mo.recipientName;    // 받는분성명
            or[5] = mo.address;          // 받는분주소
            or[6] = mo.phone;            // 받는분연락처
            or[8] = '수동';              // 주문번호
            outputRows.push(or);
        }
    } else {
        const customHeaders = pricingConfig[companyName]?.orderFormHeaders || [];
        const fieldMap = pricingConfig[companyName]?.orderFormFieldMap;
        for (let j = 0; j < rowQty; j++) {
            if (customHeaders.length > 0) {
                const or = new Array(customHeaders.length).fill('');
                customHeaders.forEach((h, idx) => {
                    const field = (fieldMap?.[idx] || inferFieldFromHeader(h)) as OrderFormFieldKey;
                    or[idx] = resolveManualFieldValue(field, mo, orderName, senderName, senderPhone, senderAddress);
                });
                outputRows.push(or);
            } else {
                outputRows.push([mo.recipientName, mo.phone, mo.address, orderName, 1, '', '수동']);
            }
        }
    }
}

export const useConsolidatedOrderConverter = (pricingConfig: PricingConfig, businessId?: string) => {
    const [status, setStatus] = useState<ProcessingStatus>('idle');
    const [error, setError] = useState<string | null>(null);
    const [results, setResults] = useState<Record<string, ProcessedResult> | null>(null);
    const [excludedOrders, setExcludedOrders] = useState<ExcludedOrder[]>([]);
    const [fileName, setFileName] = useState<string>('');

    const processSingleCompanyFile = useCallback(async (file: File | null, targetCompanyName: string, fakeOrderNumbersInput: string, manualOrders: ManualOrder[] = []) => {
        try {
            const geminiKey = import.meta.env.VITE_GEMINI_API_KEY;
            const ai = geminiKey ? new GoogleGenAI({ apiKey: geminiKey }) : null;
            let json: any[][] = [];
            let headers: any[] = [];

            if (file) {
                const data = await file.arrayBuffer();
                const wb = XLSX.read(data, { type: 'array' });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const fullJson = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
                if (fullJson.length > 0) {
                    const headerRowIdx = findHeaderRowIndex(fullJson);
                    headers = fullJson[headerRowIdx];
                    const groupColIdx = 10;
                    // 모든 회사 키워드 맵 생성 (위치 우선순위 매칭용)
                    const allCompanyKeywords = new Map<string, string[]>();
                    Object.keys(pricingConfig || {}).forEach(name => allCompanyKeywords.set(name, getKeywordsForCompany(name, pricingConfig)));

                    json.push(headers);
                    for (let i = headerRowIdx + 1; i < fullJson.length; i++) {
                        const row = fullJson[i];
                        if (!row) continue;
                        const groupVal = String(row[groupColIdx] || '').replace(/\s+/g, '').normalize('NFC');
                        // 모든 회사 중 키워드가 가장 앞에 매칭되는 회사 찾기
                        let bestCompany = '';
                        let bestPos = Infinity;
                        for (const [name, keywords] of allCompanyKeywords.entries()) {
                            for (const k of keywords) {
                                const pos = groupVal.indexOf(k.replace(/\s+/g, '').normalize('NFC'));
                                if (pos !== -1 && pos < bestPos) {
                                    bestPos = pos;
                                    bestCompany = name;
                                }
                            }
                        }
                        if (bestCompany === targetCompanyName) json.push(row);
                    }
                }
            }

            const fakeOrderNumbers = new Set<string>();
            fakeOrderNumbersInput.split('\n').forEach(line => {
                const matches = line.match(/[A-Za-z0-9-]{5,}/g);
                if (matches) matches.forEach(m => fakeOrderNumbers.add(m.trim()));
            });

            const localExcluded: ExcludedOrder[] = [];
            const localUnmatched: UnmatchedOrder[] = [];
            const [, result] = await generateWorkbookForCompany(ai, new Map(), pricingConfig, json, targetCompanyName, fakeOrderNumbers, localExcluded, manualOrders, localUnmatched, businessId);

            return { result, excluded: localExcluded, unmatched: localUnmatched };
        } catch (err) {
            console.error(err);
            return null;
        }
    }, [pricingConfig, businessId]);

    const reset = () => { setStatus('idle'); setError(null); setResults(null); setExcludedOrders([]); setFileName(''); };
    return { status, error, results, excludedOrders, processSingleCompanyFile, reset, fileName };
};
