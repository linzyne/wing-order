import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useSalesTracker, importMultipleWorkLogs } from '../hooks/useSalesTracker';
import { usePricingConfig } from '../hooks/useFirestore';
import { TrashIcon, ArrowDownTrayIcon, ChevronDownIcon, ChevronUpIcon, UploadIcon } from './icons';
import type { DepositRecord, MarginRecord, ExpenseRecord, SalesRecord, CompanyConfig, ReturnRecord } from '../types';
import { getBusinessInfo } from '../types';

declare var XLSX: any;

type ViewMode = 'settlement' | 'byDate' | 'byProduct' | 'byCompany' | 'orders' | 'invoices' | 'deposits' | 'margin' | 'returns' | 'monthlyAnalysis' | 'trend';
type DateMode = 'month' | 'range';

const SalesTracker: React.FC<{ isActive?: boolean; businessId?: string }> = ({ isActive, businessId }) => {
  const businessPrefix = businessId ? (getBusinessInfo(businessId)?.shortName || businessId) : '';
  const { salesHistory, refresh, remove } = useSalesTracker(businessId);
  const { config: pricingConfig } = usePricingConfig(businessId);

  // 탭 활성화 시 데이터 새로고침
  useEffect(() => {
    if (isActive) refresh();
  }, [isActive, refresh]);
  const [viewMode, setViewMode] = useState<ViewMode>('byDate');
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 발주/송장 검색
  const [orderSearch, setOrderSearch] = useState('');
  const [invoiceSearch, setInvoiceSearch] = useState('');

  // 판매추이
  const [trendDays, setTrendDays] = useState(14);
  const [trendMetric, setTrendMetric] = useState<'count' | 'totalPrice' | 'margin'>('count');
  const [trendCompany, setTrendCompany] = useState<string>('');

  // 업체별정산 선택 업체
  const [settlementCompany, setSettlementCompany] = useState<string>('');

  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);

  // 날짜 범위 모드
  const [dateMode, setDateMode] = useState<DateMode>('month');
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const [rangeStart, setRangeStart] = useState(todayStr.slice(0, 8) + '01');
  const [rangeEnd, setRangeEnd] = useState(todayStr);

  const selectedYearMonth = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;

  const availableYears = useMemo(() => {
    const years = new Set<number>();
    salesHistory.forEach(d => years.add(parseInt(d.date.slice(0, 4))));
    years.add(now.getFullYear());
    return Array.from(years).sort((a, b) => b - a);
  }, [salesHistory]);

  const availableMonthsForYear = useMemo(() => {
    const months = new Set<number>();
    salesHistory.forEach(d => {
      if (d.date.startsWith(String(selectedYear))) {
        months.add(parseInt(d.date.slice(5, 7)));
      }
    });
    if (selectedYear === now.getFullYear()) months.add(now.getMonth() + 1);
    return Array.from(months).sort((a, b) => a - b);
  }, [salesHistory, selectedYear]);

  const filteredHistory = useMemo(() => {
    if (dateMode === 'range') {
      return salesHistory.filter(d => d.date >= rangeStart && d.date <= rangeEnd);
    }
    return salesHistory.filter(d => d.date.startsWith(selectedYearMonth));
  }, [salesHistory, dateMode, selectedYearMonth, rangeStart, rangeEnd]);

  const allRecords = useMemo(() => filteredHistory.flatMap(d => d.records), [filteredHistory]);

  // 발주 데이터 합산
  const allOrderRows = useMemo(() => {
    const rows: { date: string; data: any[][] }[] = [];
    filteredHistory.forEach(d => {
      if (d.orderRows && d.orderRows.length > 0) {
        rows.push({ date: d.date, data: d.orderRows });
      }
    });
    return rows;
  }, [filteredHistory]);

  // 송장 데이터 합산
  const allInvoiceRows = useMemo(() => {
    const rows: { date: string; data: any[][] }[] = [];
    filteredHistory.forEach(d => {
      if (d.invoiceRows && d.invoiceRows.length > 0) {
        rows.push({ date: d.date, data: d.invoiceRows });
      }
    });
    return rows;
  }, [filteredHistory]);

  // 발주 검색 필터링
  const filteredOrderRows = useMemo(() => {
    const q = orderSearch.trim().toLowerCase();
    if (!q) return allOrderRows;
    return allOrderRows
      .map(({ date, data }) => ({
        date,
        data: data.filter(row => row.some((cell: any) => cell != null && String(cell).toLowerCase().includes(q))),
      }))
      .filter(({ data }) => data.length > 0);
  }, [allOrderRows, orderSearch]);

  // 송장 검색 필터링
  const filteredInvoiceRows = useMemo(() => {
    const q = invoiceSearch.trim().toLowerCase();
    if (!q) return allInvoiceRows;
    return allInvoiceRows
      .map(({ date, data }) => ({
        date,
        data: data.filter(row => row.some((cell: any) => cell != null && String(cell).toLowerCase().includes(q))),
      }))
      .filter(({ data }) => data.length > 0);
  }, [allInvoiceRows, invoiceSearch]);

  // 입금 데이터 합산
  const allDepositData = useMemo(() => {
    const records: (DepositRecord & { date: string })[] = [];
    let total = 0;
    filteredHistory.forEach(d => {
      if (d.depositRecords) {
        d.depositRecords.forEach(r => records.push({ ...r, date: d.date }));
      }
      if (d.depositTotal) total += d.depositTotal;
    });
    if (total === 0) total = records.reduce((s, r) => s + r.amount, 0);
    return { records, total };
  }, [filteredHistory]);

  // 마진 데이터 합산
  const allMarginData = useMemo(() => {
    const records: (MarginRecord & { date: string })[] = [];
    let total = 0;
    filteredHistory.forEach(d => {
      if (d.marginRecords) {
        d.marginRecords.forEach(r => records.push({ ...r, date: d.date }));
      }
      if (d.marginTotal) total += d.marginTotal;
    });
    if (total === 0) total = records.reduce((s, r) => s + r.totalMargin, 0);
    return { records, total };
  }, [filteredHistory]);

  // 비용 데이터 합산
  const allExpenseData = useMemo(() => {
    const records: (ExpenseRecord & { date: string })[] = [];
    let total = 0;
    filteredHistory.forEach(d => {
      if (d.expenseRecords) {
        d.expenseRecords.forEach(r => records.push({ ...r, date: d.date }));
        total += d.expenseRecords.reduce((s, r) => s + r.amount, 0);
      }
    });
    return { records, total };
  }, [filteredHistory]);

  // 반품 데이터 합산
  const allReturnData = useMemo(() => {
    const records: (ReturnRecord & { date: string })[] = [];
    let total = 0;
    filteredHistory.forEach(d => {
      if (d.returnRecords) {
        d.returnRecords.forEach(r => records.push({ ...r, date: d.date }));
      }
      if (d.returnTotal) total += d.returnTotal;
    });
    if (total === 0) total = records.reduce((s, r) => s + r.totalMargin, 0);
    return { records, total };
  }, [filteredHistory]);

  const handleDeleteReturn = async (date: string, index: number) => {
    const existing = salesHistory.find(d => d.date === date);
    if (!existing || !existing.returnRecords) return;
    const updatedReturns = existing.returnRecords.filter((_, i) => i !== index);
    const updatedReturnTotal = updatedReturns.reduce((s, r) => s + r.totalMargin, 0);
    const { upsertDailySales } = await import('../services/firestoreService');
    await upsertDailySales({ ...existing, returnRecords: updatedReturns.length > 0 ? updatedReturns : undefined, returnTotal: updatedReturnTotal || undefined }, businessId);
    await refresh();
  };

  // 월별분석: 선택 연도의 전체 월별 품목별 마진 + 비용 데이터
  const monthlyAnalysisData = useMemo(() => {
    const yearStr = String(selectedYear);
    const yearHistory = salesHistory.filter(d => d.date.startsWith(yearStr));

    // 품목별 월별 마진
    const productMonthMargin = new Map<string, Map<number, number>>();
    // 월별 비용
    const monthExpenses = new Map<number, { total: number; byCategory: Map<string, number> }>();

    yearHistory.forEach(d => {
      const month = parseInt(d.date.slice(5, 7));

      // 마진 데이터 (registeredName 기준 — productName은 "2kg" 등 단위만 있을 수 있음)
      if (d.marginRecords) {
        d.marginRecords.forEach(r => {
          const label = r.registeredName || r.productName;
          if (!productMonthMargin.has(label)) {
            productMonthMargin.set(label, new Map());
          }
          const pm = productMonthMargin.get(label)!;
          pm.set(month, (pm.get(month) || 0) + r.totalMargin);
        });
      }

      // 비용 데이터
      if (d.expenseRecords) {
        if (!monthExpenses.has(month)) {
          monthExpenses.set(month, { total: 0, byCategory: new Map() });
        }
        const me = monthExpenses.get(month)!;
        d.expenseRecords.forEach(r => {
          me.total += r.amount;
          me.byCategory.set(r.category, (me.byCategory.get(r.category) || 0) + r.amount);
        });
      }
    });

    // 데이터가 있는 월 목록
    const activeMonths = new Set<number>();
    yearHistory.forEach(d => activeMonths.add(parseInt(d.date.slice(5, 7))));
    const months = Array.from(activeMonths).sort((a, b) => a - b);

    // 품목 목록 (연간 마진 총합 내림차순)
    const products = Array.from(productMonthMargin.entries())
      .map(([name, pm]) => ({ name, annualTotal: Array.from(pm.values()).reduce((s, v) => s + v, 0) }))
      .sort((a, b) => b.annualTotal - a.annualTotal);

    // 비용 카테고리 목록
    const expenseCategories = new Set<string>();
    monthExpenses.forEach(me => me.byCategory.forEach((_, cat) => expenseCategories.add(cat)));

    return { productMonthMargin, monthExpenses, months, products, expenseCategories: Array.from(expenseCategories) };
  }, [salesHistory, selectedYear]);

  const productSummary = useMemo(() => {
    const map = new Map<string, { count: number; totalPrice: number; margin: number }>();
    allRecords.forEach(r => {
      const existing = map.get(r.product) || { count: 0, totalPrice: 0, margin: 0 };
      existing.count += r.count;
      existing.totalPrice += r.totalPrice;
      existing.margin += (r.margin || 0) * r.count;
      map.set(r.product, existing);
    });
    return Array.from(map.entries()).sort(([, a], [, b]) => b.totalPrice - a.totalPrice);
  }, [allRecords]);

  const companySummary = useMemo(() => {
    const map = new Map<string, { count: number; totalPrice: number; margin: number }>();
    allRecords.forEach(r => {
      const existing = map.get(r.company) || { count: 0, totalPrice: 0, margin: 0 };
      existing.count += r.count;
      existing.totalPrice += r.totalPrice;
      existing.margin += (r.margin || 0) * r.count;
      map.set(r.company, existing);
    });
    return Array.from(map.entries()).sort(([, a], [, b]) => b.totalPrice - a.totalPrice);
  }, [allRecords]);

  const monthTotal = filteredHistory.reduce((sum, d) => sum + d.totalAmount, 0);
  const monthTotalCount = allRecords.reduce((sum, r) => sum + r.count, 0);
  const monthTotalMargin = allRecords.reduce((sum, r) => sum + (r.margin || 0) * r.count, 0);

  // 계좌번호 → 업체명 매핑
  const accountToCompanyMap = useMemo(() => {
    const map = new Map<string, string>();
    if (pricingConfig) {
      Object.entries(pricingConfig).forEach(([companyName, config]: [string, CompanyConfig]) => {
        if (config.accountNumber) {
          map.set(config.accountNumber, companyName);
        }
      });
    }
    return map;
  }, [pricingConfig]);

  // 판매추이 - 발주서생성용 품목명 조회
  const getOrderFormName = (company: string, rawName: string): string => {
    if (!pricingConfig?.[company]?.products) return rawName;
    const entry = (Object.values(pricingConfig[company].products) as import('../types').ProductPricing[]).find(
      p => p.displayName === rawName || p.orderFormName === rawName
    );
    return entry?.orderFormName || rawName;
  };

  const trendDates = useMemo(() => {
    return Array.from(new Set(filteredHistory.map(d => d.date))).sort();
  }, [filteredHistory]);

  const trendCompanies = useMemo(() => {
    const set = new Set<string>();
    salesHistory.forEach(d => d.records.forEach(r => set.add(r.company)));
    return Array.from(set).sort();
  }, [salesHistory]);

  const trendActiveCompany = trendCompany || trendCompanies[0] || '';

  const trendData = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    filteredHistory.forEach(d => {
      d.records.forEach(r => {
        if (r.company !== trendActiveCompany) return;
        const name = getOrderFormName(r.company, r.product);
        if (!map.has(name)) map.set(name, new Map());
        const dateMap = map.get(name)!;
        const prev = dateMap.get(d.date) || 0;
        const val = trendMetric === 'count' ? r.count
          : trendMetric === 'totalPrice' ? r.totalPrice
          : (r.margin || 0) * r.count;
        dateMap.set(d.date, prev + val);
      });
    });
    return map;
  }, [filteredHistory, trendActiveCompany, trendMetric, pricingConfig]);

  const groupByCompany = (records: SalesRecord[]) => {
    const map = new Map<string, SalesRecord[]>();
    records.forEach(r => {
      const list = map.get(r.company) || [];
      list.push(r);
      map.set(r.company, list);
    });
    return Array.from(map.entries()).sort(([, a], [, b]) => {
      const totalA = a.reduce((s, r) => s + r.totalPrice, 0);
      const totalB = b.reduce((s, r) => s + r.totalPrice, 0);
      return totalB - totalA;
    });
  };

  const toggleDate = (date: string) => {
    setExpandedDates(prev => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date); else next.add(date);
      return next;
    });
  };

  const handleImportFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsImporting(true);
    setImportStatus(null);
    try {
      const fileArray = Array.from(files).filter(f => f.name.endsWith('.xlsx') || f.name.endsWith('.xls'));
      if (fileArray.length === 0) {
        setImportStatus('엑셀 파일(.xlsx)만 업로드 가능합니다.');
        setIsImporting(false);
        return;
      }
      const result = await importMultipleWorkLogs(fileArray, businessId);
      if (result.totalImported > 0) {
        setImportStatus(`${result.dates.length}일치 데이터 (${result.totalImported}건) 가져오기 완료!`);
        if (result.dates.length > 0) {
          const firstDate = result.dates[0];
          setSelectedYear(parseInt(firstDate.slice(0, 4)));
          setSelectedMonth(parseInt(firstDate.slice(5, 7)));
        }
      } else {
        setImportStatus('파싱할 수 있는 매출 데이터를 찾지 못했습니다.');
      }
      refresh();
    } catch (err) {
      setImportStatus('파일 처리 중 오류가 발생했습니다.');
      console.error(err);
    }
    setIsImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    handleImportFiles(e.dataTransfer.files);
  };

  const handleExportExcel = () => {
    if (filteredHistory.length === 0) return;
    const wb = XLSX.utils.book_new();

    // 1. 날짜별 시트
    const dateRows: any[][] = [['날짜', '업체', '품목', '수량', '공급가', '합계', '마진']];
    filteredHistory.forEach(d => {
      d.records.forEach(r => {
        dateRows.push([d.date, r.company, r.product, r.count, r.supplyPrice, r.totalPrice, (r.margin || 0) * r.count]);
      });
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dateRows), '날짜별');

    // 2. 품목별 시트 (마진 제거)
    const productRows: any[][] = [['품목', '총수량', '총합계']];
    productSummary.forEach(([name, data]) => productRows.push([name, data.count, data.totalPrice]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(productRows), '품목별');

    // 3. 업체별 시트 (마진 제거)
    const companyRows: any[][] = [['업체', '총수량', '총합계']];
    companySummary.forEach(([name, data]) => companyRows.push([name, data.count, data.totalPrice]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(companyRows), '업체별');

    // 4. 발주 시트 (복구)
    if (allOrderRows.length > 0) {
      const orderSheetRows: any[][] = [];
      allOrderRows.forEach(({ data }) => {
        // 헤더는 첫 번째 데이터에서만 가져오거나 생략 (데이터 구조상 헤더가 포함된 경우도 있음)
        // 여기서는 단순히 모든 행을 추가 (헤더 중복 가능성 유의)
        data.forEach(row => orderSheetRows.push(row));
      });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(orderSheetRows), '발주');
    }

    // 5. 송장 시트 (복구)
    if (allInvoiceRows.length > 0) {
      const invoiceSheetRows: any[][] = [];
      allInvoiceRows.forEach(({ data }) => {
        data.forEach(row => invoiceSheetRows.push(row));
      });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(invoiceSheetRows), '송장');
    }

    // 6. 입금 시트 (복구)
    if (allDepositData.records.length > 0) {
      // 헤더: 은행, 계좌, 금액, 비고, 날짜
      const depositSheetRows: any[][] = [['은행', '계좌번호', '금액', '비고', '날짜']];
      allDepositData.records.forEach(r => {
        depositSheetRows.push([r.bankName, r.accountNumber, r.amount, r.label, r.date]);
      });
      // 합계 행 추가
      depositSheetRows.push(['', '합계', allDepositData.total, '', '']);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(depositSheetRows), '입금');
    }

    // 7. 마진 시트 (신규 추가)
    const marginRows: any[][] = [['품목', '총수량', '총합계', '총마진']];
    productSummary.forEach(([name, data]) => marginRows.push([name, data.count, data.totalPrice, data.margin]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(marginRows), '마진');

    // 8. 반품 시트 (마진시트와 동일 양식, -금액)
    if (allReturnData.records.length > 0) {
      const returnRows: any[][] = [['업체', '품목', '수량', '개당마진', '반품마진']];
      allReturnData.records.forEach(r => {
        returnRows.push([r.company, r.productName, r.count, r.marginPerUnit, r.totalMargin]);
      });
      returnRows.push([]);
      returnRows.push(['', '', '', '총 반품 마진', allReturnData.total]);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(returnRows), '반품');
    }

    const label = dateMode === 'range' ? `${rangeStart}~${rangeEnd}` : selectedYearMonth;
    XLSX.writeFile(wb, `${label}_${businessPrefix}_매출현황.xlsx`);
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
    return `${d.getMonth() + 1}/${d.getDate()} (${weekdays[d.getDay()]})`;
  };

  const periodLabel = dateMode === 'range'
    ? `${rangeStart} ~ ${rangeEnd}`
    : `${selectedYear}년 ${selectedMonth}월`;

  const renderSummaryTable = (
    data: [string, { count: number; totalPrice: number; margin: number }][],
    labelHeader: string,
    isCompany: boolean
  ) => (
    <div className="p-6">
      <table className="w-full text-left">
        <thead>
          <tr className="text-zinc-600 text-[10px] font-black uppercase tracking-widest border-b border-zinc-800">
            <th className="pb-3 pr-4">{labelHeader}</th>
            <th className="pb-3 pr-4 text-right">총수량</th>
            <th className="pb-3 pr-4 text-right">총매출</th>
            {monthTotalMargin > 0 && <th className="pb-3 text-right">마진</th>}
            <th className="pb-3 text-right">비중</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-900/50">
          {data.map(([name, d]) => (
            <tr key={name} className="text-xs hover:bg-zinc-900/30 transition-colors">
              <td className={`py-3 pr-4 font-bold ${isCompany ? 'text-rose-400' : 'text-zinc-200'}`}>{name}</td>
              <td className="py-3 pr-4 text-right text-zinc-400 font-bold">{d.count}개</td>
              <td className="py-3 pr-4 text-right text-white font-black">{d.totalPrice.toLocaleString()}원</td>
              {monthTotalMargin > 0 && (
                <td className="py-3 text-right text-emerald-500 font-bold">
                  {d.margin > 0 ? `${d.margin.toLocaleString()}원` : '-'}
                </td>
              )}
              <td className="py-3 text-right">
                <div className="flex items-center justify-end gap-2">
                  <div className="w-16 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div className="h-full bg-rose-500 rounded-full" style={{ width: `${monthTotal > 0 ? (d.totalPrice / monthTotal) * 100 : 0}%` }} />
                  </div>
                  <span className="text-zinc-500 font-mono text-[10px] w-10 text-right">
                    {monthTotal > 0 ? ((d.totalPrice / monthTotal) * 100).toFixed(1) : 0}%
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-zinc-700 text-sm">
            <td className="pt-3 font-black text-zinc-400">합계</td>
            <td className="pt-3 text-right font-black text-zinc-400">{monthTotalCount}개</td>
            <td className="pt-3 text-right font-black text-rose-500">{monthTotal.toLocaleString()}원</td>
            {monthTotalMargin > 0 && <td className="pt-3 text-right font-black text-emerald-500">{monthTotalMargin.toLocaleString()}원</td>}
            <td className="pt-3 text-right font-mono text-zinc-500 text-[10px]">100%</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );

  /** 발주내역 렌더링 */
  const renderOrdersView = () => {
    const isSearching = orderSearch.trim().length > 0;
    const totalMatchRows = filteredOrderRows.reduce((s, { data }) => s + data.length, 0);

    return (
      <div className="divide-y divide-zinc-900">
        {/* 검색 입력 */}
        <div className="px-6 py-4">
          <div className="relative">
            <input
              type="text"
              value={orderSearch}
              onChange={e => setOrderSearch(e.target.value)}
              placeholder="이름, 주문번호로 검색..."
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 pl-10 text-sm text-white placeholder-zinc-600 focus:ring-1 focus:ring-blue-500/30 focus:border-blue-500/30 outline-none transition-all"
            />
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            {isSearching && (
              <button onClick={() => setOrderSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400 transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            )}
          </div>
          {isSearching && (
            <p className="text-[11px] text-zinc-500 mt-2 font-bold">
              검색결과: <span className="text-blue-400">{totalMatchRows}건</span> 일치
            </p>
          )}
        </div>

        {allOrderRows.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-zinc-600 font-bold text-sm">해당 기간의 발주 데이터가 없습니다.</p>
          </div>
        ) : filteredOrderRows.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-zinc-600 font-bold text-sm">"{orderSearch}" 에 대한 검색결과가 없습니다.</p>
          </div>
        ) : (
          filteredOrderRows.map(({ date, data }) => (
            <div key={`order-${date}`}>
              <button
                onClick={() => toggleDate(`order-${date}`)}
                className="w-full px-6 py-4 flex items-center justify-between hover:bg-zinc-900/50 transition-all"
              >
                <div className="flex items-center gap-4">
                  <span className="text-white font-black text-sm">{formatDate(date)}</span>
                  <span className="text-[10px] bg-blue-500/10 text-blue-400 px-2.5 py-1 rounded-full font-black border border-blue-500/20">
                    {data.length}행
                  </span>
                </div>
                {(expandedDates.has(`order-${date}`) || isSearching) ? <ChevronUpIcon className="w-4 h-4 text-zinc-600" /> : <ChevronDownIcon className="w-4 h-4 text-zinc-600" />}
              </button>
              {(expandedDates.has(`order-${date}`) || isSearching) && (
                <div className="px-6 pb-4 animate-fade-in overflow-x-auto">
                  <table className="w-full text-left">
                    <tbody className="divide-y divide-zinc-900/50">
                      {data.map((row, i) => (
                        <tr key={i} className="text-xs">
                          {row.map((cell: any, j: number) => (
                            <td key={j} className="py-1.5 pr-3 text-zinc-300 font-mono whitespace-nowrap">
                              {cell != null ? String(cell) : ''}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    );
  };

  /** 송장내역 렌더링 */
  const renderInvoicesView = () => {
    const isSearching = invoiceSearch.trim().length > 0;
    const totalMatchRows = filteredInvoiceRows.reduce((s, { data }) => s + data.length, 0);

    return (
      <div className="divide-y divide-zinc-900">
        {/* 검색 입력 */}
        <div className="px-6 py-4">
          <div className="relative">
            <input
              type="text"
              value={invoiceSearch}
              onChange={e => setInvoiceSearch(e.target.value)}
              placeholder="이름, 주문번호로 검색..."
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 pl-10 text-sm text-white placeholder-zinc-600 focus:ring-1 focus:ring-amber-500/30 focus:border-amber-500/30 outline-none transition-all"
            />
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            {isSearching && (
              <button onClick={() => setInvoiceSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400 transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            )}
          </div>
          {isSearching && (
            <p className="text-[11px] text-zinc-500 mt-2 font-bold">
              검색결과: <span className="text-amber-400">{totalMatchRows}건</span> 일치
            </p>
          )}
        </div>

        {allInvoiceRows.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-zinc-600 font-bold text-sm">해당 기간의 송장 데이터가 없습니다.</p>
          </div>
        ) : filteredInvoiceRows.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-zinc-600 font-bold text-sm">"{invoiceSearch}" 에 대한 검색결과가 없습니다.</p>
          </div>
        ) : (
          filteredInvoiceRows.map(({ date, data }) => (
            <div key={`inv-${date}`}>
              <button
                onClick={() => toggleDate(`inv-${date}`)}
                className="w-full px-6 py-4 flex items-center justify-between hover:bg-zinc-900/50 transition-all"
              >
                <div className="flex items-center gap-4">
                  <span className="text-white font-black text-sm">{formatDate(date)}</span>
                  <span className="text-[10px] bg-amber-500/10 text-amber-400 px-2.5 py-1 rounded-full font-black border border-amber-500/20">
                    {data.length}행
                  </span>
                </div>
                {(expandedDates.has(`inv-${date}`) || isSearching) ? <ChevronUpIcon className="w-4 h-4 text-zinc-600" /> : <ChevronDownIcon className="w-4 h-4 text-zinc-600" />}
              </button>
              {(expandedDates.has(`inv-${date}`) || isSearching) && (
                <div className="px-6 pb-4 animate-fade-in overflow-x-auto">
                  <table className="w-full text-left">
                    <tbody className="divide-y divide-zinc-900/50">
                      {data.map((row, i) => (
                        <tr key={i} className="text-xs">
                          {row.map((cell: any, j: number) => (
                            <td key={j} className="py-1.5 pr-3 text-zinc-300 font-mono whitespace-nowrap">
                              {cell != null ? String(cell) : ''}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    );
  };

  /** 입금내역 렌더링 */
  const renderDepositsView = () => {
    const { records, total } = allDepositData;
    if (records.length === 0) {
      return (
        <div className="p-12 text-center">
          <p className="text-zinc-600 font-bold text-sm">해당 기간의 입금 데이터가 없습니다.</p>
        </div>
      );
    }

    // 날짜별로 그룹핑
    const byDate = new Map<string, (DepositRecord & { date: string })[]>();
    records.forEach(r => {
      const list = byDate.get(r.date) || [];
      list.push(r);
      byDate.set(r.date, list);
    });

    return (
      <div className="divide-y divide-zinc-900">
        <div className="px-6 py-4 flex items-center justify-between bg-zinc-900/30">
          <span className="text-zinc-400 font-black text-xs">기간 총 입금액</span>
          <span className="text-emerald-400 font-black text-lg">{total.toLocaleString()}원</span>
        </div>
        {Array.from(byDate.entries()).map(([date, recs]) => {
          const dayTotal = recs.reduce((s, r) => s + r.amount, 0);
          return (
            <div key={`dep-${date}`}>
              <button
                onClick={() => toggleDate(`dep-${date}`)}
                className="w-full px-6 py-4 flex items-center justify-between hover:bg-zinc-900/50 transition-all"
              >
                <div className="flex items-center gap-4">
                  <span className="text-white font-black text-sm">{formatDate(date)}</span>
                  <span className="text-[10px] bg-emerald-500/10 text-emerald-400 px-2.5 py-1 rounded-full font-black border border-emerald-500/20">
                    {recs.length}건
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-emerald-400 font-black text-sm">{dayTotal.toLocaleString()}원</span>
                  {expandedDates.has(`dep-${date}`) ? <ChevronUpIcon className="w-4 h-4 text-zinc-600" /> : <ChevronDownIcon className="w-4 h-4 text-zinc-600" />}
                </div>
              </button>
              {expandedDates.has(`dep-${date}`) && (
                <div className="px-6 pb-4 animate-fade-in">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="text-zinc-600 text-[10px] font-black uppercase tracking-widest">
                        <th className="pb-2 pr-4">은행</th>
                        <th className="pb-2 pr-4">계좌번호</th>
                        <th className="pb-2 pr-4">업체명</th>
                        <th className="pb-2 pr-4 text-right">금액</th>
                        <th className="pb-2">비고</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-900/50">
                      {recs.map((r, i) => (
                        <tr key={i} className="text-xs">
                          <td className="py-2 pr-4 font-bold text-zinc-300">{r.bankName}</td>
                          <td className="py-2 pr-4 text-zinc-400 font-mono">{r.accountNumber}</td>
                          <td className="py-2 pr-4 text-rose-400 font-bold">{accountToCompanyMap.get(r.accountNumber) || ''}</td>
                          <td className="py-2 pr-4 text-right text-emerald-400 font-black">{r.amount.toLocaleString()}원</td>
                          <td className="py-2 text-zinc-500">{r.label || ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  /** 마진시트 렌더링 */
  const renderMarginView = () => {
    const { records, total } = allMarginData;
    if (records.length === 0) {
      return (
        <div className="p-12 text-center">
          <p className="text-zinc-600 font-bold text-sm">해당 기간의 마진 데이터가 없습니다.</p>
        </div>
      );
    }

    // 날짜별로 그룹핑
    const byDate = new Map<string, (MarginRecord & { date: string })[]>();
    records.forEach(r => {
      const list = byDate.get(r.date) || [];
      list.push(r);
      byDate.set(r.date, list);
    });

    // 품목별 마진 합산
    const productMarginMap = new Map<string, { count: number; totalMargin: number; sellingPrice: number; supplyPrice: number; marginPerUnit: number }>();
    records.forEach(r => {
      const existing = productMarginMap.get(r.productName) || { count: 0, totalMargin: 0, sellingPrice: r.sellingPrice, supplyPrice: r.supplyPrice, marginPerUnit: r.marginPerUnit };
      existing.count += r.count;
      existing.totalMargin += r.totalMargin;
      productMarginMap.set(r.productName, existing);
    });
    const productMarginSummary = Array.from(productMarginMap.entries()).sort(([, a], [, b]) => b.totalMargin - a.totalMargin);

    return (
      <div className="divide-y divide-zinc-900">
        {/* 총 마진/비용/순이익 요약 */}
        <div className="px-6 py-4 flex items-center justify-between bg-zinc-900/30">
          <span className="text-zinc-400 font-black text-xs">기간 총 마진</span>
          <span className="text-emerald-400 font-black text-lg">{total.toLocaleString()}원</span>
        </div>
        {allReturnData.total < 0 && (
          <div className="px-6 py-3 flex items-center justify-between bg-zinc-900/20">
            <span className="text-zinc-400 font-black text-xs">기간 총 반품</span>
            <span className="text-violet-400 font-black text-lg">{allReturnData.total.toLocaleString()}원</span>
          </div>
        )}
        {allExpenseData.total > 0 && (
          <div className="px-6 py-3 flex items-center justify-between bg-zinc-900/20">
            <span className="text-zinc-400 font-black text-xs">기간 총 비용</span>
            <span className="text-orange-400 font-black text-lg">-{allExpenseData.total.toLocaleString()}원</span>
          </div>
        )}
        {(allExpenseData.total > 0 || allReturnData.total < 0) && (
          <div className="px-6 py-3 flex items-center justify-between bg-zinc-900/40">
            <span className="text-zinc-400 font-black text-xs">순수익</span>
            <span className={`font-black text-lg ${total + allReturnData.total - allExpenseData.total >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {(total + allReturnData.total - allExpenseData.total).toLocaleString()}원
            </span>
          </div>
        )}

        {/* 품목별 마진 요약 테이블 */}
        <div className="p-6">
          <h4 className="text-zinc-500 font-black text-[10px] uppercase tracking-widest mb-3">품목별 마진 요약</h4>
          <table className="w-full text-left">
            <thead>
              <tr className="text-zinc-600 text-[10px] font-black uppercase tracking-widest border-b border-zinc-800">
                <th className="pb-3 pr-4">품목</th>
                <th className="pb-3 pr-4 text-right">수량</th>
                <th className="pb-3 pr-4 text-right">판매가</th>
                <th className="pb-3 pr-4 text-right">공급가</th>
                <th className="pb-3 pr-4 text-right">개당 마진</th>
                <th className="pb-3 text-right">총마진</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900/50">
              {productMarginSummary.map(([name, d]) => (
                <tr key={name} className="text-xs hover:bg-zinc-900/30 transition-colors">
                  <td className="py-3 pr-4 font-bold text-zinc-200">{name}</td>
                  <td className="py-3 pr-4 text-right text-zinc-400 font-bold">{d.count}개</td>
                  <td className="py-3 pr-4 text-right text-zinc-400 font-mono">{d.sellingPrice.toLocaleString()}원</td>
                  <td className="py-3 pr-4 text-right text-zinc-500 font-mono">{d.supplyPrice.toLocaleString()}원</td>
                  <td className="py-3 pr-4 text-right text-emerald-500 font-bold">{d.marginPerUnit.toLocaleString()}원</td>
                  <td className="py-3 text-right text-emerald-400 font-black">{d.totalMargin.toLocaleString()}원</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-zinc-700 text-sm">
                <td className="pt-3 font-black text-zinc-400">합계</td>
                <td className="pt-3 text-right font-black text-zinc-400">{records.reduce((s, r) => s + r.count, 0)}개</td>
                <td className="pt-3" colSpan={3}></td>
                <td className="pt-3 text-right font-black text-emerald-500">{total.toLocaleString()}원</td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* 날짜별 상세 */}
        {Array.from(byDate.entries()).map(([date, recs]) => {
          const dayTotal = recs.reduce((s, r) => s + r.totalMargin, 0);
          return (
            <div key={`margin-${date}`}>
              <button
                onClick={() => toggleDate(`margin-${date}`)}
                className="w-full px-6 py-4 flex items-center justify-between hover:bg-zinc-900/50 transition-all"
              >
                <div className="flex items-center gap-4">
                  <span className="text-white font-black text-sm">{formatDate(date)}</span>
                  <span className="text-[10px] bg-emerald-500/10 text-emerald-400 px-2.5 py-1 rounded-full font-black border border-emerald-500/20">
                    {recs.length}개 품목
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-emerald-400 font-black text-sm">{dayTotal.toLocaleString()}원</span>
                  {expandedDates.has(`margin-${date}`) ? <ChevronUpIcon className="w-4 h-4 text-zinc-600" /> : <ChevronDownIcon className="w-4 h-4 text-zinc-600" />}
                </div>
              </button>
              {expandedDates.has(`margin-${date}`) && (
                <div className="px-6 pb-4 animate-fade-in">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="text-zinc-600 text-[10px] font-black uppercase tracking-widest">
                        <th className="pb-2 pr-4">등록상품명</th>
                        <th className="pb-2 pr-4">품목</th>
                        <th className="pb-2 pr-4 text-right">수량</th>
                        <th className="pb-2 pr-4 text-right">판매가</th>
                        <th className="pb-2 pr-4 text-right">공급가</th>
                        <th className="pb-2 pr-4 text-right">개당 마진</th>
                        <th className="pb-2 text-right">총마진</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-900/50">
                      {recs.map((r, i) => (
                        <tr key={i} className="text-xs">
                          <td className="py-2 pr-4 font-bold text-rose-400">{r.registeredName}</td>
                          <td className="py-2 pr-4 font-bold text-zinc-300">{r.productName}</td>
                          <td className="py-2 pr-4 text-right text-zinc-400 font-bold">{r.count}개</td>
                          <td className="py-2 pr-4 text-right text-zinc-400 font-mono">{r.sellingPrice.toLocaleString()}</td>
                          <td className="py-2 pr-4 text-right text-zinc-500 font-mono">{r.supplyPrice.toLocaleString()}</td>
                          <td className="py-2 pr-4 text-right text-emerald-500 font-bold">{r.marginPerUnit.toLocaleString()}</td>
                          <td className="py-2 text-right text-emerald-400 font-black">{r.totalMargin.toLocaleString()}원</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  /** 반품시트 렌더링 */
  const renderReturnView = () => {
    const { records, total } = allReturnData;

    // 날짜별로 그룹핑
    const byDate = new Map<string, (ReturnRecord & { date: string })[]>();
    records.forEach(r => {
      const list = byDate.get(r.date) || [];
      list.push(r);
      byDate.set(r.date, list);
    });

    // 품목별 반품 합산
    const productReturnMap = new Map<string, { count: number; totalMargin: number; marginPerUnit: number; company: string }>();
    records.forEach(r => {
      const key = `${r.company}::${r.productName}`;
      const existing = productReturnMap.get(key) || { count: 0, totalMargin: 0, marginPerUnit: r.marginPerUnit, company: r.company };
      existing.count += r.count;
      existing.totalMargin += r.totalMargin;
      productReturnMap.set(key, existing);
    });
    const productReturnSummary = Array.from(productReturnMap.entries()).sort(([, a], [, b]) => a.totalMargin - b.totalMargin);

    return (
      <div className="divide-y divide-zinc-900">
        {/* 총 반품 마진 */}
        {records.length > 0 && (
          <div className="px-6 py-4 flex items-center justify-between bg-zinc-900/30">
            <span className="text-zinc-400 font-black text-xs">기간 총 반품 마진</span>
            <span className="text-violet-400 font-black text-lg">{total.toLocaleString()}원</span>
          </div>
        )}

        {/* 품목별 반품 요약 테이블 */}
        {productReturnSummary.length > 0 && (
          <div className="p-6">
            <h4 className="text-zinc-500 font-black text-[10px] uppercase tracking-widest mb-3">품목별 반품 요약</h4>
            <table className="w-full text-left">
              <thead>
                <tr className="text-zinc-600 text-[10px] font-black uppercase tracking-widest border-b border-zinc-800">
                  <th className="pb-3 pr-4">업체</th>
                  <th className="pb-3 pr-4">품목</th>
                  <th className="pb-3 pr-4 text-right">수량</th>
                  <th className="pb-3 pr-4 text-right">개당 마진</th>
                  <th className="pb-3 text-right">반품 마진</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900/50">
                {productReturnSummary.map(([key, d]) => {
                  const productName = key.split('::')[1];
                  return (
                    <tr key={key} className="text-xs hover:bg-zinc-900/30 transition-colors">
                      <td className="py-3 pr-4 font-bold text-violet-400">{d.company}</td>
                      <td className="py-3 pr-4 font-bold text-zinc-200">{productName}</td>
                      <td className="py-3 pr-4 text-right text-zinc-400 font-bold">{d.count}개</td>
                      <td className="py-3 pr-4 text-right text-zinc-400 font-mono">{d.marginPerUnit.toLocaleString()}원</td>
                      <td className="py-3 text-right text-violet-400 font-black">{d.totalMargin.toLocaleString()}원</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-zinc-700 text-sm">
                  <td className="pt-3 font-black text-zinc-400" colSpan={2}>합계</td>
                  <td className="pt-3 text-right font-black text-zinc-400">{records.reduce((s, r) => s + r.count, 0)}개</td>
                  <td className="pt-3"></td>
                  <td className="pt-3 text-right font-black text-violet-500">{total.toLocaleString()}원</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* 날짜별 상세 */}
        {Array.from(byDate.entries()).map(([date, recs]) => {
          const dayTotal = recs.reduce((s, r) => s + r.totalMargin, 0);
          return (
            <div key={`return-${date}`}>
              <button
                onClick={() => toggleDate(`return-${date}`)}
                className="w-full px-6 py-4 flex items-center justify-between hover:bg-zinc-900/50 transition-all"
              >
                <div className="flex items-center gap-4">
                  <span className="text-white font-black text-sm">{formatDate(date)}</span>
                  <span className="text-[10px] bg-violet-500/10 text-violet-400 px-2.5 py-1 rounded-full font-black border border-violet-500/20">
                    {recs.length}건 반품
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-violet-400 font-black text-sm">{dayTotal.toLocaleString()}원</span>
                  {expandedDates.has(`return-${date}`) ? <ChevronUpIcon className="w-4 h-4 text-zinc-600" /> : <ChevronDownIcon className="w-4 h-4 text-zinc-600" />}
                </div>
              </button>
              {expandedDates.has(`return-${date}`) && (
                <div className="px-6 pb-4 animate-fade-in">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="text-zinc-600 text-[10px] font-black uppercase tracking-widest">
                        <th className="pb-2 pr-4">업체</th>
                        <th className="pb-2 pr-4">품목</th>
                        <th className="pb-2 pr-4">사유</th>
                        <th className="pb-2 pr-4 text-right">수량</th>
                        <th className="pb-2 pr-4 text-right">개당 마진</th>
                        <th className="pb-2 pr-4 text-right">반품 마진</th>
                        <th className="pb-2 text-right">삭제</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-900/50">
                      {recs.map((r, i) => (
                        <tr key={i} className="text-xs">
                          <td className="py-2 pr-4 font-bold text-violet-400">{r.company}</td>
                          <td className="py-2 pr-4 font-bold text-zinc-300">{r.productName}</td>
                          <td className="py-2 pr-4 text-zinc-500">{r.memo || ''}</td>
                          <td className="py-2 pr-4 text-right text-zinc-400 font-bold">{r.count}개</td>
                          <td className="py-2 pr-4 text-right text-zinc-400 font-mono">{r.marginPerUnit.toLocaleString()}원</td>
                          <td className="py-2 pr-4 text-right text-violet-400 font-black">{r.totalMargin.toLocaleString()}원</td>
                          <td className="py-2 text-right">
                            <button
                              onClick={() => handleDeleteReturn(date, i)}
                              className="text-zinc-700 hover:text-violet-400 p-1 transition-colors"
                            >
                              <TrashIcon className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}

        {records.length === 0 && (
          <div className="p-12 text-center">
            <p className="text-zinc-600 font-bold text-sm">해당 기간의 반품 데이터가 없습니다.</p>
            <p className="text-zinc-700 text-xs mt-2">발주서/송장 관리 탭의 반품 관리에서 반품을 등록하세요.</p>
          </div>
        )}
      </div>
    );
  };

  /** 업체별정산 렌더링 */
  const renderSettlementView = () => {
    if (filteredHistory.length === 0) {
      return (
        <div className="p-12 text-center">
          <p className="text-zinc-600 font-bold text-sm">해당 기간의 정산 데이터가 없습니다.</p>
        </div>
      );
    }

    // 이 기간에 등장한 업체 목록
    const companies = Array.from(
      new Set(filteredHistory.flatMap(d => d.records.map(r => r.company)))
    ).sort();
    const activeCompany = settlementCompany && companies.includes(settlementCompany)
      ? settlementCompany
      : companies[0] || '';

    // 선택 업체의 날짜별 데이터
    const daysForCompany = filteredHistory
      .map(day => ({
        date: day.date,
        records: day.records.filter(r => r.company === activeCompany),
      }))
      .filter(d => d.records.length > 0);

    const periodTotal = daysForCompany.reduce(
      (s, d) => s + d.records.reduce((ss, r) => ss + r.totalPrice, 0), 0
    );
    const periodCount = daysForCompany.reduce(
      (s, d) => s + d.records.reduce((ss, r) => ss + r.count, 0), 0
    );

    const handleCopySettlement = () => {
      const lines: string[] = ['날짜\t품목\t수량\t단가\t합계'];
      daysForCompany.forEach(({ date, records }) => {
        records.forEach((r, i) => {
          lines.push([i === 0 ? date : '', r.product, r.count, r.supplyPrice, r.totalPrice].join('\t'));
        });
      });
      lines.push(['합계', '', periodCount, '', periodTotal].join('\t'));
      navigator.clipboard.writeText(lines.join('\n'));
    };

    return (
      <div className="space-y-3">
        {/* 업체 탭 + 복사 버튼 */}
        <div className="flex flex-wrap gap-1.5 items-center">
          {companies.map(c => (
            <button key={c} onClick={() => setSettlementCompany(c)}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${activeCompany === c ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'}`}>
              {c}
            </button>
          ))}
          <button onClick={handleCopySettlement}
            className="ml-auto px-3 py-1.5 text-xs font-bold rounded-lg bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-all">
            복사
          </button>
        </div>

        {/* 엑셀형 테이블 */}
        <div className="overflow-x-auto rounded-xl border border-zinc-700">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-zinc-800 text-zinc-400">
                <th className="py-1.5 px-3 text-left font-semibold border-b border-r border-zinc-700 w-24">날짜</th>
                <th className="py-1.5 px-3 text-left font-semibold border-b border-r border-zinc-700">품목</th>
                <th className="py-1.5 px-3 text-right font-semibold border-b border-r border-zinc-700 w-14">수량</th>
                <th className="py-1.5 px-3 text-right font-semibold border-b border-r border-zinc-700 w-24">단가</th>
                <th className="py-1.5 px-3 text-right font-semibold border-b border-zinc-700 w-24">합계</th>
              </tr>
            </thead>
            <tbody>
              {daysForCompany.map(({ date, records }, dayIdx) => {
                const isEven = dayIdx % 2 === 0;
                const rowBg = isEven ? 'bg-zinc-900' : 'bg-zinc-900/40';
                return records.map((r, i) => (
                  <tr key={`${date}-${i}`} className={`${rowBg} hover:brightness-125 transition-all ${i === 0 && dayIdx !== 0 ? 'border-t-2 border-zinc-600' : 'border-t border-zinc-800/60'}`}>
                    {i === 0 ? (
                      <td rowSpan={records.length} className="py-1.5 px-3 font-bold text-zinc-200 border-r border-zinc-700 align-middle whitespace-nowrap">
                        {formatDate(date)}
                      </td>
                    ) : null}
                    <td className="py-1 px-3 text-zinc-300 border-r border-zinc-800">{r.product}</td>
                    <td className="py-1 px-3 text-right text-zinc-400 border-r border-zinc-800 tabular-nums">{r.count}</td>
                    <td className="py-1 px-3 text-right text-zinc-500 border-r border-zinc-800 tabular-nums">{r.supplyPrice.toLocaleString()}</td>
                    <td className="py-1 px-3 text-right text-zinc-200 font-semibold tabular-nums">{r.totalPrice.toLocaleString()}</td>
                  </tr>
                ));
              })}
              {/* 합계 행 */}
              <tr className="bg-zinc-800 border-t-2 border-zinc-600">
                <td colSpan={2} className="py-1.5 px-3 text-zinc-300 font-bold border-r border-zinc-700">합계</td>
                <td className="py-1.5 px-3 text-right text-zinc-200 font-bold border-r border-zinc-700 tabular-nums">{periodCount}</td>
                <td className="py-1.5 px-3 border-r border-zinc-700" />
                <td className="py-1.5 px-3 text-right text-white font-black tabular-nums">{periodTotal.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderTrendView = () => {
    const formatVal = (v: number) => {
      if (v === 0) return '';
      return trendMetric === 'count' ? `${v}` : `${v.toLocaleString()}`;
    };

    const productRows = Array.from(trendData.entries())
      .map(([name, dateMap]) => ({ name, dateMap }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));

    return (
      <div className="space-y-4">
        {/* 컨트롤 */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex gap-1 bg-zinc-900 rounded-xl p-1">
            {([['count', '수량'], ['totalPrice', '매출'], ['margin', '마진']] as const).map(([key, label]) => (
              <button key={key} onClick={() => setTrendMetric(key as typeof trendMetric)}
                className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${trendMetric === key ? 'bg-rose-500 text-white' : 'text-zinc-500 hover:text-white'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 업체 탭 */}
        <div className="flex flex-wrap gap-2">
          {trendCompanies.map(c => (
            <button key={c} onClick={() => setTrendCompany(c)}
              className={`px-4 py-2 text-xs font-bold rounded-xl transition-all ${trendActiveCompany === c ? 'bg-rose-500 text-white shadow-lg shadow-rose-900/20' : 'bg-zinc-800 text-zinc-400 hover:text-white'}`}>
              {c}
            </button>
          ))}
        </div>

        {/* 트렌드 테이블 */}
        {productRows.length === 0 ? (
          <p className="text-zinc-600 text-sm py-8 text-center">데이터 없음</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-sm border-collapse">
              <thead>
                <tr className="text-zinc-500 text-xs border-b border-zinc-700">
                  <th className="text-left py-2 px-3 font-bold whitespace-nowrap sticky left-0 bg-zinc-950 z-10 border-r border-zinc-700">품목명</th>
                  {trendDates.map(date => (
                    <th key={date} className="py-2 px-3 font-bold text-center whitespace-nowrap min-w-[40px]">
                      {parseInt(date.slice(8))}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {productRows.map(({ name, dateMap }) => (
                  <tr key={name} className="border-b border-zinc-800/50 hover:bg-zinc-800/20">
                    <td className="py-2 px-3 font-bold text-zinc-200 whitespace-nowrap sticky left-0 bg-zinc-950 border-r border-zinc-800">{name}</td>
                    {trendDates.map(date => {
                      const val = dateMap.get(date) || 0;
                      return (
                        <td key={date} className="py-2 px-3 text-center text-zinc-300 tabular-nums">
                          {formatVal(val)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderMonthlyAnalysisView = () => {
    const { productMonthMargin, monthExpenses, months, products, expenseCategories } = monthlyAnalysisData;
    if (months.length === 0) {
      return (
        <div className="p-12 text-center">
          <p className="text-zinc-600 font-bold text-sm">{selectedYear}년 마진 데이터가 없습니다.</p>
        </div>
      );
    }

    // 히트맵 색상 계산 (양수: 에메랄드, 음수: 로즈)
    const getHeatColor = (value: number, max: number) => {
      if (value === 0 || max === 0) return '';
      const intensity = Math.min(Math.abs(value) / max, 1);
      if (value > 0) return `rgba(16, 185, 129, ${0.08 + intensity * 0.35})`;
      return `rgba(244, 63, 94, ${0.08 + intensity * 0.35})`;
    };

    // 테이블1: 품목별 순이익의 최대값
    const allMarginValues = products.flatMap(p =>
      months.map(m => productMonthMargin.get(p.name)?.get(m) || 0)
    );
    const maxMargin = Math.max(...allMarginValues.map(Math.abs), 1);

    // 월별 마진 합계
    const monthMarginTotals = months.map(m =>
      products.reduce((sum, p) => sum + (productMonthMargin.get(p.name)?.get(m) || 0), 0)
    );
    const annualMarginTotal = monthMarginTotals.reduce((s, v) => s + v, 0);

    // 테이블2: 월별 비용 합계
    const monthExpenseTotals = months.map(m => monthExpenses.get(m)?.total || 0);
    const annualExpenseTotal = monthExpenseTotals.reduce((s, v) => s + v, 0);

    // 월별 실질 순수익
    const monthNetTotals = months.map((m, i) => monthMarginTotals[i] - monthExpenseTotals[i]);
    const annualNetTotal = annualMarginTotal - annualExpenseTotal;
    const maxNet = Math.max(...monthNetTotals.map(Math.abs), 1);

    return (
      <div className="divide-y divide-zinc-900">
        {/* 테이블 1: 품목별 순이익 히트맵 */}
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <span className="text-emerald-400 text-lg">📊</span>
            <h3 className="text-white font-black text-sm uppercase tracking-widest">{selectedYear}년 품목별 순이익</h3>
            <span className="text-[10px] bg-emerald-500/10 text-emerald-400 px-2.5 py-1 rounded-full font-black border border-emerald-500/20">
              연간 {annualMarginTotal.toLocaleString()}원
            </span>
          </div>
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-left min-w-[600px]">
              <thead>
                <tr className="text-zinc-600 text-[10px] font-black uppercase tracking-widest border-b border-zinc-800">
                  <th className="pb-2 pr-3 sticky left-0 bg-zinc-900/90 backdrop-blur-sm z-10">품목</th>
                  {months.map(m => (
                    <th key={m} className="pb-2 px-2 text-right whitespace-nowrap">{m}월</th>
                  ))}
                  <th className="pb-2 pl-3 text-right border-l border-zinc-800">연간합계</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900/30">
                {products.map(p => (
                  <tr key={p.name} className="text-xs group">
                    <td className="py-2.5 pr-3 font-bold text-zinc-300 sticky left-0 bg-zinc-900/90 backdrop-blur-sm z-10 group-hover:text-white transition-colors">{p.name}</td>
                    {months.map(m => {
                      const val = productMonthMargin.get(p.name)?.get(m) || 0;
                      return (
                        <td key={m} className="py-2.5 px-2 text-right font-mono tabular-nums" style={{ background: getHeatColor(val, maxMargin) }}>
                          <span className={val > 0 ? 'text-emerald-400 font-bold' : val < 0 ? 'text-rose-400 font-bold' : 'text-zinc-700'}>
                            {val === 0 ? '-' : val.toLocaleString()}
                          </span>
                        </td>
                      );
                    })}
                    <td className={`py-2.5 pl-3 text-right font-black border-l border-zinc-800 ${p.annualTotal > 0 ? 'text-emerald-400' : p.annualTotal < 0 ? 'text-rose-400' : 'text-zinc-600'}`}>
                      {p.annualTotal.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-zinc-700 text-xs font-black">
                  <td className="py-3 pr-3 text-zinc-400 sticky left-0 bg-zinc-900/90 backdrop-blur-sm z-10">월합계</td>
                  {monthMarginTotals.map((total, i) => (
                    <td key={months[i]} className={`py-3 px-2 text-right ${total > 0 ? 'text-emerald-400' : total < 0 ? 'text-rose-400' : 'text-zinc-600'}`}>
                      {total.toLocaleString()}
                    </td>
                  ))}
                  <td className={`py-3 pl-3 text-right border-l border-zinc-800 text-base ${annualMarginTotal > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {annualMarginTotal.toLocaleString()}원
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        {/* 테이블 2: 실질 순수익 (마진 - 비용) */}
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <span className="text-rose-400 text-lg">💰</span>
            <h3 className="text-white font-black text-sm uppercase tracking-widest">{selectedYear}년 실질 순수익</h3>
            <span className={`text-[10px] px-2.5 py-1 rounded-full font-black border ${annualNetTotal >= 0 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border-rose-500/20'}`}>
              연간 {annualNetTotal.toLocaleString()}원
            </span>
          </div>
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-left min-w-[600px]">
              <thead>
                <tr className="text-zinc-600 text-[10px] font-black uppercase tracking-widest border-b border-zinc-800">
                  <th className="pb-2 pr-3 sticky left-0 bg-zinc-900/90 backdrop-blur-sm z-10">항목</th>
                  {months.map(m => (
                    <th key={m} className="pb-2 px-2 text-right whitespace-nowrap">{m}월</th>
                  ))}
                  <th className="pb-2 pl-3 text-right border-l border-zinc-800">연간합계</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900/30">
                {/* 품목별 마진 합계 */}
                <tr className="text-xs">
                  <td className="py-2.5 pr-3 font-bold text-emerald-400 sticky left-0 bg-zinc-900/90 backdrop-blur-sm z-10">품목 마진 합계</td>
                  {monthMarginTotals.map((v, i) => (
                    <td key={months[i]} className="py-2.5 px-2 text-right font-mono tabular-nums text-emerald-400 font-bold">
                      {v === 0 ? '-' : v.toLocaleString()}
                    </td>
                  ))}
                  <td className="py-2.5 pl-3 text-right font-black text-emerald-400 border-l border-zinc-800">{annualMarginTotal.toLocaleString()}</td>
                </tr>
                {/* 비용 카테고리별 */}
                {expenseCategories.map(cat => (
                  <tr key={cat} className="text-xs group">
                    <td className="py-2.5 pr-3 font-bold text-rose-400/70 sticky left-0 bg-zinc-900/90 backdrop-blur-sm z-10 group-hover:text-rose-400 transition-colors">- {cat}</td>
                    {months.map(m => {
                      const val = monthExpenses.get(m)?.byCategory.get(cat) || 0;
                      return (
                        <td key={m} className="py-2.5 px-2 text-right font-mono tabular-nums text-rose-400/70">
                          {val === 0 ? '-' : `-${val.toLocaleString()}`}
                        </td>
                      );
                    })}
                    <td className="py-2.5 pl-3 text-right font-bold text-rose-400/70 border-l border-zinc-800">
                      -{months.reduce((s, m) => s + (monthExpenses.get(m)?.byCategory.get(cat) || 0), 0).toLocaleString()}
                    </td>
                  </tr>
                ))}
                {/* 비용 소계 */}
                <tr className="text-xs border-t border-zinc-800">
                  <td className="py-2.5 pr-3 font-bold text-rose-400 sticky left-0 bg-zinc-900/90 backdrop-blur-sm z-10">비용 합계</td>
                  {monthExpenseTotals.map((v, i) => (
                    <td key={months[i]} className="py-2.5 px-2 text-right font-mono tabular-nums text-rose-400 font-bold">
                      {v === 0 ? '-' : `-${v.toLocaleString()}`}
                    </td>
                  ))}
                  <td className="py-2.5 pl-3 text-right font-black text-rose-400 border-l border-zinc-800">-{annualExpenseTotal.toLocaleString()}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-zinc-700 text-xs font-black">
                  <td className="py-3 pr-3 text-white sticky left-0 bg-zinc-900/90 backdrop-blur-sm z-10">실질 순수익</td>
                  {monthNetTotals.map((v, i) => (
                    <td key={months[i]} className="py-3 px-2 text-right" style={{ background: getHeatColor(v, maxNet) }}>
                      <span className={v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-zinc-600'}>
                        {v.toLocaleString()}
                      </span>
                    </td>
                  ))}
                  <td className={`py-3 pl-3 text-right text-base border-l border-zinc-800 ${annualNetTotal >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {annualNetTotal.toLocaleString()}원
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>
    );
  };

  const tabs: [ViewMode, string][] = [
    ['settlement', '업체별정산'],
    ['byDate', '날짜별'],
    ['byProduct', '품목별'],
    ['byCompany', '업체별'],
    ['trend', '판매추이'],
    ['orders', '발주내역'],
    ['invoices', '송장내역'],
    ['deposits', '입금내역'],
    ['margin', '마진시트'],
    ['returns', '반품'],
    ['monthlyAnalysis', '월별분석'],
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* 업무일지 업로드 영역 */}
      <section
        className="bg-zinc-900/60 rounded-[2.5rem] p-6 border border-zinc-800 shadow-2xl backdrop-blur-md"
        onDragOver={e => e.preventDefault()}
        onDrop={handleDrop}
      >
        <div className="flex flex-col md:flex-row items-center gap-4">
          <div className="flex-1 w-full">
            <div
              className="border-2 border-dashed border-zinc-700 hover:border-rose-500/50 rounded-2xl p-6 text-center cursor-pointer transition-all"
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadIcon className="w-8 h-8 text-zinc-600 mx-auto mb-2" />
              <p className="text-zinc-400 font-bold text-sm">업무일지 엑셀 파일 업로드</p>
              <p className="text-zinc-600 text-[10px] mt-1">여러 파일을 한번에 드래그하거나 선택할 수 있습니다 (.xlsx)</p>
              <p className="text-zinc-700 text-[10px] mt-0.5">파일명에서 날짜를 자동 인식합니다 (예: 2026-02-10_업무일지.xlsx)</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              multiple
              className="hidden"
              onChange={e => handleImportFiles(e.target.files)}
            />
          </div>
          {importStatus && (
            <div className={`px-4 py-2 rounded-xl text-xs font-bold animate-pop-in ${importStatus.includes('완료') ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
              }`}>
              {importStatus}
            </div>
          )}
          {isImporting && (
            <div className="px-4 py-2 rounded-xl text-xs font-bold bg-zinc-800 text-zinc-400 border border-zinc-700 animate-pulse">
              처리 중...
            </div>
          )}
        </div>
      </section>

      {/* 헤더 + 날짜 선택 */}
      <section className="bg-zinc-900/60 rounded-[2.5rem] p-6 border border-zinc-800 shadow-2xl backdrop-blur-md">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="bg-rose-500/10 p-4 rounded-[1.5rem] border border-rose-500/20 shadow-inner">
                <span className="text-3xl">📊</span>
              </div>
              <div>
                <h2 className="text-zinc-500 font-black text-[10px] uppercase tracking-[0.2em] mb-0.5">
                  {periodLabel} 매출현황
                </h2>
                <div className="flex items-baseline gap-2">
                  <span className="text-4xl font-black text-white">{monthTotal.toLocaleString()}</span>
                  <span className="text-xl font-black text-rose-500">원</span>
                </div>
                <div className="flex gap-3 mt-1">
                  <span className="text-[11px] text-zinc-500 font-bold">총 {monthTotalCount}건</span>
                  {allMarginData.total > 0 && (
                    <span className="text-[11px] text-emerald-500 font-bold">마진 {allMarginData.total.toLocaleString()}원</span>
                  )}
                  {allReturnData.total < 0 && (
                    <span className="text-[11px] text-violet-400 font-bold">반품 {allReturnData.total.toLocaleString()}원</span>
                  )}
                  {allMarginData.total > 0 && allReturnData.total < 0 && (
                    <span className={`text-[11px] font-black ${allMarginData.total + allReturnData.total >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      순수익 {(allMarginData.total + allReturnData.total).toLocaleString()}원
                    </span>
                  )}
                  <span className="text-[11px] text-zinc-600 font-bold">{filteredHistory.length}일 기록</span>
                  {allDepositData.total > 0 && (
                    <span className="text-[11px] text-emerald-400 font-bold">입금 {allDepositData.total.toLocaleString()}원</span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* 월별 / 기간 토글 */}
              <div className="flex p-1 bg-zinc-950 rounded-xl border border-zinc-800">
                <button
                  onClick={() => setDateMode('month')}
                  className={`px-3 py-1.5 text-[11px] font-black rounded-lg transition-all ${dateMode === 'month' ? 'bg-rose-500 text-white' : 'text-zinc-500 hover:text-white'
                    }`}
                >
                  월별
                </button>
                <button
                  onClick={() => setDateMode('range')}
                  className={`px-3 py-1.5 text-[11px] font-black rounded-lg transition-all ${dateMode === 'range' ? 'bg-rose-500 text-white' : 'text-zinc-500 hover:text-white'
                    }`}
                >
                  기간
                </button>
              </div>
              <button
                onClick={handleExportExcel}
                disabled={filteredHistory.length === 0}
                className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white px-4 py-2.5 rounded-xl font-black text-xs transition-all border border-zinc-700 disabled:opacity-30"
              >
                <ArrowDownTrayIcon className="w-4 h-4" />
                <span>엑셀</span>
              </button>
            </div>
          </div>

          {/* 날짜 선택 영역 */}
          {dateMode === 'month' ? (
            <div className="flex items-center gap-3 flex-wrap">
              <select
                value={selectedYear}
                onChange={e => {
                  const yr = parseInt(e.target.value);
                  setSelectedYear(yr);
                  const monthsInYear = salesHistory
                    .filter(d => d.date.startsWith(String(yr)))
                    .map(d => parseInt(d.date.slice(5, 7)));
                  if (monthsInYear.length > 0) setSelectedMonth(Math.max(...monthsInYear));
                }}
                className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-sm font-black text-white focus:ring-1 focus:ring-rose-500/30 outline-none"
              >
                {availableYears.map(y => (
                  <option key={y} value={y}>{y}년</option>
                ))}
              </select>
              <div className="flex flex-wrap gap-1">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(m => {
                  const hasData = availableMonthsForYear.includes(m);
                  const isSelected = m === selectedMonth;
                  return (
                    <button
                      key={m}
                      onClick={() => setSelectedMonth(m)}
                      className={`w-9 h-9 rounded-lg text-[11px] font-black transition-all ${isSelected
                          ? 'bg-rose-500 text-white shadow-lg shadow-rose-900/30'
                          : hasData
                            ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700'
                            : 'bg-zinc-900/50 text-zinc-700 border border-zinc-800/50'
                        }`}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={rangeStart}
                  onChange={e => setRangeStart(e.target.value)}
                  className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-sm font-black text-white focus:ring-1 focus:ring-rose-500/30 outline-none"
                />
                <span className="text-zinc-500 font-black text-sm">~</span>
                <input
                  type="date"
                  value={rangeEnd}
                  onChange={e => setRangeEnd(e.target.value)}
                  className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-sm font-black text-white focus:ring-1 focus:ring-rose-500/30 outline-none"
                />
              </div>
              {/* 빠른 선택 버튼 */}
              <div className="flex gap-1">
                {[
                  { label: '최근 7일', days: 7 },
                  { label: '최근 30일', days: 30 },
                  { label: '최근 90일', days: 90 },
                ].map(({ label, days }) => (
                  <button
                    key={days}
                    onClick={() => {
                      const end = new Date();
                      const start = new Date();
                      start.setDate(start.getDate() - days + 1);
                      setRangeStart(start.toISOString().slice(0, 10));
                      setRangeEnd(end.toISOString().slice(0, 10));
                    }}
                    className="px-3 py-2 text-[11px] font-black bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700 rounded-lg border border-zinc-700 transition-all"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 뷰 모드 탭 */}
      <div className="flex justify-center">
        <nav className="flex p-1.5 bg-zinc-900 rounded-2xl border border-zinc-800 shadow-xl flex-wrap gap-0.5">
          {tabs.map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`px-4 py-2.5 text-xs font-black rounded-xl transition-all ${viewMode === mode ? 'bg-rose-500 text-white shadow-lg shadow-rose-900/20' : 'text-zinc-500 hover:text-white'
                }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      {filteredHistory.length === 0 ? (
        <div className="bg-zinc-900/40 rounded-[2.5rem] p-12 border border-zinc-800 text-center">
          <p className="text-zinc-600 font-bold text-sm">{periodLabel} 매출 데이터가 없습니다.</p>
          <p className="text-zinc-700 text-xs mt-2">위에서 업무일지 엑셀 파일을 업로드하거나, 발주서/송장 관리 탭에서 업무일지를 다운로드하면 자동 기록됩니다.</p>
        </div>
      ) : (
        <section className="bg-zinc-900/40 rounded-[2.5rem] border border-zinc-800 shadow-2xl overflow-hidden">
          {viewMode === 'byDate' && (
            <div className="divide-y divide-zinc-900">
              {filteredHistory.map(day => (
                <div key={day.date}>
                  <button
                    onClick={() => toggleDate(day.date)}
                    className="w-full px-6 py-4 flex items-center justify-between hover:bg-zinc-900/50 transition-all"
                  >
                    <div className="flex items-center gap-4">
                      <span className="text-white font-black text-sm">{formatDate(day.date)}</span>
                      <span className="text-[10px] bg-zinc-800 text-zinc-400 px-2.5 py-1 rounded-full font-black border border-zinc-700">
                        {day.records.length}개 품목
                      </span>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-rose-500 font-black text-sm">{day.totalAmount.toLocaleString()}원</span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={e => { e.stopPropagation(); if (confirm(`${day.date} 매출 기록을 삭제할까요?`)) remove(day.date); }}
                          className="text-zinc-700 hover:text-rose-500 p-1 transition-colors"
                        >
                          <TrashIcon className="w-3.5 h-3.5" />
                        </button>
                        {expandedDates.has(day.date) ? <ChevronUpIcon className="w-4 h-4 text-zinc-600" /> : <ChevronDownIcon className="w-4 h-4 text-zinc-600" />}
                      </div>
                    </div>
                  </button>
                  {expandedDates.has(day.date) && (
                    <div className="px-6 pb-4 animate-fade-in">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="text-zinc-600 text-[10px] font-black uppercase tracking-widest">
                            <th className="pb-2 pr-4">업체</th>
                            <th className="pb-2 pr-4">품목</th>
                            <th className="pb-2 pr-4 text-right">수량</th>
                            <th className="pb-2 pr-4 text-right">단가</th>
                            <th className="pb-2 text-right">합계</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-900/50">
                          {day.records.map((r, i) => (
                            <tr key={i} className="text-xs">
                              <td className="py-2 pr-4 font-bold text-rose-400">{r.company}</td>
                              <td className="py-2 pr-4 font-bold text-zinc-300">{r.product}</td>
                              <td className="py-2 pr-4 text-right text-zinc-400 font-bold">{r.count}개</td>
                              <td className="py-2 pr-4 text-right text-zinc-500 font-mono">{r.supplyPrice.toLocaleString()}</td>
                              <td className="py-2 text-right text-white font-black">{r.totalPrice.toLocaleString()}원</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {viewMode === 'settlement' && renderSettlementView()}
          {viewMode === 'byProduct' && renderSummaryTable(productSummary, '품목', false)}
          {viewMode === 'byCompany' && renderSummaryTable(companySummary, '업체', true)}
          {viewMode === 'orders' && renderOrdersView()}
          {viewMode === 'invoices' && renderInvoicesView()}
          {viewMode === 'deposits' && renderDepositsView()}
          {viewMode === 'margin' && renderMarginView()}
          {viewMode === 'returns' && renderReturnView()}
          {viewMode === 'trend' && renderTrendView()}
          {viewMode === 'monthlyAnalysis' && renderMonthlyAnalysisView()}
        </section>
      )}
    </div>
  );
};

export default SalesTracker;
