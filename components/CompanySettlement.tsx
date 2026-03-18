import React, { useState, useMemo, useEffect } from 'react';
import { useSalesTracker } from '../hooks/useSalesTracker';
import { ChevronDownIcon, ChevronUpIcon } from './icons';
import type { SalesRecord } from '../types';

type DateMode = 'month' | 'range';

const CompanySettlement: React.FC<{ isActive?: boolean; businessId?: string }> = ({ isActive, businessId }) => {
  const { salesHistory, refresh } = useSalesTracker(businessId);

  useEffect(() => {
    if (isActive) refresh();
  }, [isActive, refresh]);

  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());

  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);
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
  const monthTotal = filteredHistory.reduce((sum, d) => sum + d.totalAmount, 0);
  const monthTotalCount = allRecords.reduce((sum, r) => sum + r.count, 0);

  const toggleDate = (date: string) => {
    setExpandedDates(prev => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date); else next.add(date);
      return next;
    });
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
    return `${d.getMonth() + 1}/${d.getDate()} (${weekdays[d.getDay()]})`;
  };

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

  const periodLabel = dateMode === 'range'
    ? `${rangeStart} ~ ${rangeEnd}`
    : `${selectedYear}년 ${selectedMonth}월`;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* 헤더 + 날짜 선택 */}
      <section className="bg-zinc-900/60 rounded-[2.5rem] p-6 border border-zinc-800 shadow-2xl backdrop-blur-md">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="bg-rose-500/10 p-4 rounded-[1.5rem] border border-rose-500/20 shadow-inner">
                <span className="text-3xl">🏢</span>
              </div>
              <div>
                <h2 className="text-zinc-500 font-black text-[10px] uppercase tracking-[0.2em] mb-0.5">
                  {periodLabel} 업체별정산
                </h2>
                <div className="flex items-baseline gap-2">
                  <span className="text-4xl font-black text-white">{monthTotal.toLocaleString()}</span>
                  <span className="text-xl font-black text-rose-500">원</span>
                </div>
                <div className="flex gap-3 mt-1">
                  <span className="text-[11px] text-zinc-500 font-bold">총 {monthTotalCount}건</span>
                  <span className="text-[11px] text-zinc-600 font-bold">{filteredHistory.length}일 기록</span>
                </div>
              </div>
            </div>

            {/* 월별 / 기간 토글 */}
            <div className="flex p-1 bg-zinc-950 rounded-xl border border-zinc-800">
              <button
                onClick={() => setDateMode('month')}
                className={`px-3 py-1.5 text-[11px] font-black rounded-lg transition-all ${dateMode === 'month' ? 'bg-rose-500 text-white' : 'text-zinc-500 hover:text-white'}`}
              >
                월별
              </button>
              <button
                onClick={() => setDateMode('range')}
                className={`px-3 py-1.5 text-[11px] font-black rounded-lg transition-all ${dateMode === 'range' ? 'bg-rose-500 text-white' : 'text-zinc-500 hover:text-white'}`}
              >
                기간
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

      {/* 날짜별 업체정산 목록 */}
      {filteredHistory.length === 0 ? (
        <div className="bg-zinc-900/40 rounded-[2.5rem] p-12 border border-zinc-800 text-center">
          <p className="text-zinc-600 font-bold text-sm">{periodLabel} 정산 데이터가 없습니다.</p>
          <p className="text-zinc-700 text-xs mt-2">매출현황 탭에서 업무일지 엑셀 파일을 업로드하면 자동으로 기록됩니다.</p>
        </div>
      ) : (
        <section className="bg-zinc-900/40 rounded-[2.5rem] border border-zinc-800 shadow-2xl overflow-hidden divide-y divide-zinc-900">
          {filteredHistory.map(day => {
            const companyGroups = groupByCompany(day.records);
            const isExpanded = expandedDates.has(day.date);

            return (
              <div key={day.date}>
                <button
                  onClick={() => toggleDate(day.date)}
                  className="w-full px-6 py-4 flex items-center justify-between hover:bg-zinc-900/50 transition-all"
                >
                  <div className="flex items-center gap-4">
                    <span className="text-white font-black text-sm">{formatDate(day.date)}</span>
                    <span className="text-[10px] bg-zinc-800 text-zinc-400 px-2.5 py-1 rounded-full font-black border border-zinc-700">
                      {companyGroups.length}개 업체
                    </span>
                    <span className="text-[10px] bg-zinc-800 text-zinc-400 px-2.5 py-1 rounded-full font-black border border-zinc-700">
                      {day.records.length}개 품목
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-rose-500 font-black text-sm">{day.totalAmount.toLocaleString()}원</span>
                    {isExpanded ? <ChevronUpIcon className="w-4 h-4 text-zinc-600" /> : <ChevronDownIcon className="w-4 h-4 text-zinc-600" />}
                  </div>
                </button>

                {isExpanded && (
                  <div className="px-6 pb-5 animate-fade-in space-y-4">
                    {companyGroups.map(([company, records]) => {
                      const companyTotal = records.reduce((s, r) => s + r.totalPrice, 0);
                      const companyCount = records.reduce((s, r) => s + r.count, 0);
                      return (
                        <div key={company} className="bg-zinc-900/60 rounded-2xl border border-zinc-800 overflow-hidden">
                          <div className="px-4 py-3 flex items-center justify-between border-b border-zinc-800">
                            <span className="text-rose-400 font-black text-sm">[{company}]</span>
                            <div className="flex items-center gap-3">
                              <span className="text-zinc-500 text-[11px] font-bold">{companyCount}개</span>
                              <span className="text-white font-black text-sm">{companyTotal.toLocaleString()}원</span>
                            </div>
                          </div>
                          <table className="w-full text-left">
                            <tbody className="divide-y divide-zinc-800/50">
                              {records.map((r, i) => (
                                <tr key={i} className="text-xs hover:bg-zinc-800/30 transition-colors">
                                  <td className="py-2.5 pl-4 pr-4 font-bold text-zinc-300">{r.product}</td>
                                  <td className="py-2.5 pr-4 text-right text-zinc-400 font-bold">{r.count}개</td>
                                  <td className="py-2.5 pr-4 text-right text-zinc-500 font-mono">{r.supplyPrice.toLocaleString()}원</td>
                                  <td className="py-2.5 pr-4 text-right text-white font-black">{r.totalPrice.toLocaleString()}원</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    })}
                    <div className="flex items-center justify-between px-1 pt-1">
                      <span className="text-zinc-500 font-black text-xs">일일 합계</span>
                      <span className="text-rose-500 font-black text-base">{day.totalAmount.toLocaleString()}원</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
};

export default CompanySettlement;
