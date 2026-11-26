import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WingFetchBar from './WingFetchBar';
import { detectBusiness, MailWatchSection, AdminInvoiceSection, type InvoiceResult, type CourierItem } from './ConsolidatedInvoicePanel';
import type { UploadResult } from './SharedMasterUpload';
import type { MailInvoiceWatcher } from '../hooks/useMailInvoiceWatcher';
import type { AdminInvoiceFetcher } from '../hooks/useAdminInvoiceFetcher';

// 주문서 + 송장 한 화면: 왼쪽에 주문서·송장 올리기, 오른쪽에 업체 한 줄마다 발주 → 송장 → 쿠팡.
// 숫자는 새로 세지 않고 기존 창들이 쓰는 값을 그대로 읽는다.
//  - 발주: 주문서 창의 메일/어드민/롯데 전송 완료 표시 (localStorage wing_order_sent_<작업날짜>) — 여기서 보내도 같은 키로 남긴다
//  - 송장: 송장 창의 '발주 대비 미변환 현황'과 같은 getInvoiceMatchState (주문 단위 대조)
//  - 쿠팡: 송장 창의 쿠팡 업로드 완료 표시 (coupangUploaded)
// 올린 결과는 주문서·송장 창과 같은 목록(uploadResults·invoiceResults)에 쌓여 기존 창에서도 보인다.

interface Round { round: number; hasData: boolean; count?: number }
interface OrderCompany { name: string; orderMethod?: string; rounds: Round[] }
interface MatchCompany { name: string; orderCount: number; matchedCount: number; unmatchedCount: number; unmatchedOrders: { orderNum: string; recipient: string }[] }
interface Handlers {
  getOrderState?: () => OrderCompany[];
  getInvoiceMatchState?: () => MatchCompany[];
  getWorkDate?: () => string;
  getNextRound?: () => number;
  uploadMaster?: (f: File) => Promise<void>;
  uploadBatch?: (f: File) => Promise<void>;
  uploadVendorInvoice?: (files: File[]) => void;
  findVendorInvoiceOwners?: (file: File) => Promise<string[]>;
  downloadInvoice?: (companyName: string) => void;
  downloadCompanyMerged?: (companyName: string) => void;
  emailCompanyMerged?: (companyName: string) => Promise<boolean> | void;
  adminCompanyMerged?: (companyName: string) => Promise<boolean> | void;
}
interface Business { id: string; displayName: string }
type Incoming = { file: File; note?: UploadResult['note']; source?: string };

interface Props {
  businesses: Business[];
  uploadFns: Record<string, Handlers | undefined>;
  coupangUploaded: Record<string, string>;
  onCoupangUploaded: (keys: string[]) => void;
  onUploadCompanyToCoupang: (businessId: string, companyName: string, onStep: (s: string) => void) => Promise<string | void>;
  onOpenOrderPanel: () => void;
  onOpenInvoicePanel: () => void;
  onClose: () => void;
  uploadResults: UploadResult[];
  onUploadResultsChange: React.Dispatch<React.SetStateAction<UploadResult[]>>;
  invoiceResults: InvoiceResult[];
  onInvoiceResultsChange: React.Dispatch<React.SetStateAction<InvoiceResult[]>>;
  urgentNotice?: string;
  couriers?: CourierItem[];
  onCourierFilesAdd?: (templateId: string, files: File[]) => void;
  mailWatcher?: MailInvoiceWatcher;
  adminInvoiceFetcher?: AdminInvoiceFetcher;
  /** 현황 창이 열려 있을 때 확장으로 들어온 주문서 */
  incomingFiles?: Incoming[];
  onIncomingTaken?: (taken: Incoming[]) => void;
}

type SendState = 'sent' | 'partial' | 'none' | 'untracked' | 'nofile';
interface Row {
  key: string; businessId: string; name: string;
  method: string; orderMethod?: string; orderCount: number; send: SendState;
  match?: MatchCompany; coupangAt?: string;
}

const METHOD_LABEL: Record<string, string> = { email: '메일', admin: '어드민', kakao: '카톡' };
const todayStr = () => new Date().toLocaleDateString('en-CA');
const sentKey = (workDate: string) => `wing_order_sent_${workDate}`;

