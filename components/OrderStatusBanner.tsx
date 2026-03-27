
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
  // 워크플로우 기준으로만 세션 카운트 (실제 화면에 보이는 업체만)
  const workflowIds = Object.keys(workflows);

  let orderCount = 0;
  let completedOrders = 0;

  for (const sid of workflowIds) {
    if (results[sid]?.orderCount) orderCount += results[sid].orderCount;
    if (workflows[sid]?.order) completedOrders++;
  }

  return {
    orderCount,
    totalSessions: workflowIds.length,
    completedOrders,
    hasActivity: workflowIds.length > 0,
  };
}

const OrderStatusBanner: React.FC<OrderStatusBannerProps> = ({ workspaces, isReady, currentBusiness, onSwitchBusiness }) => {
  if (!isReady) return null;

  const statuses = {
    '안군농원': getBusinessStatus(workspaces['안군농원']),
    '조에': getBusinessStatus(workspaces['조에']),
  };

  const anyActivity = statuses['안군농원'].hasActivity || statuses['조에'].hasActivity;
  if (!anyActivity) return null;

  const getLevel = (bid: BusinessId): 'none' | 'incomplete' | 'complete' => {
    const s = statuses[bid];
    if (!s.hasActivity) return 'none';
    if (s.completedOrders >= s.totalSessions) return 'complete';
    return 'incomplete';
  };

  return (
    <div className="mb-4 flex items-center gap-2 px-2 sticky top-0 z-50 py-2 bg-zinc-950/90 backdrop-blur-sm -mx-2 rounded-xl">
      {(['안군농원', '조에'] as const).map((bid) => {
        const s = statuses[bid];
        const level = getLevel(bid);
        const isCurrent = currentBusiness === bid;
        const displayName = BUSINESS_INFO[bid].displayName;
        const noActivity = level === 'none' && anyActivity;

        const colorClass = noActivity
          ? 'bg-amber-500/15 border-2 border-amber-500/60 text-amber-400 animate-pulse'
          : level === 'incomplete'
            ? 'bg-red-500/25 border-2 border-red-500 text-red-300 animate-pulse shadow-lg shadow-red-500/20'
            : level === 'complete'
              ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
              : 'bg-zinc-900 border border-zinc-800 text-zinc-500';

        return (
          <button
            key={bid}
            onClick={() => !isCurrent && onSwitchBusiness(bid)}
            className={`flex-1 flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-black transition-all ${colorClass} ${!isCurrent ? 'cursor-pointer hover:brightness-125' : 'cursor-default'}`}
          >
            {noActivity ? (
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
              </svg>
            ) : level === 'incomplete' ? (
              <svg className="w-5 h-5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
              </svg>
            ) : level === 'complete' ? (
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
              </svg>
            ) : (
              <span className="w-2 h-2 rounded-full shrink-0 bg-zinc-600" />
            )}
            <span>{displayName}</span>
            <span className="text-[10px] font-bold opacity-80">
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
