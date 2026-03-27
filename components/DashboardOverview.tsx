
import React from 'react';
import type { BusinessId } from '../types';
import { BUSINESS_INFO } from '../types';
import type { DailyWorkspaceData } from '../services/firestoreService';

interface DashboardOverviewProps {
  workspaces: Record<BusinessId, DailyWorkspaceData | null>;
  isReady: boolean;
  onNavigate: (bid: BusinessId) => void;
}

interface BusinessSummary {
  orderCount: number;
  totalPrice: number;
  totalSessions: number;
  completedOrders: number;
  completedDeposits: number;
  completedInvoices: number;
  unmatchedCount: number;
  excludedCount: number;
  hasActivity: boolean;
}

function summarizeBusiness(workspace: DailyWorkspaceData | null): BusinessSummary {
  if (!workspace) {
    return { orderCount: 0, totalPrice: 0, totalSessions: 0, completedOrders: 0, completedDeposits: 0, completedInvoices: 0, unmatchedCount: 0, excludedCount: 0, hasActivity: false };
  }

  const results = workspace.sessionResults || {};
  const workflows = workspace.sessionWorkflows || {};
  const sessionIds = new Set([...Object.keys(results), ...Object.keys(workflows)]);

  let orderCount = 0;
  let totalPrice = 0;
  let completedOrders = 0;
  let completedDeposits = 0;
  let completedInvoices = 0;
  let unmatchedCount = 0;
  let excludedCount = 0;

  for (const sid of sessionIds) {
    const r = results[sid];
    if (r) {
      orderCount += r.orderCount || 0;
      totalPrice += r.totalPrice || 0;
      unmatchedCount += r.unmatchedOrders?.length || 0;
      excludedCount += r.excludedCount || 0;
    }
    const w = workflows[sid];
    if (w) {
      if (w.order) completedOrders++;
      if (w.deposit) completedDeposits++;
      if (w.invoice) completedInvoices++;
    }
  }

  return {
    orderCount,
    totalPrice,
    totalSessions: sessionIds.size,
    completedOrders,
    completedDeposits,
    completedInvoices,
    unmatchedCount,
    excludedCount,
    hasActivity: sessionIds.size > 0,
  };
}

const WorkflowBar: React.FC<{ label: string; completed: number; total: number; color: string }> = ({ label, completed, total, color }) => {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-bold text-zinc-500 w-8 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-bold text-zinc-500 w-8 text-right">{completed}/{total}</span>
    </div>
  );
};