const readSentSet = (workDate: string): Set<string> => {
  try {
    const v = JSON.parse(localStorage.getItem(sentKey(workDate)) || '[]');
    return new Set(Array.isArray(v) ? v : []);
  } catch { return new Set(); }
};

// 주문서 창(SharedMasterUpload)의 완료 키와 같은 규칙: 합산을 보냈거나, 데이터 있는 차수를 전부 보냈으면 완료
const sendStateOf = (bizId: string, c: OrderCompany, sent: Set<string>): SendState => {
  const rounds = c.rounds.filter(r => r.hasData);
  const total = rounds.reduce((s, r) => s + (r.count ?? 0), 0);
  if (total === 0) return 'nofile';
  if (c.orderMethod === 'kakao') return 'untracked';
  const merged = `${bizId}_${c.name}_merged`;
  if (sent.has(`${merged}_mail_${total}`) || sent.has(`${merged}_lotte_${total}`)) return 'sent';
  const sentRounds = rounds.filter(r => sent.has(`${bizId}_${c.name}_${r.round}_mail_${r.count}`)).length;
  if (sentRounds === rounds.length) return 'sent';
  return sentRounds > 0 ? 'partial' : 'none';
};

// 송장 창의 가구매 택배 송장 판별과 같은 규칙 (택배사 이름+label → 가구매+label → 가구매+택배사 → 가구매+단일 택배사)
const detectCourier = (filename: string, couriers?: CourierItem[]): CourierItem | null => {
  if (!couriers || couriers.length === 0) return null;
  const lower = filename.normalize('NFC').toLowerCase().replace(/\s/g, '');
  for (const c of couriers) {
    if (!c.label) continue;
    const nameTokens = c.name.toLowerCase().split(/[\s_\-택배]+/).filter(t => t.length >= 2);
    const labelTokens = c.label.toLowerCase().split(/[\s_()\[\]]+/).filter(t => t.length >= 2 && !nameTokens.includes(t));
    if (labelTokens.length > 0 && labelTokens.some(t => lower.includes(t)) && nameTokens.some(t => lower.includes(t))) return c;
  }
  if (!lower.includes('가구매')) return null;
  for (const c of couriers) {
    if (c.label && c.label.toLowerCase().split(/[\s_()\[\]]+/).filter(t => t.length >= 2).some(t => lower.includes(t))) return c;
  }
  for (const c of couriers) {
    if (c.name.toLowerCase().split(/[\s_\-택배]+/).filter(t => t.length >= 2).some(t => lower.includes(t))) return c;
  }
  return couriers.length === 1 ? couriers[0] : null;
};

const sendDone = (s: SendState) => s === 'sent' || s === 'untracked' || s === 'nofile';
const invoiceDone = (m?: MatchCompany) => !!m && m.orderCount > 0 && m.unmatchedCount === 0;
const xlsxOnly = (list: FileList | File[] | null) => Array.from(list ?? []).filter(f => /\.(xlsx|xls)$/i.test(f.name));

const chip = 'text-[11px] font-black px-1.5 py-0.5 rounded-md text-center whitespace-nowrap';
const OK = 'bg-emerald-900/60 text-emerald-300';
const BAD = 'bg-rose-900/60 text-rose-200';
const WAIT = 'bg-zinc-800 text-zinc-500';

const DropBox: React.FC<{ label: string; sub: string; tone: string; onFiles: (files: File[]) => void }> = ({ label, sub, tone, onFiles }) => {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onClick={() => ref.current?.click()}
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); onFiles(xlsxOnly(e.dataTransfer.files)); }}
      className={`cursor-pointer rounded-lg border-2 border-dashed px-2 py-2 text-center transition-colors ${over ? 'border-emerald-400 bg-emerald-500/10' : tone}`}
    >
      <div className="text-[11px] font-black">{label}</div>
      <div className="text-[10px] opacity-60 leading-tight">{sub}</div>
      <input ref={ref} type="file" multiple accept=".xlsx,.xls" className="hidden" onChange={e => { onFiles(xlsxOnly(e.target.files)); e.target.value = ''; }} />
    </div>
  );
};

