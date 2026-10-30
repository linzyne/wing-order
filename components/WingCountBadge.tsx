import React, { useEffect, useState } from 'react';
import { subscribeWingCounts, requestWingCount, sameBusinessName, type WingReadyCount } from '../services/wingInbox';

// 윙 상품준비중 건수 '윙N' — 사업자 크롬 프로필의 확장이 윙에서 읽어 남긴 값.
// 주문서를 받을 때, 송장을 올린 뒤(남은 건수), 이 글자를 눌렀을 때 새로 읽는다.
// 배지가 여러 개여도 Firestore 구독은 하나만 쓴다.
let latest: WingReadyCount[] = [];
const listeners = new Set<(c: WingReadyCount[]) => void>();
let unsub: (() => void) | null = null;

function useWingCounts(): WingReadyCount[] {
  const [counts, setCounts] = useState(latest);
  useEffect(() => {
    listeners.add(setCounts);
    if (!unsub) unsub = subscribeWingCounts(c => { latest = c; listeners.forEach(l => l(c)); });
    return () => {
      listeners.delete(setCounts);
      if (listeners.size === 0 && unsub) { unsub(); unsub = null; }
    };
  }, []);
  return counts;
}

const WingCountBadge: React.FC<{ businessName: string; className?: string }> = ({ businessName, className = '' }) => {
  const counts = useWingCounts();
  const [askedAt, setAskedAt] = useState(0);
  const wing = counts.find(w => sameBusinessName(w.businessName, businessName));
  const today = !!wing && new Date(wing.at).toDateString() === new Date().toDateString();
  const asking = askedAt > (wing?.at ?? 0) && Date.now() - askedAt < 60_000;
  const at = wing ? new Date(wing.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <span
      role="button"
      onClick={(e) => {
        // 칩·버튼 안에 있어도 그 버튼은 누르지 않고 건수만 다시 읽는다
        e.stopPropagation();
        setAskedAt(Date.now());
        requestWingCount(businessName).catch(err => alert(`윙 건수 요청 실패\n${err?.message || err}`));
      }}
      title={wing
        ? `윙 상품준비중 ${wing.count}건 · ${at}에 읽음\n눌러서 지금 다시 읽기 (그 사업자 크롬 프로필이 열려 있어야 함)`
        : '윙 상품준비중 건수 — 눌러서 읽기 (그 사업자 크롬 프로필이 열려 있어야 함)'}
      className={`tabular-nums rounded px-0.5 cursor-pointer hover:bg-white/10 ${asking ? 'animate-pulse' : ''} ${today ? 'text-sky-300' : 'text-zinc-500'} ${className}`}
    >
      윙{today ? wing!.count.toLocaleString() : '-'}
    </span>
  );
};

export default WingCountBadge;