const DashboardOverview: React.FC<DashboardOverviewProps> = ({ workspaces, isReady, onNavigate }) => {
  const today = new Date();
  const dateStr = `${today.getFullYear()}. ${today.getMonth() + 1}. ${today.getDate()}.`;
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const dayStr = dayNames[today.getDay()];

  if (!isReady) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-3 border-rose-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-zinc-500 font-bold text-sm">대시보드 로딩 중...</p>
        </div>
      </div>
    );
  }

  const summaries: Record<BusinessId, BusinessSummary> = {
    '안군농원': summarizeBusiness(workspaces['안군농원']),
    '조에': summarizeBusiness(workspaces['조에']),
  };

  // 한쪽만 활동 있을 때 다른 쪽 경고
  const anyActivity = summaries['안군농원'].hasActivity || summaries['조에'].hasActivity;

  return (
    <div className="px-2">
      {/* 날짜 헤더 */}
      <div className="text-center mb-8">
        <p className="text-zinc-500 text-xs font-bold uppercase tracking-widest mb-1">오늘의 발주 현황</p>
        <h2 className="text-2xl font-black text-white">{dateStr} <span className="text-rose-500">({dayStr})</span></h2>
      </div>

      {/* 사업자 카드 */}
      <div className="grid grid-cols-2 gap-4 mb-8">
        {(['안군농원', '조에'] as const).map((bid) => {
          const s = summaries[bid];
          const displayName = BUSINESS_INFO[bid].displayName;
          const warn = !s.hasActivity && anyActivity;

          return (
            <div
              key={bid}
              className={`rounded-2xl border-2 p-6 transition-all ${
                warn
                  ? 'border-amber-500/60 bg-amber-500/5'
                  : s.hasActivity
                    ? 'border-emerald-500/40 bg-emerald-500/5'
                    : 'border-zinc-800 bg-zinc-900'
              }`}
            >
              {/* 사업자명 + 상태 뱃지 */}
              <div className="flex items-center justify-between mb-5">
                <h3 className="text-lg font-black text-white">{displayName}</h3>
                {warn ? (
                  <span className="px-2.5 py-1 bg-amber-500/20 text-amber-400 text-[10px] font-black rounded-lg border border-amber-500/30 animate-pulse">
                    미처리
                  </span>
                ) : s.hasActivity ? (
                  <span className="px-2.5 py-1 bg-emerald-500/20 text-emerald-400 text-[10px] font-black rounded-lg border border-emerald-500/30">
                    진행중
                  </span>
                ) : (
                  <span className="px-2.5 py-1 bg-zinc-800 text-zinc-500 text-[10px] font-black rounded-lg border border-zinc-700">
                    대기
                  </span>
                )}
              </div>

              {/* 주요 지표 */}
              <div className="grid grid-cols-2 gap-3 mb-5">
                <div className="bg-zinc-950/50 rounded-xl p-3 border border-zinc-800">
                  <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">주문 건수</p>
                  <p className={`text-2xl font-black ${s.orderCount > 0 ? 'text-white' : 'text-zinc-600'}`}>
                    {s.orderCount}<span className="text-xs text-zinc-500 ml-1">건</span>
                  </p>
                </div>
                <div className="bg-zinc-950/50 rounded-xl p-3 border border-zinc-800">
                  <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">총 금액</p>
                  <p className={`text-2xl font-black ${s.totalPrice > 0 ? 'text-white' : 'text-zinc-600'}`}>
                    {s.totalPrice > 0 ? `${Math.round(s.totalPrice).toLocaleString()}` : '0'}
                    <span className="text-xs text-zinc-500 ml-1">원</span>
                  </p>
                </div>
              </div>

              {/* 워크플로우 진행률 */}
              {s.totalSessions > 0 && (
                <div className="space-y-2 mb-5">
                  <WorkflowBar label="발주" completed={s.completedOrders} total={s.totalSessions} color="bg-rose-500" />
                  <WorkflowBar label="입금" completed={s.completedDeposits} total={s.totalSessions} color="bg-emerald-500" />
                  <WorkflowBar label="송장" completed={s.completedInvoices} total={s.totalSessions} color="bg-indigo-500" />
                </div>
              )}

              {/* 경고 사항 */}
              {(s.unmatchedCount > 0 || s.excludedCount > 0) && (
                <div className="flex gap-2 mb-5">
                  {s.unmatchedCount > 0 && (
                    <span className="text-[10px] font-bold px-2 py-1 bg-red-500/10 text-red-400 rounded-lg border border-red-500/20">
                      미매칭 {s.unmatchedCount}건
                    </span>
                  )}
                  {s.excludedCount > 0 && (
                    <span className="text-[10px] font-bold px-2 py-1 bg-orange-500/10 text-orange-400 rounded-lg border border-orange-500/20">
                      제외 {s.excludedCount}건
                    </span>
                  )}
                </div>
              )}

              {/* 이동 버튼 */}
              <button
                onClick={() => onNavigate(bid)}
                className={`w-full py-2.5 rounded-xl text-sm font-black transition-all ${
                  warn
                    ? 'bg-amber-500 text-white hover:bg-amber-600 shadow-lg shadow-amber-900/20'
                    : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700'
                }`}
              >
                {warn ? '지금 발주하러 가기' : '발주 관리로 이동'}
              </button>
            </div>
          );
        })}
      </div>

      {/* 안내 메시지 */}
      {!anyActivity && (
        <div className="text-center py-8">
          <p className="text-zinc-600 text-sm font-bold">아직 오늘의 발주가 없습니다.</p>
          <p className="text-zinc-700 text-xs mt-1">위 카드를 클릭하여 발주를 시작하세요.</p>
        </div>
      )}
    </div>
  );
};

export default DashboardOverview;
