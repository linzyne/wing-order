
import React from 'react';
import type { BusinessId } from '../types';
import { BUSINESS_INFO } from '../types';
import type { DailyWorkspaceData } from '../services/firestoreService';

interface OrderStatusBannerProps {
  workspaces: Record<BusinessId, DailyWorkspaceData | null>;
  isReady: boolean;
  currentBusiness: BusinessId;
  onSwitchBusiness: (bid: BusinessId) => void;
}

function getBusinessStatus(workspace: DailyWorkspaceData | null) {
  if (!workspace) return { orderCount: 0, totalSessions: 0, completedOrders: 0, hasActivity: false };

  const results = workspace.sessionResults || {};
  const workflows = workspace.sessionWorkflows || {};
  const sessionIds = new Set([...Object.keys(results), ...Object.keys(workflows)]);

  let orderCount = 0;
  let completedOrders = 0;

  for (const sid of sessionIds) {
    if (results[sid]?.orderCount) orderCount += results[sid].orderCount;
    if (workflows[sid]?.order) completedOrders++;
  }

  return {
    orderCount,
    totalSessions: sessionIds.size,
    completedOrders,
    hasActivity: sessionIds.size > 0,
  };
}

const OrderStatusBanner: React.FC<OrderStatusBannerProps> = ({ workspaces, isReady, currentBusiness, onSwitchBusiness }) => {
  if (!isReady) return null;

  const statuses = {
    '안군농원': getBusinessStatus(workspaces['안군농원']),
    '조에': getBusinessStatus(workspaces['조에']),
  };

  // 아무 사업자도 활동이 없으면 배너 숨김
  const anyActivity = statuses['안군농원'].hasActivity || statuses['조에'].hasActivity;
  if (!anyActivity) return null;

  // 상태 판단: 미처리(활동없음) / 발주미완료(빨간) / 발주완료(초록)
  const getLevel = (bid: BusinessId): 'none' | 'incomplete' | 'complete' => {
    const s = statuses[bid];
    if (!s.hasActivity) return 'none';
    // 모든 세션의 발주 체크가 완료되었는지
    if (s.completedOrders >= s.totalSessions) return 'complete';
    return 'incomplete';
  };

  return (
    <div className="mb-4 flex items-center gap-2 px-2">
      {(['안군농원', '조에'] as const).map((bid) => {
        const s = statuses[bid];
        const level = getLevel(bid);
        const isCurrent = currentBusiness === bid;
        const displayName = BUSINESS_INFO[bid].displayName;
        // 한쪽만 활동 없을 때 경고
        const noActivity = level === 'none' && anyActivity;

        const colorClass = noActivity
          ? 'bg-amber-500/10 border-amber-500/40 text-amber-400 animate-pulse'
          : level === 'incomplete'
            ? 'bg-red-500/10 border-red-500/40 text-red-400'
            : level === 'complete'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : 'bg-zinc-900 border-zinc-800 text-zinc-500';

        const dotColor = noActivity
          ? 'bg-amber-500'
          : level === 'incomplete'
            ? 'bg-red-500'
            : level === 'complete'
              ? 'bg-emerald-500'
              : 'bg-zinc-600';

        return (
          <button
            key={bid}
            onClick={() => !isCurrent && onSwitchBusiness(bid)}
            className={`flex-1 flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black transition-all border ${colorClass} ${!isCurrent ? 'cursor-pointer hover:brightness-125' : 'cursor-default'}`}
          >
            <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
            <span>{displayName}</span>
            <span className="text-[10px] font-bold opacity-70">
              {noActivity
                ? '미처리'
                : s.hasActivity
                  ? `${s.orderCount}건 처리 / 발주완료 ${s.completedOrders}/${s.totalSessions}`
                  : '대기중'}
            </span>
          </button>
        );
      })}
    </div>
  );
};

export default OrderStatusBanner;
