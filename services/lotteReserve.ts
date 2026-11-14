import { collection, onSnapshot, addDoc, deleteDoc, query, where, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import type { CourierTemplate } from '../types';
import { resolveSenderColumns } from '../types';

declare var XLSX: any;

// 롯데택배 예약: 고른 주문을 롯데 B-type 양식('사무실(롯데)' 택배 양식)으로 만들어 wingRequests(mode 'lotte')에 담으면,
// 그 사업자 크롬 프로필의 윙 확장이 ALPS에 올려 예약하고 운송장번호까지 받아 lotteWaybills/{batchId}에 적는다.
// 롯데 목록에서 이번 예약 줄만 찾으려고 주문번호 칸에는 쿠팡 주문번호 대신 W261114-153012-1(날짜-시분초-순번)을 넣는다.

export interface LotteOrder {
  orderNumber: string;   // 쿠팡 주문번호
  recipientName: string;
  phone: string;
  address: string;
  source: 'fake' | 'order'; // 가구매 / 발주서 미리보기에서 고른 주문
  companyName?: string;
}

export interface LotteItem {
  ordNo: string;          // 롯데에 올린 주문번호 (W…-n)
  orderNumber: string;
  recipient: string;
  source: 'fake' | 'order';
  companyName?: string;
  waybill?: string;
}

export interface LotteBatch {
  batchId: string;
  businessName: string;
  date: string;
  items: LotteItem[];
}

const pad = (n: number) => String(n).padStart(2, '0');
export const localYMD = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const normOrderNum = (s: string) => String(s || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();

/** 사무실 롯데 택배 양식 (이름·라벨에 '롯데'가 든 것, 여럿이면 '사무실' 우선) */
export function findLotteTemplate(templates: CourierTemplate[]): CourierTemplate | null {
  const full = (t: CourierTemplate) => `${t.name} ${t.label || ''}`;
  const lotte = templates.filter(t => full(t).includes('롯데'));
  return lotte.find(t => full(t).includes('사무실')) || lotte[0] || null;
}

function buildLotteFile(template: CourierTemplate, orders: LotteOrder[], senderName: string, batchId: string) {
  const { mapping, fixedValues } = template;
  const rows: any[][] = [[...template.headers]];
  const items: LotteItem[] = [];
  const seen = new Set<string>();
  for (const o of orders) {
    const key = normOrderNum(o.orderNumber);
    if (!key || seen.has(key)) continue; // 한 주문 = 한 상자
    seen.add(key);
    const ordNo = `${batchId}-${items.length + 1}`;
    const row = new Array(template.headers.length).fill('');
    row[mapping.orderNumber] = ordNo;
    row[mapping.recipientName] = o.recipientName;
    row[mapping.recipientPhone] = o.phone;
    row[mapping.recipientAddress] = o.address;
    Object.entries(fixedValues).forEach(([colIdx, value]) => { row[Number(colIdx)] = value; });
    resolveSenderColumns(template).forEach(idx => { row[idx] = senderName; });
    rows.push(row);
    items.push({ ordNo, orderNumber: String(o.orderNumber).trim(), recipient: o.recipientName, source: o.source, ...(o.companyName ? { companyName: o.companyName } : {}) });
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const fileBase64: string = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
  return { fileName: `${localYMD()} ${senderName} 롯데예약 ${batchId}.xlsx`, fileBase64, items };
}

/**
 * 롯데 예약 요청. 확장이 요청을 가져가면 onClaimed를 한 번 부르고, 운송장번호까지 받을 때까지 기다린 결과를 돌려준다.
 * 45초 안에 안 가져가면 그 프로필이 안 열린 것. 롯데 창에서 사람이 이어 할 수도 있어 가져간 뒤에는 30분까지 기다린다.
 */
export async function requestLotteReserve(
  businessName: string,
  template: CourierTemplate,
  orders: LotteOrder[],
  onStep?: (message: string) => void,
  onClaimed?: () => void,
): Promise<string> {
  const d = new Date();
  const batchId = `W${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const { fileName, fileBase64, items } = buildLotteFile(template, orders, businessName, batchId);
  if (items.length === 0) throw new Error('예약할 주문이 없어요');
  const ref = await addDoc(collection(db, 'wingRequests'), {
    businessName, mode: 'lotte', status: 'pending', message: '', fileName, fileBase64,
    items: JSON.stringify(items), batchId, createdAt: serverTimestamp(),
  });
  return new Promise<string>((resolve, reject) => {
    let claimed = false;
    const finish = (err: Error | null, msg = '') => {
      clearTimeout(timer);
      unsub();
      deleteDoc(ref).catch(() => {});
      err ? reject(err) : resolve(msg);
    };
    let timer = setTimeout(() => {
      if (!claimed) finish(new Error(`${businessName} 크롬 프로필이 안 열려 있어요 (윙 주문서 확장 확인)`));
    }, 45 * 1000);
    const unsub = onSnapshot(ref, snap => {
      const x = snap.data();
      if (!x) return;
      if (x.status !== 'pending' && !claimed) {
        claimed = true;
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error('롯데 예약이 30분 넘게 안 끝났어요 — 그 프로필의 롯데 창 확인')), 30 * 60 * 1000);
        if (x.status === 'running') onClaimed?.();
      }
      if (x.status === 'done') finish(null, x.message || '');
      else if (x.status === 'error') finish(new Error(x.message || '롯데 예약 실패'));
      else if (x.message) onStep?.(x.message);
    }, err => finish(err));
  });
}

/** 오늘 받은 롯데 운송장번호 (확장이 lotteWaybills에 적은 것) */
export function subscribeLotteWaybills(date: string, onChange: (batches: LotteBatch[]) => void): () => void {
  return onSnapshot(query(collection(db, 'lotteWaybills'), where('date', '==', date)), snap => {
    onChange(snap.docs.map(d => {
      const x = d.data();
      let items: LotteItem[] = [];
      try { items = JSON.parse(x.items || '[]'); } catch { items = []; }
      return { batchId: x.batchId || d.id, businessName: x.businessName || '', date: x.date || '', items };
    }));
  }, err => console.error('[롯데 운송장] 구독 실패', err));
}

/** 쿠팡 주문번호(정규화) → 롯데 운송장번호 */
export function lotteTrackingMap(batches: LotteBatch[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const b of batches) for (const it of b.items) {
    if (it.waybill) map.set(normOrderNum(it.orderNumber), it.waybill);
  }
  return map;
}
