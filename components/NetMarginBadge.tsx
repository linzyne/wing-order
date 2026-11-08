import React, { useEffect, useState } from 'react';
import { subscribeAdSpend, requestAdSpend, sameBusinessName, type AdSpend } from '../services/wingInbox';

// 어제 광고비를 뺀 순마진 '순+N' — 사업자 크롬 프로필의 확장이 광고센터에서 읽어 남긴 어제 광고비(부가세 포함)를 쓴다.
// 그 사업자 광고비가 아직 없으면 화면에 처음 보일 때 한 번 읽어 달라고 하고, 글자를 누르면 다시 읽는다.
export const yesterdayKey = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let latestDate = '';
let latest: AdSpend[] = [];
const listeners = new Set<(c: AdSpend[]) => void>();
let unsub: (() => void) | null = null;
// 이 창에서 날짜별로 이미 자동 요청한 사업자 (화면이 다시 그려질 때마다 요청하지 않게)
const autoAsked = new Set<string>();

export function useAdSpends(): AdSpend[] {
  const date = yesterdayKey();
  const [list, setList] = useState(latestDate === date ? latest : []);
  useEffect(() => {
    if (unsub && latestDate !== date) { unsub(); unsub = null; }
    listeners.add(setList);
    if (!unsub) {
      latestDate = date;
      latest = [];
      unsub = subscribeAdSpend(date, c => { latest = c; listeners.forEach(l => l(c)); });
    }
    return () => {
      listeners.delete(setList);
      if (listeners.size === 0 && unsub) { unsub(); unsub = null; }
    };
  }, [date]);
  return list;
}

export const findAdSpend = (list: AdSpend[], businessName: string) =>
  list.find(a => sameBusinessName(a.businessName, businessName));

const NetMarginBadge: React.FC<{ businessName: string; margin: number }> = ({ businessName, margin }) => {
  const list = useAdSpends();
  const ad = findAdSpend(list, businessName);
  const [askedAt, setAskedAt] = useState(0);
  const ask = () => {
    setAskedAt(Date.now());
    return requestAdSpend(businessName);
  };
  useEffect(() => {
    const key = `${yesterdayKey()}|${businessName}`;
    if (ad || autoAsked.has(key)) return;
    // 구독 첫 값이 오기 전에 요청하지 않도록 잠깐 기다린다
    const t = setTimeout(() => {
      if (findAdSpend(latest, businessName) || autoAsked.has(key)) return;
      autoAsked.add(key);
      ask().catch(err => console.warn('[광고비 요청]', err));
    }, 3000);
    return () => clearTimeout(t);
  }, [ad, businessName]);

  const asking = !ad && Date.now() - askedAt < 60_000;
  const net = ad ? margin - ad.spendWithVat : 0;
  const at = ad ? new Date(ad.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <span
      role="button"
      onClick={(e) => {
        // 버튼 안에 있어도 발주서 받기는 누르지 않고 광고비만 다시 읽는다
        e.stopPropagation();
        ask().catch(err => alert(`광고비 요청 실패\n${err?.message || err}`));
      }}
      title={ad
        ? `순마진 = 마진 ${margin.toLocaleString()} − 어제 광고비 ${ad.spendWithVat.toLocaleString()} (부가세 포함, 별도 ${ad.spend.toLocaleString()})\n${at}에 읽음 · 눌러서 다시 읽기`
        : '어제 광고비를 아직 못 읽었어요 — 눌러서 읽기 (그 사업자 크롬 프로필이 열려 있고 광고센터에 로그인돼 있어야 함)'}
      className={`tabular-nums rounded px-0.5 cursor-pointer hover:bg-white/10 ${asking ? 'animate-pulse' : ''} ${!ad ? 'text-zinc-500' : net >= 0 ? 'text-emerald-200' : 'text-red-300'}`}
    >
      {ad ? `순${net > 0 ? '+' : ''}${net.toLocaleString()}` : '순-'}
    </span>
  );
};

export default NetMarginBadge;
