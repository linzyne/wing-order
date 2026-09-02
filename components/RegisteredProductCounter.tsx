import React, { useMemo, useState, useEffect } from 'react';

interface Props {
  active: boolean;
  onClose: () => void;
}

const STORAGE_KEY = 'registeredProductCounterText';

export interface CountRow {
  vendor: string;        // 등록상품명 앞부분 (업체명 추정)
  itemName: string;      // 자동 정리한 품목명
  registeredName: string; // 원본 등록상품명
  qty: number;           // 구매수량 합계
  orderCount: number;    // 주문(줄) 건수
}

/**
 * 네이버 윙 "상품준비중" 목록을 대량 복붙하면
 * "등록상품명:" 줄을 뽑아 등록상품명별로 품목명과 구매수량을 집계한다.
 *
 * 한 주문 블록에 등록상품명이 여러 개(합포장)일 수 있으므로,
 * "등록상품명:" 을 만나면 대기시켰다가 바로 다음에 오는 수량 줄과 짝지어 확정한다.
 */
export const parseRegisteredProducts = (text: string): { rows: CountRow[]; totalQty: number; totalOrders: number; unparsed: number } => {
  const lines = text.split(/\r?\n/);
  const groups = new Map<string, CountRow>();
  let totalQty = 0;
  let totalOrders = 0;
  let unparsed = 0;

  let pendingName: string | null = null;

  const flush = (name: string, qty: number) => {
    const key = name;
    let g = groups.get(key);
    if (!g) {
      const { vendor, itemName } = splitRegisteredName(name);
      g = { vendor, itemName, registeredName: name, qty: 0, orderCount: 0 };
      groups.set(key, g);
    }
    g.qty += qty;
    g.orderCount += 1;
    totalQty += qty;
    totalOrders += 1;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const nameMatch = line.match(/^등록상품명\s*[:：]\s*(.+)$/);
    if (nameMatch) {
      // 앞의 등록상품명이 수량 줄을 못 만난 채로 새 등록상품명이 나오면 미집계로 표시
      if (pendingName !== null) unparsed += 1;
      pendingName = nameMatch[1].trim();
      continue;
    }

    if (pendingName !== null) {
      // "(개당 중량: 2000 수량: 1) 1개" → 뒤쪽 "1개" 를 구매수량으로
      const trailingEa = line.match(/(\d[\d,]*)\s*개\s*$/);
      const innerQty = line.match(/수량\s*[:：]\s*(\d[\d,]*)/);
      if (trailingEa || innerQty) {
        const n = Number((trailingEa?.[1] || innerQty?.[1] || '0').replace(/,/g, '')) || 0;
        flush(pendingName, n);
        pendingName = null;
      }
    }
  }

  if (pendingName !== null) unparsed += 1;

  const rows = Array.from(groups.values()).sort(
    (a, b) => a.vendor.localeCompare(b.vendor, 'ko') || a.itemName.localeCompare(b.itemName, 'ko')
  );
  return { rows, totalQty, totalOrders, unparsed };
};

