import { addDoc, collection, deleteDoc, doc, onSnapshot, updateDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';

// 발주기록: 발주서가 파일·메일·어드민·카톡으로 밖에 나가면 그 주문번호를 남겨 두고,
// 다음 날 이후 주문서(상품준비중에 아직 남은 주문)에서 자동으로 뺀다 — 미리 발주했는데 송장이 없는 주문이 또 발주되지 않게.
// 같은 날 기록은 빼지 않는다(그날 차수들이 서로 지워지면 안 되니까).
// 1차 주문서(상품준비중 전체)에 더 이상 없는 주문은 송장이 붙은 것으로 보고 기록에서 지운다.

export type SentMethod = 'download' | 'mail' | 'admin' | 'kakao';
export const SENT_METHOD_LABEL: Record<SentMethod, string> = { download: '다운로드', mail: '메일', admin: '어드민', kakao: '카톡' };

export interface SentBatch {
  id: string;
  businessId: string;
  businessName: string;
  company: string;
  label: string;          // 1차, 합산 …
  method: SentMethod;
  recordDate: string;     // 작업날짜 YYYY-MM-DD
  orderNumbers: string[];
  waitDays: number;       // 영업일로 이만큼 지나도 송장 없으면 빨간색
  createdAtMs: number;
}

export const SENT_RECORDED_EVENT = 'sent-orders-recorded';
export interface SentRecordedDetail { id: string; text: string; }

const COL = 'sentOrders';
let batches: SentBatch[] = [];
let started = false;
let resolveReady: () => void = () => {};
const ready = new Promise<void>(r => { resolveReady = r; });
const listeners = new Set<(b: SentBatch[]) => void>();

function start() {
  if (started) return;
  started = true;
  onSnapshot(collection(db, COL), snap => {
    batches = snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<SentBatch, 'id'>) }))
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
    resolveReady();
    listeners.forEach(fn => fn(batches));
  }, err => {
    console.error('[발주기록] 구독 실패', err);
    resolveReady();
  });
}

export function subscribeSentBatches(fn: (b: SentBatch[]) => void): () => void {
  start();
  listeners.add(fn);
  fn(batches);
  return () => { listeners.delete(fn); };
}

/** 첫 스냅샷까지 기다린 뒤 현재 기록 — 주문서 처리 직전에 불러 빼먹지 않게 */
export async function getSentBatches(): Promise<SentBatch[]> {
  start();
  await ready;
  return batches;
}

/** 이 사업자의 recordDate 이전 기록 → 주문번호 → "11/12 메일" */
export function sentNumbersBefore(all: SentBatch[], businessId: string, recordDate: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const b of all) {
    if (b.businessId !== businessId || !(b.recordDate < recordDate)) continue;
    const tag = `${Number(b.recordDate.slice(5, 7))}/${Number(b.recordDate.slice(8, 10))} ${SENT_METHOD_LABEL[b.method] || b.method}`;
    b.orderNumbers.forEach(n => { if (!map.has(n)) map.set(n, tag); });
  }
  return map;
}

/** 발주서 행의 주문번호 칸(합산이면 콤마로 이어짐) → 주문번호 목록 */
export function splitOrderNumbers(values: (string | undefined)[]): string[] {
  const set = new Set<string>();
  values.forEach(v => String(v || '').split(/[,\s]+/).forEach(n => { const t = n.trim(); if (/^[A-Za-z0-9-]{5,}$/.test(t)) set.add(t); }));
  return [...set];
}

export async function recordSentOrders(p: Omit<SentBatch, 'id' | 'createdAtMs'>): Promise<void> {
  const nums = [...new Set(p.orderNumbers)];
  if (nums.length === 0) return;
  try {
    // 같은 날 같은 업체의 앞선 기록과 겹치는 주문은 새 기록으로 옮긴다 — 테스트로 여러 번 받아도 마지막 것 하나만 취소하면 되게
    const numSet = new Set(nums);
    const wb = writeBatch(db);
    let touched = false;
    for (const b of await getSentBatches()) {
      if (b.businessId !== p.businessId || b.company !== p.company || b.recordDate !== p.recordDate) continue;
      const rest = b.orderNumbers.filter(n => !numSet.has(n));
      if (rest.length === b.orderNumbers.length) continue;
      touched = true;
      if (rest.length === 0) wb.delete(doc(db, COL, b.id));
      else wb.update(doc(db, COL, b.id), { orderNumbers: rest });
    }
    if (touched) await wb.commit();
    const ref = await addDoc(collection(db, COL), { ...p, orderNumbers: nums, createdAtMs: Date.now() });
    const text = `${p.businessName} ${p.company} ${nums.length}건 발주 기록됨`;
    window.dispatchEvent(new CustomEvent<SentRecordedDetail>(SENT_RECORDED_EVENT, { detail: { id: ref.id, text } }));
  } catch (e) {
    console.error('[발주기록] 저장 실패', e);
    alert(`발주기록 저장 실패 — 다음 주문서에서 안 빠질 수 있어요\n${(e as any)?.message || e}`);
  }
}

export async function cancelSentBatch(id: string): Promise<void> {
  await deleteDoc(doc(db, COL, id));
}

/** 1차 주문서(상품준비중 전체)에 없는 주문 = 송장 붙음 → 이전 날짜 기록에서 지움 */
export async function pruneShipped(businessId: string, recordDate: string, masterNums: Set<string>): Promise<void> {
  if (masterNums.size === 0) return;
  for (const b of await getSentBatches()) {
    if (b.businessId !== businessId || !(b.recordDate < recordDate)) continue;
    const rest = b.orderNumbers.filter(n => masterNums.has(n));
    if (rest.length === b.orderNumbers.length) continue;
    try {
      if (rest.length === 0) await deleteDoc(doc(db, COL, b.id));
      else await updateDoc(doc(db, COL, b.id), { orderNumbers: rest });
    } catch (e) { console.error('[발주기록] 정리 실패', e); }
  }
}

// ── 영업일 ──────────────────────────────────────────────
// 공휴일(대체공휴일 포함). 해마다 한 번 확인해서 다음 해를 넣어야 함.
const HOLIDAYS = new Set([
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02', '2026-05-05', '2026-05-25', '2026-06-03',
  '2026-08-17', '2026-09-24', '2026-09-25', '2026-09-28', '2026-10-05', '2026-10-09', '2026-12-25',
  '2027-01-01', '2027-02-08', '2027-02-09', '2027-03-01', '2027-05-05', '2027-05-13', '2027-08-16',
  '2027-09-14', '2027-09-15', '2027-09-16', '2027-10-04', '2027-10-11', '2027-12-27',
]);
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** from 다음 날부터 to까지 영업일 수 (주말·공휴일 뺌) */
export function businessDaysAfter(from: string, to: Date = new Date()): number {
  const d = new Date(from + 'T00:00:00');
  const end = ymd(to);
  let n = 0;
  for (let i = 0; i < 400; i++) {
    d.setDate(d.getDate() + 1);
    const s = ymd(d);
    if (s > end) break;
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6 && !HOLIDAYS.has(s)) n++;
  }
  return n;
}

export const isSentOverdue = (b: SentBatch, now: Date = new Date()) => businessDaysAfter(b.recordDate, now) > (b.waitDays || 2);
