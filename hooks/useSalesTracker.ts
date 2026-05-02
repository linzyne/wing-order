import { useState, useCallback, useEffect } from 'react';
import type { DailySales, SalesRecord, PricingConfig, DepositRecord, MarginRecord } from '../types';
import {
  loadAllSalesHistory,
  upsertDailySales,
  deleteDailySalesFromFirestore,
} from '../services/firestoreService';

declare var XLSX: any;

export const loadSalesHistory = async (businessId?: string): Promise<DailySales[]> => {
  try {
    return await loadAllSalesHistory(businessId);
  } catch {
    return [];
  }
};

const upsertHistory = async (dailySales: DailySales, businessId?: string) => {
  await upsertDailySales(dailySales, businessId);
};

export const saveDailySales = async (
  date: string,
  allSummaries: Record<string, string>,
  pricingConfig: PricingConfig,
  companySessions: Record<string, { id: string; companyName: string; round: number }[]>,
  extraData?: {
    orderRows?: any[][];
    invoiceRows?: any[][];
    depositRecords?: DepositRecord[];
    depositTotal?: number;
    marginRecords?: MarginRecord[];
    marginTotal?: number;
  },
  businessId?: string
): Promise<DailySales> => {
  // 같은 업체+상품은 합산 (1차, 2차 등 여러 세션 데이터를 병합)
  const recordMap = new Map<string, SalesRecord>();

  Object.entries(companySessions).forEach(([companyName, sessions]) => {
    const companyConfig = pricingConfig[companyName];
    if (!companyConfig) return;

    sessions.forEach(session => {
      const summaryText = allSummaries[session.id];
      if (!summaryText || !summaryText.trim()) return;

      const lines = summaryText.split('\n');
      lines.forEach(line => {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          const productName = parts[1]?.trim();
          const countMatch = parts[2]?.match(/(\d+)개/);
          const priceStr = parts[3]?.replace(/[,원]/g, '');

          if (productName && countMatch) {
            const count = parseInt(countMatch[1]);
            const totalPrice = parseInt(priceStr) || 0;

            let margin = 0;
            if (companyConfig.products) {
              const productEntry = Object.values(companyConfig.products).find(
                p => (p.orderFormName || p.displayName) === productName || p.displayName === productName
              );
              if (productEntry?.margin) margin = productEntry.margin;
            }

            const key = `${companyName}::${productName}`;
            const existing = recordMap.get(key);
            if (existing) {
              existing.count += count;
              existing.totalPrice += totalPrice;
              existing.supplyPrice = existing.count > 0 ? Math.round(existing.totalPrice / existing.count) : 0;
            } else {
              const supplyPrice = count > 0 ? Math.round(totalPrice / count) : 0;
              recordMap.set(key, { date, company: companyName, product: productName, count, supplyPrice, totalPrice, margin });
            }
          }
        }
      });
    });
  });

  const records = Array.from(recordMap.values());

  const totalAmount = records.reduce((sum, r) => sum + r.totalPrice, 0);
  const dailySales: DailySales = {
    date, records, totalAmount, savedAt: new Date().toISOString(),
    orderRows: extraData?.orderRows,
    invoiceRows: extraData?.invoiceRows,
    depositRecords: extraData?.depositRecords,
    depositTotal: extraData?.depositTotal,
    marginRecords: extraData?.marginRecords,
    marginTotal: extraData?.marginTotal,
  };

  await upsertHistory(dailySales, businessId);
  return dailySales;
};

/** 엑셀 시트를 rows로 변환 */
const sheetToRows = (wb: any, sheetName: string): any[][] => {
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
};

/** 시트 이름 찾기 (부분 매칭) */
const findSheet = (sheetNames: string[], ...keywords: string[]): string | null => {
  return sheetNames.find((n: string) => keywords.some(k => n.includes(k))) || null;
};

