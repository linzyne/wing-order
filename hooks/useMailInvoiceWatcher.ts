import { useState, useRef, useEffect, useCallback } from 'react';
import type { InvoiceResult } from '../components/ConsolidatedInvoicePanel';
import { fetchInvoiceMails, ackInvoiceMails, base64ToFile, getInvoiceMailToken, InvoiceMailError } from '../services/invoiceMailService';

export type EmailInvoiceStatus = 'ok' | 'no-order' | 'no-match';

/** 사업자(CompanySelector)가 등록하는 메일 송장 핸들러 */
export interface MailInvoiceHandlers {
  getVendorEmails?: () => string[];
  uploadVendorInvoiceFromEmail?: (sender: string, files: File[]) => Promise<{ company: string; status: EmailInvoiceStatus }[]>;
}

export interface MailWatchLogEntry {
  id: number;
  time: string;
  status: 'success' | 'pending' | 'error';
  message: string;
}

const POLL_MS = 90_000;
const ENABLED_KEY = 'invoiceMailWatch';

const REASON: Record<Exclude<EmailInvoiceStatus, 'ok'>, string> = {
  'no-order': '오늘 발주 내역이 없음 (주문서 업로드 전이면 올린 뒤 자동 처리)',
  'no-match': '파일에 이 업체 발주 주문번호가 없음',
};

const readEnabled = () => { try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; } };
const writeEnabled = (on: boolean) => { try { localStorage.setItem(ENABLED_KEY, on ? '1' : '0'); } catch { /* noop */ } };

/**
 * 업체가 보낸 송장 메일을 주기적으로 가져와, 보낸 주소로 업체를 정해 그 업체 줄에만 송장 파일을 넣는다.
 * (품목/업체 탭에 저장된 업체 이메일 = 발주서 보내는 주소 = 송장 보내오는 주소)
 * 업체 줄이 받아들인 메일만 Gmail 라벨로 '처리됨' 표시하고, 못 받은 메일은 다음 확인 때 다시 시도한다.
 */
export const useMailInvoiceWatcher = (
  uploadFns: Record<string, MailInvoiceHandlers>,
  businesses: { id: string; displayName: string }[],
  onAccepted: (items: InvoiceResult[]) => void,
) => {
  const [enabled, setEnabledState] = useState(readEnabled);
  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [log, setLog] = useState<MailWatchLogEntry[]>([]);

  const runningRef = useRef(false);
  const loggedPendingRef = useRef<Set<string>>(new Set());
  const logIdRef = useRef(0);
  const latest = useRef({ uploadFns, businesses, onAccepted });
  latest.current = { uploadFns, businesses, onAccepted };

  const now = () => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const addLog = useCallback((status: MailWatchLogEntry['status'], message: string) => {
    setLog(prev => [{ id: ++logIdRef.current, time: now(), status, message }, ...prev].slice(0, 30));
  }, []);

  const checkNow = useCallback(async () => {
    if (runningRef.current) return;
    if (!getInvoiceMailToken()) { setError('메일 가져오기 비밀번호를 입력하세요.'); return; }
    runningRef.current = true;
    setChecking(true);
    try {
      const { uploadFns, businesses, onAccepted } = latest.current;
      const senders: string[] = [...new Set<string>(businesses.flatMap(b => uploadFns[b.id]?.getVendorEmails?.() ?? []))];
      if (senders.length === 0) { setError('품목/업체 탭에 이메일이 등록된 업체가 없습니다.'); return; }

      const { messages } = await fetchInvoiceMails(senders);
      const done: number[] = [];
      const accepted: InvoiceResult[] = [];

      for (const m of messages) {
        const files = m.attachments.map(a => base64ToFile(a.contentBase64, a.filename));
        if (files.length === 0) {
          done.push(m.uid); // 엑셀 첨부가 없는 메일 — 다시 볼 필요 없음
          addLog('error', `${m.from}: 엑셀 첨부 없음${m.skipped.length ? ` (너무 큰 파일: ${m.skipped.join(', ')})` : ''} — 제외`);
          continue;
        }

        const oks: string[] = [];
        const reasons: string[] = [];
        for (const b of businesses) {
          const res = await uploadFns[b.id]?.uploadVendorInvoiceFromEmail?.(m.from, files) ?? [];
          for (const r of res) {
            if (r.status === 'ok') {
              oks.push(`${b.displayName} ${r.company}`);
              files.forEach(f => accepted.push({ fileName: `✉ ${f.name}`, businessId: b.id, displayName: `${b.displayName} · ${r.company}`, status: 'done' }));
            } else {
              reasons.push(`${b.displayName} ${r.company}: ${REASON[r.status]}`);
            }
          }
        }

        const fileNames = files.map(f => f.name).join(', ');
        if (oks.length > 0) {
          done.push(m.uid);
          addLog('success', `${oks.join(', ')} ← ${fileNames}`);
          try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
              new Notification('메일 송장 도착', { body: `${oks.join(', ')}\n${fileNames}` });
            }
          } catch { /* noop */ }
        } else {
          const key = `${m.uid}|${reasons.join('|')}`;
          if (!loggedPendingRef.current.has(key)) {
            loggedPendingRef.current.add(key);
            addLog('pending', `${m.from} (${fileNames}) 대기 — ${reasons.join(' / ') || '이 주소로 등록된 업체 없음'}`);
          }
        }
      }

      if (accepted.length > 0) onAccepted(accepted);
      if (done.length > 0) await ackInvoiceMails(done);
      setError('');
      setLastChecked(now());
    } catch (e: any) {
      setError(e instanceof InvoiceMailError ? e.message : (e?.message || '메일 확인 실패'));
      if (e instanceof InvoiceMailError && e.code === 'unauthorized') { setEnabledState(false); writeEnabled(false); }
    } finally {
      runningRef.current = false;
      setChecking(false);
    }
  }, [addLog]);

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    writeEnabled(on);
    if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // 앱을 켠 직후엔 업체 발주 내역이 아직 안 불러와졌을 수 있어 조금 기다렸다가 첫 확인
    const first = window.setTimeout(checkNow, 5_000);
    const id = window.setInterval(checkNow, POLL_MS);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [enabled, checkNow]);

  return { enabled, setEnabled, checking, lastChecked, error, log, checkNow };
};

export type MailInvoiceWatcher = ReturnType<typeof useMailInvoiceWatcher>;