/** "여수참맛_총각김치,2kg 1박스" → { vendor: "여수참맛", itemName: "총각김치 2kg 1박스" } */
const splitRegisteredName = (registered: string): { vendor: string; itemName: string } => {
  const us = registered.indexOf('_');
  let vendor = '';
  let rest = registered;
  if (us !== -1) {
    vendor = registered.slice(0, us).trim();
    rest = registered.slice(us + 1).trim();
  }
  const itemName = rest
    .replace(/[,·/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { vendor: vendor || '(미상)', itemName: itemName || registered };
};

const RegisteredProductCounter: React.FC<Props> = ({ active, onClose }) => {
  const [text, setText] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
  });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      if (text.trim()) localStorage.setItem(STORAGE_KEY, text);
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* noop */ }
  }, [text]);

  const { rows, totalQty, totalOrders, unparsed } = useMemo(() => parseRegisteredProducts(text), [text]);

  const vendorGroups = useMemo(() => {
    const m = new Map<string, CountRow[]>();
    rows.forEach(r => {
      const arr = m.get(r.vendor) || [];
      arr.push(r);
      m.set(r.vendor, arr);
    });
    return Array.from(m.entries());
  }, [rows]);

  const handleCopy = () => {
    const header = '업체명\t품목명\t구매수량\t등록상품명';
    const body = rows.map(r => `${r.vendor}\t${r.itemName}\t${r.qty}\t${r.registeredName}`).join('\n');
    const tsv = [header, body].filter(Boolean).join('\n');
    navigator.clipboard.writeText(tsv).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* noop */ });
  };

  return (
    <div className={`absolute right-0 top-full mt-2 z-50 w-[600px] bg-zinc-900 border border-zinc-700/50 rounded-2xl shadow-2xl max-h-[calc(100vh-70px)] overflow-y-auto ${active ? '' : 'hidden'}`}>
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-zinc-200 font-black text-[11px] uppercase tracking-widest">등록상품명 수량 집계</h3>
          <div className="flex items-center gap-2">
            {text.trim() && (
              <button onClick={() => setText('')} className="text-[10px] text-zinc-500 hover:text-rose-400 font-black transition-colors">초기화</button>
            )}
            <button onClick={onClose} className="text-[10px] text-zinc-500 hover:text-white font-black transition-colors">닫기</button>
          </div>
        </div>
        <p className="text-zinc-600 text-[10px] mb-2 font-mono">윙 상품준비중 목록을 통째로 붙여넣으세요. "등록상품명:" 줄을 찾아 등록상품명별 구매수량을 합산합니다. (수백 건도 가능)</p>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'31102668240878\nN\n택배사 선택\n...\n등록상품명: 여수참맛_총각김치,2kg 1박스\n노출상품명: ...\n(개당 중량: 2000 수량: 1) 1개\n...'}
          className="w-full h-[160px] bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-[10px] font-mono text-zinc-300 focus:outline-none focus:border-sky-500/50 resize-none custom-scrollbar"
        />

        {rows.length > 0 && (
          <>
            <div className="flex items-center justify-between mt-3 mb-1.5">
              <div className="text-[10px] font-black text-zinc-400">
                품목 <span className="text-white tabular-nums">{rows.length}</span>종 ·
                구매수량 합계 <span className="text-sky-400 tabular-nums">{totalQty}</span> ·
                주문 <span className="text-white tabular-nums">{totalOrders}</span>건
                {unparsed > 0 && <span className="text-rose-400"> · 수량 못찾음 {unparsed}건</span>}
              </div>
              <button
                onClick={handleCopy}
                className="text-[10px] font-black px-2.5 py-1 rounded-lg border border-sky-500/50 text-sky-400 hover:bg-sky-900/30 transition-all active:scale-95"
              >
                {copied ? '복사됨 ✓' : '엑셀로 복사'}
              </button>
            </div>

            <div className="border border-zinc-800 rounded-xl overflow-hidden">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="bg-zinc-800/60 text-zinc-400 font-black">
                    <th className="text-left px-2 py-1.5">업체명</th>
                    <th className="text-left px-2 py-1.5">품목명</th>
                    <th className="text-right px-2 py-1.5 whitespace-nowrap">구매수량</th>
                    <th className="text-right px-2 py-1.5 whitespace-nowrap">주문</th>
                  </tr>
                </thead>
                <tbody>
                  {vendorGroups.map(([vendor, vRows]) => {
                    const vQty = vRows.reduce((s, r) => s + r.qty, 0);
                    return (
                      <React.Fragment key={vendor}>
                        {vRows.map((r, i) => (
                          <tr key={r.registeredName} className="border-t border-zinc-800/70">
                            {i === 0 ? (
                              <td rowSpan={vRows.length} className="px-2 py-1.5 align-top font-black text-zinc-200 border-r border-zinc-800/70">
                                {vendor}
                                <div className="text-[9px] text-zinc-500 font-bold mt-0.5">계 {vQty}</div>
                              </td>
                            ) : null}
                            <td className="px-2 py-1.5 text-zinc-300" title={r.registeredName}>{r.itemName}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums font-black text-sky-400">{r.qty}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-zinc-500">{r.orderCount}</td>
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {text.trim() && rows.length === 0 && (
          <p className="text-rose-400/80 text-[10px] mt-3 font-mono">"등록상품명:" 줄을 찾지 못했어요. 목록을 통째로(등록상품명·수량 줄 포함) 붙여넣었는지 확인해주세요.</p>
        )}
      </div>
    </div>
  );
};

export default RegisteredProductCounter;
