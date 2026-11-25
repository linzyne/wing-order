import {
  subscribeOpenCs, loadCsItemsByDate, loadManualOrders, loadManualOrderLogSince, loadSessionResults,
  getDailyWorkspace, loadManualTransferLogSince, loadRecentOrderSearchOnce, todayDocId, type OpenCsEntry,
  type ManualOrderLogEntry, type ManualTransferLogEntry,
} from './firestoreService';
import type { DailySales } from '../types';

// 발주전확인: 발주서 메일을 보내기 전에, 손으로 넣은 것들이 오늘 발주서·입금목록에 다 들어갔는지 사업자 전체를 한 번에 본다.
//  1) CS: 대기(접수확인 안 누름)로 남은 건, 재배송인데 발주서에 안 넣은 건
//  2) 수동발주: 대기 목록에 있는데 오늘 발주서에 없는 건, 등록했는데 발주서 없이 사라진 건(최근 7일)
//  3) 수동입금: 오늘 넣었는데 오늘 입금목록(작업공간)에 없는 건, CS 계좌환불인데 입금목록에 없는 건
// 버튼을 누를 때 한 번만 읽는다(계속 묻지 않음).

export type CheckLevel = 'error' | 'warn';
export interface CheckIssue {
  level: CheckLevel;
  businessName: string;
  title: string;   // 한 줄 요약 (업체 · 이름 · 품목)
  detail: string;  // 무엇이 문제인지
}
export interface PreOrderCheckResult {
  cs: CheckIssue[];
  manualOrders: CheckIssue[];
  transfers: CheckIssue[];
  /** 확인한 것 (문제가 없을 때 무엇을 봤는지 보여주려고) */
  checked: { cs: number; manualOrders: number; transfers: number };
}

interface Business { id: string; displayName: string; }

const DAY = 86400000;
const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, '');
const md = (date: string) => { const [, m, d] = date.split('-'); return `${Number(m)}/${Number(d)}`; };
const parse = (v: any): any => { if (typeof v === 'string') { try { return parse(JSON.parse(v)); } catch { return v; } } return v; };
const asArray = (v: any): any[] => { const x = parse(v); return Array.isArray(x) ? x : (x && typeof x === 'object' ? Object.values(x) : []); };

/** 수동 줄인지 + 받는분 이름 (CS 재배송 줄은 주문번호 목록이 비어 있어 칸의 '수동'으로 본다) */
const manualRowName = (row: any[], num: string, name: string): string | null => {
  const cells = (row || []).map(c => String(c ?? '').trim()).filter(Boolean);
  const isManual = num.startsWith('수동') || (num === '' && cells.some(c => c === '수동' || c === '수동샘플'));
  if (!isManual) return null;
  return name || cells.find(c => /^[가-힣]{2,4}$/.test(c) && c !== '수동' && c !== '수동샘플' && !/(농원|푸드|상회|무역|상사)$/.test(c)) || '';
};

type ManualHit = { company: string; name: string; date: string };

/** 오늘 발주서(세션 결과)의 수동 줄 */
const todayManualRows = (sessions: Record<string, any> | null, today: string): ManualHit[] => {
  const out: ManualHit[] = [];
  Object.entries(sessions || {}).forEach(([sid, data]) => {
    const company = sid.replace(/-(batch-\d+-\d+|\d+)$/, '');
    const rows = asArray(data?.orderRows).map(parse);
    const nums = asArray(data?.rowOrderNumbers);
    const names = asArray(data?.rowRecipientNames);
    rows.forEach((row, i) => {
      const n = manualRowName(Array.isArray(row) ? row : [], String(nums[i] ?? ''), String(names[i] ?? ''));
      if (n !== null) out.push({ company, name: n, date: today });
    });
  });
  return out;
};

/** 최근 발주내역(기록된 발주서)의 수동 줄 */
const recentManualRows = (history: DailySales[]): ManualHit[] => {
  const out: ManualHit[] = [];
  history.forEach(d => {
    Object.entries(d.companyOrderRows || {}).forEach(([company, rows]) => {
      const nums = d.companyOrderNumbers?.[company] || [];
      const names = d.companyRecipientNames?.[company] || [];
      (rows as any[][]).forEach((row, i) => {
        const n = manualRowName(row, String(nums[i] || ''), names[i] || '');
        if (n !== null) out.push({ company, name: n, date: d.date });
      });
    });
  });
  return out;
};

const openCsOnce = (businessId: string): Promise<OpenCsEntry[]> =>
  new Promise(resolve => {
    let done = false;
    let unsub: (() => void) | null = null;
    const finish = (v: OpenCsEntry[]) => { if (done) return; done = true; resolve(v); setTimeout(() => unsub?.(), 0); };
    unsub = subscribeOpenCs(businessId, v => { if (v !== null) finish(v); });
    setTimeout(() => finish([]), 20000);
  });

