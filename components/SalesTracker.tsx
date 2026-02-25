import React, { useState, useMemo, useRef } from 'react';
import { useSalesTracker, importMultipleWorkLogs } from '../hooks/useSalesTracker';
import { TrashIcon, ArrowDownTrayIcon, ChevronDownIcon, ChevronUpIcon, UploadIcon } from './icons';
import type { DepositRecord } from '../types';

declare var XLSX: any;

type ViewMode = 'byDate' | 'byProduct' | 'byCompany' | 'orders' | 'invoices' | 'deposits';
type DateMode = 'month' | 'range';

const SalesTracker: React.FC = () => {
  const { salesHistory, refresh, remove } = useSalesTracker();
  const [viewMode, setViewMode] = useState<ViewMode>('byDate');
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);

  // 날짜 범위 모드
  const [dateMode, setDateMode] = useState<DateMode>('month');
  const todayStr = now.toISOString().slice(0, 10);
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
      const result = await importMultipleWorkLogs(fileArray);
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

    const label = dateMode === 'range' ? `${rangeStart}~${rangeEnd}` : selectedYearMonth;
    XLSX.writeFile(wb, `${label}_매출현황.xlsx`);
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
    if (allOrderRows.length === 0) {
      return (
        <div className="p-12 text-center">
          <p className="text-zinc-600 font-bold text-sm">해당 기간의 발주 데이터가 없습니다.</p>
        </div>
      );
    }
    return (
      <div className="divide-y divide-zinc-900">
        {allOrderRows.map(({ date, data }) => (
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
              {expandedDates.has(`order-${date}`) ? <ChevronUpIcon className="w-4 h-4 text-zinc-600" /> : <ChevronDownIcon className="w-4 h-4 text-zinc-600" />}
            </button>
            {expandedDates.has(`order-${date}`) && (
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
        ))}
      </div>
    );
  };

  /** 송장내역 렌더링 */
  const renderInvoicesView = () => {
    if (allInvoiceRows.length === 0) {
      return (
        <div className="p-12 text-center">
          <p className="text-zinc-600 font-bold text-sm">해당 기간의 송장 데이터가 없습니다.</p>
        </div>
      );
    }
    return (
      <div className="divide-y divide-zinc-900">
        {allInvoiceRows.map(({ date, data }) => (
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
              {expandedDates.has(`inv-${date}`) ? <ChevronUpIcon className="w-4 h-4 text-zinc-600" /> : <ChevronDownIcon className="w-4 h-4 text-zinc-600" />}
            </button>
            {expandedDates.has(`inv-${date}`) && (
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
        ))}
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
                        <th className="pb-2 pr-4 text-right">금액</th>
                        <th className="pb-2">비고</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-900/50">
                      {recs.map((r, i) => (
                        <tr key={i} className="text-xs">
                          <td className="py-2 pr-4 font-bold text-zinc-300">{r.bankName}</td>
                          <td className="py-2 pr-4 text-zinc-400 font-mono">{r.accountNumber}</td>
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

  const tabs: [ViewMode, string][] = [
    ['byDate', '날짜별'],
    ['byProduct', '품목별'],
    ['byCompany', '업체별'],
    ['orders', '발주내역'],
    ['invoices', '송장내역'],
    ['deposits', '입금내역'],
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
                  {monthTotalMargin > 0 && (
                    <span className="text-[11px] text-emerald-500 font-bold">마진 {monthTotalMargin.toLocaleString()}원</span>
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

          {viewMode === 'byProduct' && renderSummaryTable(productSummary, '품목', false)}
          {viewMode === 'byCompany' && renderSummaryTable(companySummary, '업체', true)}
          {viewMode === 'orders' && renderOrdersView()}
          {viewMode === 'invoices' && renderInvoicesView()}
          {viewMode === 'deposits' && renderDepositsView()}
        </section>
      )}
    </div>
  );
};

export default SalesTracker;