/** 업무일지 엑셀 파일에서 모든 시트 데이터를 파싱하여 저장 */
export const importWorkLogExcel = async (file: File, businessId?: string): Promise<{ imported: number; dates: string[] }> => {
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: 'array' });

  const filenameDateMatch = file.name.match(/(\d{4}-\d{2}-\d{2})/);
  const filenameDate = filenameDateMatch ? filenameDateMatch[1] : null;
  const date = filenameDate || new Date().toISOString().slice(0, 10);

  // ── 요약시트 파싱 (매출 records) ──
  const summarySheetName = findSheet(wb.SheetNames, '요약', 'Summary') || wb.SheetNames[0];
  const summaryRows = sheetToRows(wb, summarySheetName);
  const records: SalesRecord[] = [];
  let currentCompany = '';

  for (const row of summaryRows) {
    if (!row || row.length === 0) continue;
    const firstCell = String(row[0] || '').trim();
    const companyMatch = firstCell.match(/^\[(.+?)\s*정산내역\]$/);
    if (companyMatch) { currentCompany = companyMatch[1]; continue; }

    if (currentCompany && row.length >= 3) {
      const productName = String(row[1] || '').trim();
      const countMatch = String(row[2] || '').trim().match(/(\d+)개/);
      if (productName && countMatch) {
        const count = parseInt(countMatch[1]);
        const priceStr = String(row[3] || '').replace(/[,원\s]/g, '');
        const totalPrice = parseInt(priceStr) || 0;
        const supplyPrice = count > 0 ? Math.round(totalPrice / count) : 0;
        records.push({ date, company: currentCompany, product: productName, count, supplyPrice, totalPrice, margin: 0 });
      }
    }
  }

  // ── 발주시트 파싱 ──
  const orderSheetName = findSheet(wb.SheetNames, '발주');
  const orderRows = orderSheetName ? sheetToRows(wb, orderSheetName) : [];

  // ── 송장시트 파싱 ──
  const invoiceSheetName = findSheet(wb.SheetNames, '송장');
  const invoiceRows = invoiceSheetName ? sheetToRows(wb, invoiceSheetName) : [];

  // ── 입금내역 파싱 ──
  const depositSheetName = findSheet(wb.SheetNames, '입금');
  const depositRawRows = depositSheetName ? sheetToRows(wb, depositSheetName) : [];
  const depositRecords: DepositRecord[] = [];
  let depositTotal = 0;

  for (const row of depositRawRows) {
    if (!row || row.length < 3) continue;
    const bankName = String(row[0] || '').trim();
    const accountNumber = String(row[1] || '').trim();
    const amountRaw = row[2];
    if (bankName === '' && accountNumber === '합계') {
      depositTotal = typeof amountRaw === 'number' ? amountRaw : parseInt(String(amountRaw).replace(/[,원\s]/g, '')) || 0;
      continue;
    }
    const amount = typeof amountRaw === 'number' ? amountRaw : parseInt(String(amountRaw).replace(/[,원\s]/g, '')) || 0;
    if (amount > 0) {
      const label = row.length > 3 ? String(row[3] || '').trim() : '';
      depositRecords.push({ bankName, accountNumber, amount, label });
    }
  }
  if (depositTotal === 0) depositTotal = depositRecords.reduce((s, r) => s + r.amount, 0);

  // ── 저장 ──
  if (records.length > 0 || orderRows.length > 0 || invoiceRows.length > 0 || depositRecords.length > 0) {
    const totalAmount = records.reduce((sum, r) => sum + r.totalPrice, 0);
    const dailySales: DailySales = {
      date, records, totalAmount, savedAt: new Date().toISOString(),
      orderRows: orderRows.length > 0 ? orderRows : undefined,
      invoiceRows: invoiceRows.length > 0 ? invoiceRows : undefined,
      depositRecords: depositRecords.length > 0 ? depositRecords : undefined,
      depositTotal: depositTotal > 0 ? depositTotal : undefined,
    };
    await upsertHistory(dailySales, businessId);
    return { imported: records.length + orderRows.length + invoiceRows.length + depositRecords.length, dates: [date] };
  }

  return { imported: 0, dates: [] };
};

export const importMultipleWorkLogs = async (files: File[], businessId?: string): Promise<{ totalImported: number; dates: string[] }> => {
  let totalImported = 0;
  const allDates: string[] = [];
  for (const file of files) {
    const result = await importWorkLogExcel(file, businessId);
    totalImported += result.imported;
    allDates.push(...result.dates);
  }
  return { totalImported, dates: [...new Set(allDates)].sort() };
};

export const deleteDailySales = async (date: string, businessId?: string) => {
  await deleteDailySalesFromFirestore(date, businessId);
};

export const useSalesTracker = (businessId?: string) => {
  const [salesHistory, setSalesHistory] = useState<DailySales[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (loaded) return;
    const history = await loadAllSalesHistory(businessId);
    setSalesHistory(history);
    setLoaded(true);
  }, [businessId, loaded]);

  const refresh = useCallback(async () => {
    const history = await loadAllSalesHistory(businessId);
    setSalesHistory(history);
    setLoaded(true);
  }, [businessId]);

  const remove = useCallback(async (date: string) => {
    await deleteDailySalesFromFirestore(date, businessId);
    setSalesHistory(prev => prev.filter(d => d.date !== date));
  }, [businessId]);

  return { salesHistory, load, refresh, remove };
};
