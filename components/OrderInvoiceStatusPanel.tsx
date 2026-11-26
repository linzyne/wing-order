import React, { useCallback, useEffect, useMemo, useState } from 'react';

// 발주 → 송장 → 쿠팡 현황: 업체 한 줄에 세 단계를 붙여, 발주한 업체가 송장까지 다 들어왔는지 한눈에 본다.
// 숫자는 새로 세지 않고 기존 창들이 쓰는 값을 그대로 읽는다.
//  - 발주: 주문서 창의 메일/어드민/롯데 전송 완료 표시 (localStorage wing_order_sent_<작업날짜>)
//  - 송장: 송장 창의 '발주 대비 미변환 현황'과 같은 getInvoiceMatchState (주문 단위 대조)
//  - 쿠팡: 송장 창의 쿠팡 업로드 완료 표시 (coupangUploaded)

interface Round { round: number; hasData: boolean; count?: number }
interface OrderCompany { name: string; orderMethod?: string; rounds: Round[] }
interface MatchCompany { name: string; orderCount: number; matchedCount: number; unmatchedCount: number; unmatchedOrders: { orderNum: string; recipient: string }[] }
interface Handlers {
  getOrderState?: () => OrderCompany[];
  getInvoiceMatchState?: () => MatchCompany[];
  getWorkDate?: () => string;
  downloadInvoice?: (companyName: string) => void;
}
interface Business { id: string; displayName: string }

interface Props {
  businesses: Business[];
  uploadFns: Record<string, Handlers | undefined>;
  coupangUploaded: Record<string, string>;
  onCoupangUploaded: (keys: string[]) => void;
  onUploadCompanyToCoupang: (businessId: string, companyName: string, onStep: (s: string) => void) => Promise<string | void>;
  onOpenOrderPanel: () => void;
  onOpenInvoicePanel: () => void;
  onClose: () => void;
  /** 바뀌면 다시 읽는다 (주문서·송장 업로드 결과 등) */
  refreshKey?: unknown;
}

type SendState = 'sent' | 'partial' | 'none' | 'untracked' | 'nofile';
interface Row {
  key: string; businessId: string; name: string;
  method: string; orderCount: number; send: SendState;
  match?: MatchCompany; coupangAt?: string;
}

const METHOD_LABEL: Record<string, string> = { email: '메일', admin: '어드민', kakao: '카톡' };

const readSentSet = (workDate: string): Set<string> => {
  try {
    const v = JSON.parse(localStorage.getItem(`wing_order_sent_${workDate}`) || '[]');
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

const sendDone = (s: SendState) => s === 'sent' || s === 'untracked' || s === 'nofile';
const invoiceDone = (m?: MatchCompany) => !!m && m.orderCount > 0 && m.unmatchedCount === 0;

const chip = 'text-[11px] font-black px-1.5 py-0.5 rounded-md text-center whitespace-nowrap';
const OK = 'bg-emerald-900/60 text-emerald-300';
const BAD = 'bg-rose-900/60 text-rose-200';
const WAIT = 'bg-zinc-800 text-zinc-500';

const OrderInvoiceStatusPanel: React.FC<Props> = ({
  businesses, uploadFns, coupangUploaded, onCoupangUploaded, onUploadCompanyToCoupang,
  onOpenOrderPanel, onOpenInvoicePanel, onClose, refreshKey,
}) => {
  const [rows, setRows] = useState<Row[]>([]);
  const [onlyPending, setOnlyPending] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, { text: string; tone: 'run' | 'ok' | 'err' }>>({});

  const load = useCallback(() => {
    let workDate = new Date().toLocaleDateString('en-CA');
    for (const b of businesses) { const d = uploadFns[b.id]?.getWorkDate?.(); if (d) { workDate = d; break; } }
    const sent = readSentSet(workDate);
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
          method: o ? (METHOD_LABEL[o.orderMethod ?? ''] ?? '전송') : '',
          orderCount: o ? o.rounds.filter(r => r.hasData).reduce((s, r) => s + (r.count ?? 0), 0) : 0,
          send: o ? sendStateOf(b.id, o, sent) : 'nofile',
          match: m,
        });
      }
    }
    setRows(next);
  }, [businesses, uploadFns]);

  // 창을 열 때와 업로드 결과가 바뀔 때만 다시 읽는다 (주기적으로 묻지 않음)
  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t); }, [load, refreshKey]);

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
    return <button onClick={onOpenOrderPanel} className={`${chip} ${BAD} hover:bg-rose-800`} title="주문서 창에서 보내기">{r.send === 'partial' ? '일부만' : '미전송'}</button>;
  };

  const invoiceChip = (r: Row) => {
    const m = r.match;
    if (!m || m.orderCount === 0) return <span className={`${chip} ${WAIT}`}>—</span>;
    const label = `${m.matchedCount}/${m.orderCount}`;
    if (m.matchedCount === 0) return <button onClick={onOpenInvoicePanel} className={`${chip} ${WAIT} hover:text-zinc-300`} title="송장 창 열기">{label}</button>;
    return (
      <button
        onClick={() => uploadFns[r.businessId]?.downloadInvoice?.(r.name)}
        className={`${chip} ${invoiceDone(m) ? OK : BAD} hover:brightness-125`}
        title="변환된 송장 다운로드"
      >{label}</button>
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

  return (
    <div className="p-3 flex gap-3">
      {/* 오른쪽: 업체별 세 단계 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-2">
          <button onClick={load} className="px-2 py-0.5 rounded-md text-[11px] font-black border text-zinc-400 border-zinc-700 hover:text-white hover:bg-zinc-800">다시 읽기</button>
          <label className="flex items-center gap-1 text-[11px] font-bold text-zinc-400 cursor-pointer">
            <input type="checkbox" checked={onlyPending} onChange={e => setOnlyPending(e.target.checked)} />
            안 끝난 것만
          </label>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-white text-sm font-black">×</button>
        </div>
        <div className="flex gap-3 text-[11px] font-black mb-2">
          <span className="text-zinc-400">발주 <span className={nSend === total ? 'text-emerald-400' : 'text-rose-300'}>{nSend}/{total}</span></span>
          <span className="text-zinc-400">송장 <span className={nInv === total ? 'text-emerald-400' : 'text-rose-300'}>{nInv}/{total}</span></span>
          <span className="text-zinc-400">쿠팡 <span className={nCp === total ? 'text-emerald-400' : 'text-rose-300'}>{nCp}/{total}</span></span>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_64px_54px_64px] gap-1.5 text-[10px] text-zinc-600 font-black pb-1 border-b border-zinc-800">
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
                  <div className="grid grid-cols-[minmax(0,1fr)_64px_54px_64px] gap-1.5 items-center">
                    <button
                      onClick={() => (r.match?.unmatchedCount ?? 0) > 0 && setExpanded(e => e === r.key ? null : r.key)}
                      className={`text-left text-[11px] font-bold truncate ${r.name === '가구매' ? 'text-pink-300' : 'text-zinc-100'}`}
                      title={r.orderCount ? `${r.name} · 발주 ${r.orderCount}줄` : r.name}
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
