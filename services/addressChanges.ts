import { collection, deleteDoc, doc, onSnapshot, query, setDoc, where, type Unsubscribe } from 'firebase/firestore';
import { db } from '../firebase';

// 주소변경: 고객이 주소를 바꿔 달라고 하면 주문번호로 등록해 두고, 발주서를 만들 때 그 주문의 주소(·전화·우편번호)를
// 새 값으로 바꿔 넣는다. 예전엔 긴급공지에 적어 두고 손으로 고쳤다.
// 문서: addressChanges/{id} — 건마다 하나. 발주서에 반영되면 appliedAt·appliedCompany·appliedDate를 남긴다.

export interface AddressChange {
  id: string;
  businessId: string;
  orderNumber: string;
  recipientName?: string;
  /** 등록할 때 주문서에 있던 옛 주소 (확인용) */
  oldAddress?: string;
  newAddress: string;
  newZipcode?: string;
  newPhone?: string;
  memo?: string;
  createdAt: number;
  appliedAt?: number;
  appliedCompany?: string;
  appliedDate?: string;
}

const COL = 'addressChanges';
const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, '');

type Sub = { list: AddressChange[] | null; listeners: Set<(v: AddressChange[]) => void>; unsub: Unsubscribe | null; ready: Promise<void>; resolve: () => void };
const subs = new Map<string, Sub>();

const ensure = (businessId: string): Sub => {
  let s = subs.get(businessId);
  if (s) return s;
  let resolve = () => {};
  const ready = new Promise<void>(r => { resolve = r; });
  s = { list: null, listeners: new Set(), unsub: null, ready, resolve };
  subs.set(businessId, s);
  const entry = s;
  entry.unsub = onSnapshot(query(collection(db, COL), where('businessId', '==', businessId)), snap => {
    entry.list = snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<AddressChange, 'id'>) }))
      .sort((a, b) => b.createdAt - a.createdAt);
    entry.resolve();
    entry.listeners.forEach(l => l(entry.list!));
  }, err => {
    console.error('[주소변경] 구독 실패', err);
    entry.list = entry.list || [];
    entry.resolve();
  });
  return entry;
};

/** 사업자의 주소변경 목록 구독 (여러 화면이 리스너 하나를 같이 씀) */
export const subscribeAddressChanges = (businessId: string | undefined, fn: (v: AddressChange[]) => void): (() => void) => {
  const s = ensure(businessId || '안군농원');
  s.listeners.add(fn);
  if (s.list) fn(s.list);
  return () => { s.listeners.delete(fn); };
};

/** 발주서 만들 때 쓰는 현재 목록 (첫 값이 올 때까지 최대 5초 기다림) */
export const getAddressChanges = async (businessId: string | undefined): Promise<AddressChange[]> => {
  const s = ensure(businessId || '안군농원');
  await Promise.race([s.ready, new Promise(r => setTimeout(r, 5000))]);
  return s.list || [];
};

export const saveAddressChange = (c: AddressChange): Promise<void> => {
  const data: Record<string, unknown> = { ...c };
  delete data.id;
  Object.keys(data).forEach(k => { if (data[k] === undefined || data[k] === '') delete data[k]; });
  return setDoc(doc(db, COL, c.id), data);
};

export const deleteAddressChange = (id: string): Promise<void> => deleteDoc(doc(db, COL, id));

/**
 * 쿠팡 주문서 행(헤더 포함 json)에서 주소변경이 등록된 주문의 주소를 새 값으로 바꾼다. 원본 행은 건드리지 않고 복사본을 돌려준다.
 * 칸: 1=주문번호, 26=수취인이름, 27=수취인전화번호, 28=우편번호, 29=수취인 주소
 */
export const applyAddressChanges = (json: any[][], changes: AddressChange[]): { json: any[][]; applied: AddressChange[] } => {
  if (!changes.length || json.length < 2) return { json, applied: [] };
  const byOrder = new Map(changes.map(c => [norm(c.orderNumber), c]));
  const applied = new Map<string, AddressChange>();
  const out = json.map((row, i) => {
    if (i === 0 || !Array.isArray(row)) return row;
    const c = byOrder.get(norm(row[1]));
    if (!c) return row;
    const r = [...row];
    r[29] = c.newAddress;
    if (c.newZipcode) r[28] = c.newZipcode;
    if (c.newPhone) r[27] = c.newPhone;
    applied.set(c.id, c);
    return r;
  });
  return { json: out, applied: [...applied.values()] };
};

/** 발주서에 반영했다고 남김 (기다리지 않음) */
export const markAddressChangesApplied = (applied: AddressChange[], company: string, date: string): void => {
  const now = Date.now();
  applied.forEach(c => {
    if (c.appliedCompany === company && c.appliedDate === date) return;
    setDoc(doc(db, COL, c.id), { appliedAt: now, appliedCompany: company, appliedDate: date }, { merge: true })
      .catch(e => console.error('[주소변경] 반영 기록 실패', e));
  });
};
