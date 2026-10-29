import { collection, onSnapshot, runTransaction, addDoc, getDocs, deleteDoc, query, where, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';

declare var XLSX: any;

// 크롬 확장(wing-order-extension)이 윙에서 받은 주문서 엑셀을 wingInbox 컬렉션에 넣으면,
// 윙발주가 꺼내 주문서 업로드로 넘긴다. 사업자마다 다른 크롬 프로필에서 받으므로 Firestore를 거친다.
export interface WingInboxFile {
  file: File;
  /** 받을 때 윙 화면에 보이던 상품준비중 건수 (못 읽었으면 null) */
  wingCount: number | null;
  /** 파일 안 주문번호 개수 */
  fileCount: number;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function base64ToFile(b64: string, name: string): File {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: XLSX_MIME });
}

// 주문번호 열의 서로 다른 값 개수 (한 주문에 상품이 여러 줄이어도 1건)
async function countOrders(file: File): Promise<number> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null }) as any[][];
  const header = (rows[0] || []).map((h: any) => String(h ?? '').trim());
  const idx = header.findIndex((h: string) => h === '주문번호');
  if (idx === -1) return Math.max(0, rows.length - 1);
  const set = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const v = String(rows[i]?.[idx] ?? '').replace(/\D/g, '');
    if (v) set.add(v);
  }
  return set.size;
}

export function subscribeWingInbox(onFile: (f: WingInboxFile) => void): () => void {
  return onSnapshot(collection(db, 'wingInbox'), snap => {
    snap.docChanges().forEach(ch => {
      if (ch.type !== 'added') return;
      const ref = ch.doc.ref;
      // 윙발주 창이 여러 개 열려 있어도 한 창만 가져가도록, 서버에서 지우는 데 성공한 창이 가져간다.
      runTransaction(db, async tx => {
        const s = await tx.get(ref);
        if (!s.exists()) return null;
        tx.delete(ref);
        return s.data();
      }).then(async (data: any) => {
        if (!data?.fileBase64 || !data?.fileName) return;
        const file = base64ToFile(data.fileBase64, data.fileName);
        const fileCount = await countOrders(file).catch(() => -1);
        onFile({ file, wingCount: typeof data.wingCount === 'number' ? data.wingCount : null, fileCount });
      }).catch(err => console.error('[윙 주문서 받기]', err));
    });
  }, err => console.error('[윙 주문서 받기] 구독 실패', err));
}

// ── 받기 요청 (wingRequests) ──
// 윙발주에서 "쿠팡에서 받기"를 누르면 사업자별 요청을 남기고, 각 사업자 크롬 프로필의 확장이
// 가져가 윙에서 받은 뒤 wingInbox로 보내며 status/message를 적는다.
export type WingRequestStatus = 'pending' | 'running' | 'done' | 'error';
export interface WingRequest {
  id: string;
  businessName: string;
  mode: 'first' | 'next';
  status: WingRequestStatus;
  message: string;
  createdAt: number;
}

export async function createWingRequests(targets: { businessName: string; mode: 'first' | 'next' }[]): Promise<string> {
  const col = collection(db, 'wingRequests');
  // 1시간 넘은 예전 요청은 정리
  const old = await getDocs(col).catch(() => null);
  old?.docs.forEach(d => {
    const at = d.data().createdAt?.toMillis?.() ?? 0;
    if (Date.now() - at > 60 * 60 * 1000) deleteDoc(d.ref).catch(() => {});
  });
  const batchId = `${Date.now()}`;
  await Promise.all(targets.map(t => addDoc(col, {
    businessName: t.businessName, mode: t.mode, status: 'pending', message: '', batchId, createdAt: serverTimestamp(),
  })));
  return batchId;
}

export function subscribeWingRequests(batchId: string, onChange: (reqs: WingRequest[]) => void): () => void {
  return onSnapshot(query(collection(db, 'wingRequests'), where('batchId', '==', batchId)), snap => {
    onChange(snap.docs.map(d => {
      const x = d.data();
      return {
        id: d.id, businessName: x.businessName, mode: x.mode, status: x.status, message: x.message || '',
        createdAt: x.createdAt?.toMillis?.() ?? Date.now(),
      };
    }));
  }, err => console.error('[윙 받기 요청] 구독 실패', err));
}
