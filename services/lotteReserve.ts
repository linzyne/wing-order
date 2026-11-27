import { collection, onSnapshot, addDoc, deleteDoc, query, where, serverTimestamp, doc, runTransaction, setDoc } from 'firebase/firestore';
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
  orderNumbers?: string[]; // 발주서 합산 줄: 한 상자에 든 쿠팡 주문번호 전부
  productName?: string;    // 발주서 미리보기 품목명 → 롯데 상품명 칸
}

/** 발주서 미리보기에서 체크한 줄 하나 (key: 체크 표시용 정규화 주문번호) */
export interface LotteReservePick {
  key: string;
  orderNumbers: string[];
  productName: string;
}

export interface LotteItem {
  ordNo: string;          // 롯데에 올린 주문번호 (W…-001)
  orderNumber: string;
  recipient: string;
  source: 'fake' | 'order';
  companyName?: string;
  orderNumbers?: string[];
  waybill?: string;
}

export interface LotteBatch {
  batchId: string;
  businessName: string;
  date: string;
  at: number;             // 운송장번호를 적은 시각 (ms)
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

// 롯데 양식의 상품명 칸 (B-type은 '상품명1')
const findProductCol = (headers: string[]) => headers.findIndex(h => /상품명|품목|물품/.test(String(h || '')));

function buildLotteFile(template: CourierTemplate, orders: LotteOrder[], senderName: string, batchId: string) {
  const { mapping, fixedValues } = template;
  const productCol = findProductCol(template.headers);
  const rows: any[][] = [[...template.headers]];
  const items: LotteItem[] = [];
  const seen = new Set<string>();
  for (const o of orders) {
    const key = normOrderNum(o.orderNumber);
    if (!key || seen.has(key)) continue; // 한 주문 = 한 상자
    seen.add(key);
    // 롯데 주문번호 검색은 앞부분 일치라 -1로 찾으면 -10~-19도 같이 나온다. 3자리(-001)로 맞춰 서로 겹치지 않게 한다.
    const ordNo = `${batchId}-${String(items.length + 1).padStart(3, '0')}`;
    const row = new Array(template.headers.length).fill('');
    row[mapping.orderNumber] = ordNo;
    row[mapping.recipientName] = o.recipientName;
    row[mapping.recipientPhone] = o.phone;
    row[mapping.recipientAddress] = o.address;
    Object.entries(fixedValues).forEach(([colIdx, value]) => { row[Number(colIdx)] = value; });
    resolveSenderColumns(template).forEach(idx => { row[idx] = senderName; });
    if (productCol >= 0 && o.productName) row[productCol] = o.productName;
    rows.push(row);
    items.push({
      ordNo, orderNumber: String(o.orderNumber).trim(), recipient: o.recipientName, source: o.source,
      ...(o.companyName ? { companyName: o.companyName } : {}),
      ...(o.orderNumbers && o.orderNumbers.length > 1 ? { orderNumbers: o.orderNumbers.map(n => String(n).trim()) } : {}),
    });
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

/** fromDate(YYYY-MM-DD) 이후 받은 롯데 운송장번호 (확장이 lotteWaybills에 적은 것).
 *  어제 저녁 예약하고 오늘 아침 쿠팡에 올리는 경우도 있어 어제부터 본다. */
export function subscribeLotteWaybills(fromDate: string, onChange: (batches: LotteBatch[]) => void): () => void {
  return onSnapshot(query(collection(db, 'lotteWaybills'), where('date', '>=', fromDate)), snap => {
    onChange(snap.docs.map(d => {
      const x = d.data();
      let items: LotteItem[] = [];
      try { items = JSON.parse(x.items || '[]'); } catch { items = []; }
      return { batchId: x.batchId || d.id, businessName: x.businessName || '', date: x.date || '', at: x.at?.toMillis?.() ?? 0, items };
    }));
  }, err => console.error('[롯데 운송장] 구독 실패', err));
}

/** 쿠팡 주문번호(정규화) → 롯데 운송장번호 */
export function lotteTrackingMap(batches: LotteBatch[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const b of batches) for (const it of b.items) {
    if (!it.waybill) continue;
    map.set(normOrderNum(it.orderNumber), it.waybill);
    (it.orderNumbers || []).forEach(n => map.set(normOrderNum(n), it.waybill!));
  }
  return map;
}

// ── 가구매 롯데 운송장 → 쿠팡 자동 업로드 ──
// 앱을 켠 PC가 여럿이면 같은 배치를 여러 번 올리게 되므로 lotteAutoUploads/{batchId}를 트랜잭션으로 잡은 한 곳만 올린다.
// count: 올릴 운송장 수 — 롯데 창을 이어서 해 운송장이 더 붙으면(count가 커지면) 다시 잡아 올린다.
export async function claimLotteAutoUpload(batchId: string, count: number, by: string): Promise<boolean> {
  const ref = doc(db, 'lotteAutoUploads', batchId);
  try {
    return await runTransaction(db, async tx => {
      const cur = (await tx.get(ref)).data();
      if (cur && (cur.count ?? 0) >= count) {
        // 맡은 PC가 10분 넘게 끝내지 못했으면(창을 닫는 등) 다시 잡는다
        const stale = cur.state === 'running' && Date.now() - (cur.claimedAt?.toMillis?.() ?? 0) > 10 * 60 * 1000;
        if (!stale) return false;
      }
      tx.set(ref, { batchId, count, by, state: 'running', message: '', claimedAt: serverTimestamp() });
      return true;
    });
  } catch (err) {
    console.error('[롯데 자동 업로드] 잡기 실패', err);
    return false;
  }
}

export function finishLotteAutoUpload(batchId: string, state: 'done' | 'error', message: string) {
  return setDoc(doc(db, 'lotteAutoUploads', batchId), { state, message, finishedAt: serverTimestamp() }, { merge: true })
    .catch(err => console.error('[롯데 자동 업로드] 결과 저장 실패', err));
}
