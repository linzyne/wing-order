import { useState, useRef, useCallback } from 'react';
import { addDoc, collection, deleteDoc, onSnapshot, query, serverTimestamp, where } from 'firebase/firestore';
import { db } from '../firebase';
import type { InvoiceResult } from '../components/ConsolidatedInvoicePanel';
import type { EmailInvoiceStatus, MailWatchLogEntry } from './useMailInvoiceWatcher';
import { base64ToFile } from '../services/invoiceMailService';

/** 사업자(CompanySelector)가 등록하는 어드민 송장 핸들러 */
export interface AdminInvoiceHandlers {
  getCompanyInfos?: () => { name: string; orderMethod?: string }[];
  getInvoiceMatchState?: () => { name: string; orderCount: number }[];
  uploadVendorInvoiceFromAdmin?: (company: string, files: File[]) => Promise<{ company: string; status: EmailInvoiceStatus }[]>;
}

const WAIT_MS = 60_000;

const REASON: Record<Exclude<EmailInvoiceStatus, 'ok'>, string> = {
  'no-order': '오늘 발주 내역이 없음',
  'no-match': '배송중 목록에 오늘 발주 주문번호가 없음 (아직 송장 안 나옴)',
};

/**
 * 어드민 송장 가져오기: adminOutbox 에 송장 요청(mode 'invoice')을 넣으면 업체 어드민 탭의 확장
 * (admin-order-extension)이 배송중 엑셀을 받아 adminInvoices 로 돌려준다. 그 파일을 업체 줄에 넣어 송장 변환.
 * 돌려받는 건 구독으로 기다리고, 발주방식이 어드민인 업체가 다 답하거나 1분이 지나면 끝낸다.
 */
export const useAdminInvoiceFetcher = (
  uploadFns: Record<string, AdminInvoiceHandlers>,
  businesses: { id: string; displayName: string }[],
  onAccepted: (items: InvoiceResult[]) => void,
) => {
  const [fetching, setFetching] = useState(false);
  const [log, setLog] = useState<MailWatchLogEntry[]>([]);
  const logIdRef = useRef(0);
  const latest = useRef({ uploadFns, businesses, onAccepted });
  latest.current = { uploadFns, businesses, onAccepted };

  const addLog = useCallback((status: MailWatchLogEntry['status'], message: string) => {
    const d = new Date();
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    setLog(prev => [{ id: ++logIdRef.current, time, status, message }, ...prev].slice(0, 30));
  }, []);

  const fetchNow = useCallback(async () => {
    if (fetching) return;
    const { uploadFns, businesses } = latest.current;

    // 기다릴 업체: 발주방식이 어드민이고 오늘 발주가 있는 업체 (사업자 · 업체)
    const waiting = new Set<string>();
    for (const b of businesses) {
      const ordered = new Set((uploadFns[b.id]?.getInvoiceMatchState?.() ?? []).filter(m => m.orderCount > 0).map(m => m.name));
      for (const c of uploadFns[b.id]?.getCompanyInfos?.() ?? []) {
        if (c.orderMethod === 'admin' && ordered.has(c.name)) waiting.add(`${b.displayName} · ${c.name}`);
      }
    }
    if (waiting.size === 0) { addLog('error', '오늘 어드민으로 발주한 업체가 없음'); return; }

    setFetching(true);
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let reqRef: Awaited<ReturnType<typeof addDoc>> | null = null;
    let unsub = () => {};
    let timer = 0;
    const finish = () => {
      clearTimeout(timer);
      unsub();
      if (reqRef) deleteDoc(reqRef).catch(() => {});
      if (waiting.size > 0) addLog('error', `응답 없음: ${[...waiting].join(', ')} — linzyne 크롬에 그 업체 어드민 탭을 열어 두세요`);
      setFetching(false);
    };

    try {
      unsub = onSnapshot(query(collection(db, 'adminInvoices'), where('requestId', '==', requestId)), snap => {
        snap.docChanges().forEach(ch => {
          if (ch.type !== 'added') return;
          const d = ch.doc.data() as { company: string; business: string; fileBase64?: string; rowCount?: number; error?: string };
          deleteDoc(ch.doc.ref).catch(() => {});
          void accept(d).then(() => {
            waiting.delete(`${d.business} · ${d.company}`);
            if (waiting.size === 0) finish();
          });
        });
      }, e => { addLog('error', `구독 실패: ${e.message}`); finish(); });
      reqRef = await addDoc(collection(db, 'adminOutbox'), { mode: 'invoice', requestId, createdAt: serverTimestamp() });
      addLog('pending', `요청 보냄 — ${[...waiting].join(', ')}`);
      timer = window.setTimeout(finish, WAIT_MS);
    } catch (e: any) {
      addLog('error', `요청 실패: ${e?.message || e}`);
      finish();
    }

    async function accept(d: { company: string; business: string; fileBase64?: string; rowCount?: number; error?: string }) {
      const who = `${d.business} · ${d.company}`;
      if (d.error) { addLog('error', `${who}: ${d.error}`); return; }
      if (!d.fileBase64 || !d.rowCount) { addLog('pending', `${who}: 어드민 배송중 0건`); return; }
      const { uploadFns, businesses, onAccepted } = latest.current;
      const file = base64ToFile(d.fileBase64, `${d.business} ${d.company} 어드민송장.xlsx`);
      const same = businesses.filter(b => b.displayName === d.business);
      const accepted: InvoiceResult[] = [];
      const reasons: string[] = [];
      for (const b of same.length ? same : businesses) {
        for (const r of await uploadFns[b.id]?.uploadVendorInvoiceFromAdmin?.(d.company, [file]) ?? []) {
          if (r.status === 'ok') accepted.push({ fileName: `⇩ ${file.name}`, businessId: b.id, displayName: `${b.displayName} · ${r.company}`, status: 'done' });
          else reasons.push(REASON[r.status]);
        }
      }
      if (accepted.length > 0) {
        onAccepted(accepted);
        addLog('success', `${who} ← 배송중 ${d.rowCount}건`);
      } else {
        addLog('pending', `${who}: ${reasons[0] || '이 업체 줄을 못 찾음'}`);
      }
    }
  }, [fetching, addLog]);

  return { fetching, log, fetchNow };
};

export type AdminInvoiceFetcher = ReturnType<typeof useAdminInvoiceFetcher>;