const checkBusiness = async (b: Business, today: string) => {
  const since = Date.now() - 7 * DAY;
  const [openCs, todayCs, pending, orderLog, sessions, workspace, transferLog, history] = await Promise.all([
    openCsOnce(b.id),
    loadCsItemsByDate(b.id, today).catch(() => [] as OpenCsEntry[]),
    loadManualOrders(b.id),
    loadManualOrderLogSince(b.id, since).catch(() => [] as ManualOrderLogEntry[]),
    loadSessionResults(b.id),
    getDailyWorkspace(b.id).catch(() => null),
    loadManualTransferLogSince(b.id, today ? new Date(`${today}T00:00:00`).getTime() : since).catch(() => [] as ManualTransferLogEntry[]),
    loadRecentOrderSearchOnce(b.id).catch(() => [] as DailySales[]),
  ]);

  const cs: CheckIssue[] = [];
  const manualOrders: CheckIssue[] = [];
  const transfers: CheckIssue[] = [];
  const who = (r: { company?: string; recipientName?: string }) => [r.company, r.recipientName || '이름없음'].filter(Boolean).join(' · ');

  // ── 1) CS ──
  const csById = new Map<string, OpenCsEntry>();
  [...todayCs, ...openCs].forEach(r => csById.set(r.id, r));
  const recentCs = [...csById.values()].filter(r => Date.parse(r.createdAt || '') >= since || r.date === today);
  openCs.filter(r => r.pending).forEach(r => cs.push({
    level: 'error', businessName: b.displayName, title: `${who(r)} · ${r.customerMethod}`,
    detail: '대기 중 — 접수확인을 안 눌렀어요',
  }));
  recentCs.filter(r => !r.pending && r.customerMethod === '재배송' && !r.poAdded).forEach(r => cs.push({
    level: 'error', businessName: b.displayName, title: `${who(r)} · 재배송`,
    detail: '접수확인은 했는데 재배송 발주를 발주서에 안 넣었어요',
  }));

  // ── 2) 수동발주 ──
  const todayRows = todayManualRows(sessions, today);
  const pastRows = recentManualRows(history);
  const inToday = (company: string, name: string) => todayRows.some(r => r.company === company && norm(r.name) === norm(name));
  const pastHit = (company: string, name: string, fromMs: number) => {
    const from = new Date(fromMs || 0).toLocaleDateString('en-CA');
    return pastRows.filter(r => r.company === company && norm(r.name) === norm(name) && r.date >= from && r.date !== today)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
  };
  const logById = new Map(orderLog.map(e => [e.id, e]));
  const pendingIds = new Set(pending.map((o: any) => o.id));
  pending.forEach((o: any) => {
    if (inToday(o.companyName, o.recipientName)) return;
    const past = pastHit(o.companyName, o.recipientName, logById.get(o.id)?.createdAt || Date.now() - 45 * DAY);
    manualOrders.push(past
      ? { level: 'warn', businessName: b.displayName, title: `${o.companyName} · ${o.recipientName} · ${o.productName} ×${o.qty}`,
          detail: `${md(past.date)} 발주서에 이미 들어갔는데 대기 목록에 남아 있어요 (또 넣으면 중복)` }
      : { level: 'error', businessName: b.displayName, title: `${o.companyName} · ${o.recipientName} · ${o.productName} ×${o.qty}`,
          detail: '대기 목록에 있는데 오늘 발주서에 없어요' });
  });
  orderLog.forEach(e => {
    if (pendingIds.has(e.id)) return;
    if (e.removedReason === '직접 지움' || e.removedReason === '대신 보내기로 옮김') return;
    if (inToday(e.companyName, e.recipientName) || pastHit(e.companyName, e.recipientName, e.createdAt)) return;
    manualOrders.push({ level: 'error', businessName: b.displayName, title: `${e.companyName} · ${e.recipientName} · ${e.productName} ×${e.qty}`,
      detail: '등록했는데 발주서 없이 목록에서 사라졌어요' });
  });

  // ── 3) 수동입금 ──
  const wsTransfers: any[] = (workspace as any)?.manualTransfers || [];
  const wsIds = new Set(wsTransfers.map(t => t.id));
  transferLog.filter(e => e.workspaceDate === today && !wsIds.has(e.id)
    && e.removedReason !== '직접 지움' && e.removedReason !== '주문서 올릴 때 삭제')
    .forEach(e => transfers.push({
      level: 'error', businessName: b.displayName, title: `${e.label || '수동 입금'} · ${e.amount.toLocaleString()}원`,
      detail: '오늘 넣었는데 입금목록에서 빠졌어요',
    }));
  recentCs.filter(r => !r.pending && r.customerMethod === '환불' && r.refundMethod === '계좌환불'
    && (r.date === today || (r.createdAt || '').slice(0, 10) === today))
    .forEach(r => {
      if (wsIds.has(`cs-refund-${r.id}`)) return;
      transfers.push({ level: 'error', businessName: b.displayName, title: `${who(r)} · CS 계좌환불 ${(r.refundAmount || 0).toLocaleString()}원`,
        detail: '오늘 접수한 계좌환불이 입금목록에 없어요' });
    });

  return {
    cs, manualOrders, transfers,
    checked: { cs: openCs.length, manualOrders: pending.length + orderLog.length, transfers: wsTransfers.length },
  };
};

export const runPreOrderCheck = async (businesses: Business[]): Promise<PreOrderCheckResult> => {
  const today = todayDocId();
  const all = await Promise.all(businesses.map(b => checkBusiness(b, today).catch(err => {
    console.error('[발주전확인] 실패', b.displayName, err);
    const fail: CheckIssue = { level: 'error', businessName: b.displayName, title: '확인 실패', detail: String(err?.message || err) };
    return { cs: [fail], manualOrders: [], transfers: [], checked: { cs: 0, manualOrders: 0, transfers: 0 } };
  })));
  return {
    cs: all.flatMap(r => r.cs),
    manualOrders: all.flatMap(r => r.manualOrders),
    transfers: all.flatMap(r => r.transfers),
    checked: {
      cs: all.reduce((s, r) => s + r.checked.cs, 0),
      manualOrders: all.reduce((s, r) => s + r.checked.manualOrders, 0),
      transfers: all.reduce((s, r) => s + r.checked.transfers, 0),
    },
  };
};