const OrderInvoiceStatusPanel: React.FC<Props> = ({
  businesses, uploadFns, coupangUploaded, onCoupangUploaded, onUploadCompanyToCoupang,
  onOpenOrderPanel, onOpenInvoicePanel, onClose,
  uploadResults, onUploadResultsChange, invoiceResults, onInvoiceResultsChange,
  urgentNotice, couriers, onCourierFilesAdd, mailWatcher, adminInvoiceFetcher,
  incomingFiles, onIncomingTaken,
}) => {
  const [rows, setRows] = useState<Row[]>([]);
  const [onlyPending, setOnlyPending] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [section, setSection] = useState<'' | 'fetch' | 'mail'>('');
  const [progress, setProgress] = useState<Record<string, { text: string; tone: 'run' | 'ok' | 'err' }>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [log, setLog] = useState<{ text: string; tone: 'ok' | 'err' | 'run' }[]>([]);
  const addLog = (text: string, tone: 'ok' | 'err' | 'run' = 'ok') => setLog(prev => [{ text, tone }, ...prev].slice(0, 6));

  const workDate = useCallback(() => {
    for (const b of businesses) { const d = uploadFns[b.id]?.getWorkDate?.(); if (d) return d; }
    return todayStr();
  }, [businesses, uploadFns]);

  const load = useCallback(() => {
    const sent = readSentSet(workDate());
    const next: Row[] = [];
    for (const b of businesses) {
      const fns = uploadFns[b.id];
      const orders = fns?.getOrderState?.() ?? [];
      const matches = fns?.getInvoiceMatchState?.() ?? [];
      const matchBy = new Map<string, MatchCompany>(matches.map(m => [m.name, m]));
      const names = [...orders.map(o => o.name), ...matches.map(m => m.name).filter(n => !orders.some(o => o.name === n))];
      for (const name of names) {
        const o = orders.find(x => x.name === name);
        const m = matchBy.get(name);
        if (!o && (!m || m.orderCount === 0)) continue;
        next.push({
          key: `${b.id}::${name}`, businessId: b.id, name,
          method: o ? (METHOD_LABEL[o.orderMethod ?? ''] ?? '메일') : '',
          orderMethod: o?.orderMethod,
          orderCount: o ? o.rounds.filter(r => r.hasData).reduce((s, r) => s + (r.count ?? 0), 0) : 0,
          send: o ? sendStateOf(b.id, o, sent) : 'nofile',
          match: m,
        });
      }
    }
    setRows(next);
  }, [businesses, uploadFns, workDate]);

  // 창을 열 때와 업로드 결과가 바뀔 때만 다시 읽는다 (주기적으로 묻지 않음). 워크스테이션이 처리할 시간을 조금 준다.
  useEffect(() => {
    const ts = [150, 1500, 4000].map(ms => setTimeout(load, ms));
    return () => ts.forEach(clearTimeout);
  }, [load, uploadResults, invoiceResults]);

  // ── 주문서 올리기 (주문서 창 processFiles와 같은 규칙: 사업자 다음 차수가 1이면 마스터, 아니면 추가 차수) ──
  const processOrderFiles = async (files: File[], notes?: Map<File, UploadResult['note']>, sources?: Map<File, string>) => {
    const items: UploadResult[] = files.map((f): UploadResult => {
      const biz = detectBusiness(f.name, businesses);
      const nextRound = biz ? (uploadFns[biz.id]?.getNextRound?.() ?? 1) : undefined;
      const item: UploadResult = {
        fileName: f.name, businessId: biz?.id ?? null, displayName: biz?.displayName ?? null,
        mode: nextRound === 1 ? 'master' : 'batch', status: biz ? 'pending' : 'unmatched', round: nextRound, note: notes?.get(f),
      };
      if (item.businessId && nextRound !== 1 && sources?.get(f) === '상품준비중') {
        return { ...item, status: 'error', error: '이미 1차가 있어서 상품준비중 전체는 안 올렸어요 (중복 방지) — 2차는 결제확인으로 받기' };
      }
      return item;
    });
    const offset = uploadResults.length;
    onUploadResultsChange(prev => [...prev, ...items]);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const idx = offset + i;
      const set = (patch: Partial<UploadResult>) => onUploadResultsChange(prev => prev.map((r, j) => j === idx ? { ...r, ...patch } : r));
      if (item.status === 'unmatched') { addLog(`${item.fileName}: 사업자를 못 찾았어요 (파일명에 사업자명)`, 'err'); continue; }
      if (!item.businessId || item.status === 'error') { if (item.error) addLog(`${item.fileName}: ${item.error}`, 'err'); continue; }
      const h = uploadFns[item.businessId];
      if (!h?.uploadMaster || !h?.uploadBatch) { set({ status: 'error', error: '핸들러 없음 (패널 미로드)' }); addLog(`${item.fileName}: 사업자 화면이 아직 안 떴어요`, 'err'); continue; }
      set({ status: 'uploading' });
      try {
        await (item.mode === 'master' ? h.uploadMaster(files[i]) : h.uploadBatch(files[i]));
        set({ status: 'done' });
        addLog(`${item.displayName} ${item.round}차 주문서 올림${item.note ? ` · ${item.note.text}` : ''}`, item.note?.warn ? 'err' : 'ok');
      } catch (e: any) {
        set({ status: 'error', error: e?.message ?? '오류' });
        addLog(`${item.fileName}: ${e?.message ?? '오류'}`, 'err');
      }
    }
  };

  const handleOrderFiles = (files: File[], notes?: Map<File, UploadResult['note']>, sources?: Map<File, string>) => {
    if (files.length === 0) return;
    if (urgentNotice?.trim() && !window.confirm(`긴급공지를 확인하세요\n\n${urgentNotice.trim()}\n\n확인했으면 [확인]을 눌러 주문서를 올립니다.`)) return;
    processOrderFiles(files, notes, sources);
  };

  // 확장으로 들어온 주문서: 사업자 화면(uploadFns)이 아직 안 떴으면 최대 30초 기다렸다가 올린다
  useEffect(() => {
    if (!incomingFiles || incomingFiles.length === 0) return;
    const started = Date.now();
    const tick = setInterval(() => {
      const ready = incomingFiles.every(({ file }) => { const b = detectBusiness(file.name, businesses); return !b || uploadFns[b.id]; });
      if (!ready && Date.now() - started < 30_000) return;
      clearInterval(tick);
      onIncomingTaken?.(incomingFiles);
      handleOrderFiles(incomingFiles.map(x => x.file), new Map(incomingFiles.map(x => [x.file, x.note])), new Map(incomingFiles.map(x => [x.file, x.source ?? ''])));
    }, 500);
    return () => clearInterval(tick);
  }, [incomingFiles]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 송장 올리기 (송장 창 processFiles와 같은 규칙) ──
  const handleInvoiceFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const items: InvoiceResult[] = [];
    const grouped: Record<string, File[]> = {};
    const courierGrouped: Record<string, File[]> = {};
    for (const f of files) {
      const courier = detectCourier(f.name, couriers);
      if (courier) {
        courierGrouped[courier.id] = [...(courierGrouped[courier.id] || []), f];
        items.push({ fileName: f.name, businessId: null, displayName: null, status: 'courier', courierLabel: courier.label ? `${courier.name} (${courier.label})` : courier.name });
        addLog(`${f.name} → 가구매 택배 ${courier.name}`);
        continue;
      }
      let biz = detectBusiness(f.name, businesses);
      if (!biz) {
        for (const b of businesses) {
          try { if (((await uploadFns[b.id]?.findVendorInvoiceOwners?.(f)) ?? []).length > 0) { biz = b; break; } } catch { /* 다음 사업자 */ }
        }
      }
      if (!biz && couriers && couriers.length > 0) {
        items.push({ fileName: f.name, businessId: null, displayName: null, status: 'courier-pending', pendingFile: f });
        addLog(`${f.name}: 어느 택배인지 모르겠어요 — 송장 창에서 택배사 선택`, 'err');
        continue;
      }
      items.push({ fileName: f.name, businessId: biz?.id ?? null, displayName: biz?.displayName ?? null, status: biz ? 'done' : 'unmatched' });
      if (biz) { grouped[biz.id] = [...(grouped[biz.id] || []), f]; addLog(`${f.name} → ${biz.displayName} 송장`); }
      else addLog(`${f.name}: 사업자를 못 찾았어요`, 'err');
    }
    for (const [bizId, bizFiles] of Object.entries(grouped)) uploadFns[bizId]?.uploadVendorInvoice?.(bizFiles);
    for (const [templateId, cFiles] of Object.entries(courierGrouped)) onCourierFilesAdd?.(templateId, cFiles);
    onInvoiceResultsChange(prev => [...prev, ...items]);
  };

  // ── 발주서 보내기 (합산) — 주문서 창과 같은 완료 키로 남겨 거기서도 ✓ ──
  const sendOrder = async (r: Row) => {
    const fns = uploadFns[r.businessId];
    const isAdmin = r.orderMethod === 'admin';
    const run = isAdmin ? fns?.adminCompanyMerged : fns?.emailCompanyMerged;
    if (!run) { onOpenOrderPanel(); return; }
    if (!window.confirm(`${r.name} 합산 발주서 ${r.orderCount}건을 ${isAdmin ? '어드민에 올릴까요' : '메일로 보낼까요'}?\n(차수별로 보내려면 주문서 창)`)) return;
    setSending(r.key);
    try {
      if ((await run(r.name)) === false) return;
      const wd = workDate();
      const set = readSentSet(wd);
      set.add(`${r.businessId}_${r.name}_merged_mail_${r.orderCount}`);
      try { localStorage.setItem(sentKey(wd), JSON.stringify([...set])); } catch { /* 저장 실패는 무시 */ }
      addLog(`${r.name} 발주서 ${isAdmin ? '어드민 올림' : '메일 보냄'}`);
      load();
    } catch (e: any) {
      addLog(`${r.name} 발주서: ${e?.message ?? '실패'}`, 'err');
    } finally { setSending(null); }
  };

  const withCoupang = useMemo(() => rows.map(r => ({ ...r, coupangAt: coupangUploaded[r.key] })), [rows, coupangUploaded]);
  const isDone = (r: Row) => sendDone(r.send) && invoiceDone(r.match) && !!r.coupangAt;
  const visible = onlyPending ? withCoupang.filter(r => !isDone(r)) : withCoupang;

  const total = withCoupang.length;
  const nSend = withCoupang.filter(r => sendDone(r.send)).length;
  const nInv = withCoupang.filter(r => invoiceDone(r.match)).length;
  const nCp = withCoupang.filter(r => r.coupangAt).length;

  const uploadCoupang = async (r: Row) => {
    if (r.match && r.match.unmatchedCount > 0 && !window.confirm(`${r.name}: 송장 미입력 ${r.match.unmatchedCount}건이 있어요. 들어온 것만 먼저 쿠팡에 올릴까요?`)) return;
    setProgress(p => ({ ...p, [r.key]: { text: '프로필 확장 기다리는 중', tone: 'run' } }));
    try {
      const msg = await onUploadCompanyToCoupang(r.businessId, r.name, step => setProgress(p => ({ ...p, [r.key]: { text: step, tone: 'run' } })));
      onCoupangUploaded([r.key]);
      setProgress(p => ({ ...p, [r.key]: { text: msg || '송장 올림', tone: 'ok' } }));
    } catch (e: any) {
      setProgress(p => ({ ...p, [r.key]: { text: e?.message ?? '업로드 실패', tone: 'err' } }));
    }
  };

  const sendChip = (r: Row) => {
    if (r.send === 'nofile') return <span className={`${chip} ${WAIT}`}>—</span>;
    if (r.send === 'untracked') return <span className={`${chip} ${WAIT}`} title="카톡 발주는 보냈는지 기록되지 않아요">{r.method}</span>;
    if (r.send === 'sent') return <span className={`${chip} ${OK}`}>{r.method} ✓</span>;
    return (
      <button onClick={() => sendOrder(r)} disabled={sending === r.key} className={`${chip} ${BAD} hover:bg-rose-800 disabled:opacity-50`} title={`합산 발주서 ${r.method}로 보내기`}>
        {sending === r.key ? '…' : r.send === 'partial' ? '일부 · 보내기' : `${r.method} 보내기`}
      </button>
    );
  };

  const invoiceChip = (r: Row) => {
    const m = r.match;
    if (!m || m.orderCount === 0) return <span className={`${chip} ${WAIT}`}>—</span>;
    const label = `${m.matchedCount}/${m.orderCount}`;
    if (m.matchedCount === 0) return <span className={`${chip} ${WAIT}`} title="송장 파일을 왼쪽 송장 칸에 올리세요">{label}</span>;
    return (
      <button onClick={() => uploadFns[r.businessId]?.downloadInvoice?.(r.name)} className={`${chip} ${invoiceDone(m) ? OK : BAD} hover:brightness-125`} title="변환된 송장 다운로드">{label}</button>
    );
  };

  const coupangChip = (r: Row) => {
    if (r.coupangAt) return <span className={`${chip} ${OK}`} title={`쿠팡 업로드 ${r.coupangAt}`}>✓ {r.coupangAt}</span>;
    if (!r.match || r.match.matchedCount === 0) return <span className={`${chip} ${WAIT}`}>—</span>;
    const running = progress[r.key]?.tone === 'run';
    return (
      <button onClick={() => uploadCoupang(r)} disabled={running} className={`${chip} bg-sky-900/70 text-sky-200 hover:bg-sky-700 disabled:opacity-50`}>
        {running ? '…' : '쿠팡 ↑'}
      </button>
    );
  };

  const byBiz = businesses.map(b => ({ b, list: visible.filter(r => r.businessId === b.id) })).filter(x => x.list.length > 0);
  const sideBtn = (on: boolean) => `w-full text-left px-2 py-1.5 rounded-lg text-[11px] font-black border transition-colors ${on ? 'bg-zinc-700 text-white border-zinc-500' : 'text-zinc-400 border-zinc-700 hover:text-white hover:bg-zinc-800'}`;
  const grid = 'grid grid-cols-[minmax(0,1fr)_72px_54px_64px] gap-1.5';

  return (
    <div className="p-3 flex gap-3">
      {/* 왼쪽: 올리기·가져오기 세로 */}
      <div className="w-[104px] shrink-0 flex flex-col gap-1.5">
        <DropBox label="주문서" sub="드롭·클릭" tone="border-sky-700 text-sky-200 hover:bg-sky-900/40" onFiles={handleOrderFiles} />
        <DropBox label="송장" sub="업체·가구매 택배" tone="border-orange-700 text-orange-200 hover:bg-orange-900/40" onFiles={handleInvoiceFiles} />
        <button onClick={() => setSection(s => s === 'fetch' ? '' : 'fetch')} className={sideBtn(section === 'fetch')}>쿠팡에서 받기</button>
        <button onClick={() => setSection(s => s === 'mail' ? '' : 'mail')} className={sideBtn(section === 'mail')}>
          메일·어드민 송장{mailWatcher?.enabled && <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 align-middle" />}
        </button>
        <div className="h-1" />
        <button onClick={onOpenOrderPanel} className={sideBtn(false)}>주문서 창</button>
        <button onClick={onOpenInvoicePanel} className={sideBtn(false)}>송장 창</button>
      </div>

      {/* 오른쪽: 펼친 칸 + 업체별 세 단계 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-2">
          <button onClick={load} className="px-2 py-0.5 rounded-md text-[11px] font-black border text-zinc-400 border-zinc-700 hover:text-white hover:bg-zinc-800">다시 읽기</button>
          <label className="flex items-center gap-1 text-[11px] font-bold text-zinc-400 cursor-pointer">
            <input type="checkbox" checked={onlyPending} onChange={e => setOnlyPending(e.target.checked)} />
            안 끝난 것만
          </label>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-white text-sm font-black">×</button>
        </div>

        {section === 'fetch' && (
          <div className="mb-2"><WingFetchBar businesses={businesses} getNextRound={id => uploadFns[id]?.getNextRound?.() ?? 1} /></div>
        )}
        {section === 'mail' && (
          <div className="mb-2 flex flex-col gap-2">
            {mailWatcher && <MailWatchSection w={mailWatcher} />}
            {adminInvoiceFetcher && <AdminInvoiceSection f={adminInvoiceFetcher} />}
          </div>
        )}

        {log.length > 0 && (
          <div className="mb-2 flex flex-col gap-0.5">
            {log.map((l, i) => (
              <div key={i} className={`text-[10px] font-bold truncate ${l.tone === 'err' ? 'text-amber-300' : 'text-emerald-400'}`} title={l.text}>{l.tone === 'err' ? '⚠ ' : '✓ '}{l.text}</div>
            ))}
          </div>
        )}

        <div className="flex gap-3 text-[11px] font-black mb-2">
          <span className="text-zinc-400">발주 <span className={nSend === total ? 'text-emerald-400' : 'text-rose-300'}>{nSend}/{total}</span></span>
          <span className="text-zinc-400">송장 <span className={nInv === total ? 'text-emerald-400' : 'text-rose-300'}>{nInv}/{total}</span></span>
          <span className="text-zinc-400">쿠팡 <span className={nCp === total ? 'text-emerald-400' : 'text-rose-300'}>{nCp}/{total}</span></span>
        </div>

        <div className={`${grid} text-[10px] text-zinc-600 font-black pb-1 border-b border-zinc-800`}>
          <span>업체</span><span className="text-center">발주</span><span className="text-center">송장</span><span className="text-center">쿠팡</span>
        </div>

        {total === 0 && <p className="text-[11px] text-zinc-600 text-center py-4">주문서를 올리면 업체가 여기에 나와요</p>}
        {total > 0 && byBiz.length === 0 && <p className="text-[11px] text-emerald-400 text-center py-4 font-black">전부 끝났어요 ✓</p>}

        {byBiz.map(({ b, list }) => (
          <div key={b.id} className="mt-2">
            {businesses.length > 1 && <div className="text-[12px] font-black text-white mb-0.5">{b.displayName}</div>}
            {list.map(r => {
              const unmatched = r.match?.unmatchedOrders ?? [];
              const p = progress[r.key];
              return (
                <div key={r.key} className="border-b border-zinc-900 py-1">
                  <div className={`${grid} items-center`}>
                    <button
                      onClick={() => r.orderCount > 0 && uploadFns[r.businessId]?.downloadCompanyMerged?.(r.name)}
                      className={`text-left text-[11px] font-bold truncate hover:underline ${r.name === '가구매' ? 'text-pink-300' : 'text-zinc-100'}`}
                      title={r.orderCount ? `${r.name} · 발주 ${r.orderCount}줄 — 누르면 합산 발주서 다운로드` : r.name}
                    >{r.name}</button>
                    {sendChip(r)}
                    {invoiceChip(r)}
                    {coupangChip(r)}
                  </div>
                  {(r.match?.unmatchedCount ?? 0) > 0 && (
                    <button onClick={() => setExpanded(e => e === r.key ? null : r.key)} className="text-[10px] text-rose-400 font-bold pl-2 mt-0.5">
                      미입력 {r.match!.unmatchedCount}건 {expanded === r.key ? '▴' : '▾'}
                    </button>
                  )}
                  {expanded === r.key && (
                    <div className="flex flex-wrap gap-1 pl-2 pt-1">
                      {unmatched.length > 0 ? unmatched.map((o, i) => (
                        <span key={`${o.orderNum}-${i}`} className="bg-rose-950/40 text-rose-300 border border-rose-500/20 px-1 py-0.5 rounded text-[10px] font-mono">
                          {o.orderNum} {o.recipient}
                        </span>
                      )) : <span className="text-[10px] text-zinc-600">상세 주문번호는 이 기기에서 송장을 다시 처리하면 보여요</span>}
                    </div>
                  )}
                  {p && (
                    <div className={`text-[10px] font-bold pl-2 mt-0.5 ${p.tone === 'err' ? 'text-red-400' : p.tone === 'ok' ? 'text-emerald-400' : 'text-sky-400'}`}>
                      {p.tone === 'run' ? '⏳ ' : p.tone === 'ok' ? '✓ ' : '✕ '}{p.text}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

export default OrderInvoiceStatusPanel;
