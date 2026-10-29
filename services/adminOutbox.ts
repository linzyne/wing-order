import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';

// 어드민 발주: 윙발주가 만든 업체 양식 발주서를 adminOutbox 컬렉션에 넣으면,
// 업체 어드민 탭에 깔린 크롬 확장(admin-order-extension)이 꺼내 대량 주문입력(엑셀)에 올린다.
// 확장은 업체명·사업자명이 같은 문서만 가져간다.
export async function sendAdminOutbox(params: { company: string; business: string; fileName: string; fileBase64: string; rowCount: number; label: string }): Promise<void> {
  // Firestore 문서 한 개는 1MB까지
  if (params.fileBase64.length > 1_000_000) throw new Error('파일이 너무 커요(1MB 넘음)');
  await addDoc(collection(db, 'adminOutbox'), { ...params, createdAt: serverTimestamp() });
}
