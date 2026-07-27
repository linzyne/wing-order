import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { getHeaderForCompany, inferFieldFromHeader } from '../hooks/useConsolidatedOrderConverter';
import { CS_SAVED_EVENT, WORKSPACE_ADJUSTMENT_EVENT } from '../services/firestoreService';
import type { CsRecord, DailySales, PricingConfig } from '../types';

export interface CsDraft {
  company: string;
  orderNumber: string;
  recipientName: string;
  productName: string;
  qty: number;
  productKey: string;
  reason: string;
  vendorMethod: string;
  customerMethod: '재배송' | '환불';
  deduction: 'full' | 'none';
  refundMethod: '계좌환불' | '전산환불';
  refundBankName: string;
  refundAccountNumber: string;
  refundHolder: string;
  refundAmount: string;
  row: any[];
  headers: string[];
}

const CS_VENDOR_METHOD_SUGGESTIONS = ['재발송', '환불처리', '교환발송', '확인중', '보상'];

const REFUND_BANK_ALIAS: Record<string, string> = { '카뱅': '카카오뱅크', '카카오': '카카오뱅크', '토스': '토스뱅크' };
const REFUND_BANKS = ['KB국민', '국민', '신한', '우리', '하나', 'NH농협', '농협', 'IBK기업', '기업', 'SC제일', '씨티', '카카오뱅크', '카뱅', '카카오', '토스뱅크', '토스', '새마을', '수협', '부산', '대구', '경남', '광주', '전북', '제주', 'KDB산업', '산업', '우체국', '케이뱅크', 'K뱅크'];

/** CS 채팅 등에서 복사한 계좌정보 텍스트를 은행/계좌번호/예금주/금액으로 파싱한다 */
export function parseRefundAccountPaste(text: string) {
  let r = text.trim();
  let accountNumber = '';
  const dashMatch = r.match(/\d+(-\d+)+/);
  if (dashMatch) { accountNumber = dashMatch[0]; r = r.replace(dashMatch[0], ' '); }
  let bankName = '';
  for (const b of REFUND_BANKS) {
    const m = r.match(new RegExp(b + '(은행)?'));
    if (m) { bankName = REFUND_BANK_ALIAS[b] || m[0]; r = r.replace(m[0], ' '); break; }
  }
  let amount = 0;
  const commaMatch = r.match(/(\d{1,3}(,\d{3})+)\s*원?/);
  if (commaMatch) { amount = parseInt(commaMatch[1].replace(/,/g, '')); r = r.replace(commaMatch[0], ' '); }
  else { const wonMatch = r.match(/(\d+)\s*원/); if (wonMatch) { amount = parseInt(wonMatch[1]); r = r.replace(wonMatch[0], ' '); } }
  const tokens = r.trim().split(/\s+/).filter(Boolean);
  const leftover: string[] = [];
  for (const t of tokens) {
    const clean = t.replace(/[,원]/g, '');
    if (/^\d+$/.test(clean)) {
      if (!accountNumber && clean.length >= 8) accountNumber = clean;
      else if (!amount && parseInt(clean) > 0) amount = parseInt(clean);
      else leftover.push(t);
    } else leftover.push(t);
  }
  const holder = leftover.join(' ').trim();
  return { bankName, accountNumber, holder, amount };
}

/** 발주내역 행에서 업체 헤더 구조를 참고해 주문번호/받는사람/품목명/수량 열을 찾아낸다 */
export function resolveOrderRowFields(company: string, row: any[], pricingConfig?: PricingConfig) {
  const config = pricingConfig?.[company];
  const headers = config ? getHeaderForCompany(company, config) : [];
  let orderNumberIdx = -1, recipientNameIdx = -1, productNameIdx = -1, qtyIdx = -1;
  headers.forEach((h, idx) => {
    const field = config?.orderFormFieldMap?.[idx] || inferFieldFromHeader(h);
    if (field === 'orderNumber' && orderNumberIdx === -1) orderNumberIdx = idx;
    if (field === 'recipientName' && recipientNameIdx === -1) recipientNameIdx = idx;
    if (field === 'productName' && productNameIdx === -1) productNameIdx = idx;
    if (field === 'qty' && qtyIdx === -1) qtyIdx = idx;
  });
  return {
    orderNumber: orderNumberIdx >= 0 ? String(row[orderNumberIdx] ?? '') : '',
    recipientName: recipientNameIdx >= 0 ? String(row[recipientNameIdx] ?? '') : '',
    productName: productNameIdx >= 0 ? String(row[productNameIdx] ?? '') : '',
    qty: qtyIdx >= 0 ? (parseInt(String(row[qtyIdx]), 10) || 1) : 1,
  };
}

/** 발주내역 행 + 업체명으로 CS 접수 초안을 만든다 */
export function buildCsDraft(company: string, row: any[], pricingConfig?: PricingConfig): CsDraft {
  const fields = resolveOrderRowFields(company, row, pricingConfig);
  const products = pricingConfig?.[company]?.products || {};
  const matched = Object.entries(products).find(
    ([, p]: [string, any]) => p.orderFormName === fields.productName || p.displayName === fields.productName
  );
  const config = pricingConfig?.[company];
  return {
    company,
    orderNumber: fields.orderNumber,
    recipientName: fields.recipientName,
    productName: fields.productName,
    qty: fields.qty,
    productKey: matched?.[0] || '',
    reason: '',
    vendorMethod: '',
    customerMethod: '재배송',
    deduction: 'none',
    refundMethod: '전산환불',
    refundBankName: '',
    refundAccountNumber: '',
    refundHolder: '',
    refundAmount: '',
    row,
    headers: config ? getHeaderForCompany(company, config) : [],
  };
}

/** 기존 CS 기록으로 수정용 초안을 만든다 (접수 시점에 입력했던 값 그대로 복원) */
export function buildCsDraftFromRecord(record: CsRecord): CsDraft {
  return {
    company: record.company,
    orderNumber: record.orderNumber,
    recipientName: record.recipientName,
    productName: record.productName || '',
    qty: 1,
    productKey: record.productKey || '',
    reason: record.reason,
    vendorMethod: record.vendorMethod || '',
    customerMethod: record.customerMethod,
    deduction: record.deduction,
    refundMethod: record.refundMethod || '전산환불',
    refundBankName: record.refundBankName || '',
    refundAccountNumber: record.refundAccountNumber || '',
    refundHolder: record.refundHolder || '',
    refundAmount: record.refundAmount != null ? String(record.refundAmount) : '',
    row: record.orderRowSnapshot || [],
    headers: record.orderRowHeaders || [],
  };
}

/** 그 업체의 세션에 정산요약 추가/차감 내역을 id 기준으로 반영(수정 시 갱신)하거나 제거한다 */
async function setSettlementAdjustment(
  businessId: string | undefined,
  company: string,
  id: string,
  amount: number,
  label: string,
  remove: boolean
) {
  const { getDailyWorkspace, updateDailyWorkspaceSessionField } = await import('../services/firestoreService');
  const workspace = await getDailyWorkspace(businessId);
  // 이미 이 id가 들어있는 세션이 있으면 그 세션을 그대로 사용(수정 시 원래 위치 유지)
  let sessionId: string | null = null;
  if (workspace?.sessionAdjustments) {
    for (const [sid, list] of Object.entries(workspace.sessionAdjustments)) {
      if ((list as any[]).some(a => a.id === id)) { sessionId = sid; break; }
    }
  }
  if (!sessionId) {
    if (remove) return;
    const rounds = workspace?.companySessionRounds?.[company];
    sessionId = rounds && rounds.length > 0
      ? rounds.reduce((a, b) => (b.round > a.round ? b : a)).id
      : `${company}-1`;
  }
  const existingAdj = workspace?.sessionAdjustments?.[sessionId] || [];
  const withoutOld = existingAdj.filter((a: any) => a.id !== id);
  const nextAdj = remove ? withoutOld : [...withoutOld, { id, amount, label }];
  await updateDailyWorkspaceSessionField(`sessionAdjustments.${sessionId}`, nextAdj, businessId);
}

/** 계좌환불 내역을 그 사업자의 수동 입금 목록에 id 기준으로 반영(수정 시 갱신)하거나 제거한다 */
async function setManualTransferForRefund(
  businessId: string | undefined,
  id: string,
  entry: { label: string; bankName: string; accountNumber: string; amount: number } | null
) {
  const { getDailyWorkspace, updateDailyWorkspaceField } = await import('../services/firestoreService');
  const workspace = await getDailyWorkspace(businessId);
  const existing = workspace?.manualTransfers || [];
  const withoutOld = existing.filter((t: any) => t.id !== id);
  const next = entry ? [...withoutOld, { id, ...entry }] : withoutOld;
  await updateDailyWorkspaceField('manualTransfers', next, businessId);
}

/** CS 기록을 삭제하고, 연결된 반품기록/정산조정/수동입금 내역도 함께 정리한다 */
export async function deleteCsRecord(businessId: string | undefined, date: string, record: CsRecord): Promise<void> {
  const { loadDailySales, upsertDailySales } = await import('../services/firestoreService');
  const existing = await loadDailySales(date, businessId);
  if (!existing) return;

  const returnRecords = (existing.returnRecords || []).filter(r => r.csRecordId !== record.id);
  const returnTotal = returnRecords.reduce((s, r) => s + r.totalMargin, 0);

  await upsertDailySales({
    ...existing,
    csRecords: (existing.csRecords || []).filter(r => r.id !== record.id),
    returnRecords: returnRecords.length > 0 ? returnRecords : undefined,
    returnTotal: returnTotal || undefined,
  }, businessId);
  window.dispatchEvent(new CustomEvent(CS_SAVED_EVENT, { detail: { businessId, date } }));

  const wasRefundDeduction = record.deduction === 'full' && record.customerMethod === '환불';
  const wasAccountRefund = record.customerMethod === '환불' && record.refundMethod === '계좌환불';
  if (wasRefundDeduction || wasAccountRefund) {
    if (wasRefundDeduction) await setSettlementAdjustment(businessId, record.company, `cs-adj-${record.id}`, 0, '', true);
    if (wasAccountRefund) await setManualTransferForRefund(businessId, `cs-refund-${record.id}`, null);
    window.dispatchEvent(new CustomEvent(WORKSPACE_ADJUSTMENT_EVENT, { detail: { businessId } }));
  }
}

interface Props {
  businessId?: string;
  pricingConfig?: PricingConfig;
  draft: CsDraft;
  onChange: (draft: CsDraft) => void;
  onClose: () => void;
  onSaved: () => void;
  /** 지정 시 신규 접수가 아닌 기존 기록 수정 모드로 동작 */
  editing?: { date: string; record: CsRecord };
}

const CsEntryModal: React.FC<Props> = ({ businessId, pricingConfig, draft, onChange, onClose, onSaved, editing }) => {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!draft.reason.trim()) { setError('사유를 입력해주세요.'); return; }
    if (draft.customerMethod === '환불' && draft.deduction === 'full' && !draft.productKey) {
      setError('전액차감 처리를 위해 품목을 선택해주세요.');
      return;
    }
    const isAccountRefund = draft.customerMethod === '환불' && draft.refundMethod === '계좌환불';
    if (isAccountRefund && (!draft.refundBankName.trim() || !draft.refundAccountNumber.trim() || !(parseInt(draft.refundAmount, 10) > 0))) {
      setError('계좌환불 처리를 위해 은행/계좌번호/환불금액을 입력해주세요.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const product = draft.deduction === 'full'
        ? (pricingConfig?.[draft.company]?.products?.[draft.productKey] as any)
        : undefined;
      const supplyPrice = product?.supplyPrice || 0;
      const marginPerUnit = product?.margin || 0;

      const { loadDailySales, upsertDailySales } = await import('../services/firestoreService');
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const targetDate = editing ? editing.date : todayStr;
      const existing = await loadDailySales(targetDate, businessId);
      const base: DailySales = existing || { date: targetDate, records: [], totalAmount: 0, savedAt: new Date().toISOString() };

      const id = editing ? editing.record.id : `cs-${Date.now()}`;
      const csRecord: CsRecord = {
        id,
        orderNumber: draft.orderNumber,
        recipientName: draft.recipientName,
        company: draft.company,
        productKey: draft.productKey || undefined,
        productName: product?.displayName || draft.productName || undefined,
        reason: draft.reason.trim(),
        vendorMethod: draft.vendorMethod.trim(),
        customerMethod: draft.customerMethod,
        deduction: draft.deduction,
        supplyPrice: draft.deduction === 'full' ? supplyPrice : undefined,
        marginPerUnit: draft.deduction === 'full' ? marginPerUnit : undefined,
        refundMethod: draft.customerMethod === '환불' ? draft.refundMethod : undefined,
        refundBankName: isAccountRefund ? draft.refundBankName.trim() : undefined,
        refundAccountNumber: isAccountRefund ? draft.refundAccountNumber.trim() : undefined,
        refundHolder: isAccountRefund ? draft.refundHolder.trim() : undefined,
        refundAmount: isAccountRefund ? parseInt(draft.refundAmount, 10) : undefined,
        vendorStatus: editing ? (editing.record.vendorStatus ?? editing.record.status ?? '접수') : '접수',
        customerStatus: editing ? (editing.record.customerStatus ?? editing.record.status ?? '접수') : '접수',
        vendorCompletedAt: editing ? editing.record.vendorCompletedAt : undefined,
        customerCompletedAt: editing ? editing.record.customerCompletedAt : undefined,
        createdAt: editing ? editing.record.createdAt : now.toISOString(),
        orderRowSnapshot: draft.row.length > 0 ? draft.row : editing?.record.orderRowSnapshot,
        orderRowHeaders: draft.headers.length > 0 ? draft.headers : editing?.record.orderRowHeaders,
      };

      const csRecords = editing
        ? (base.csRecords || []).map(r => (r.id === id ? csRecord : r))
        : [...(base.csRecords || []), csRecord];

      let returnRecords = (base.returnRecords || []).filter(r => r.csRecordId !== id);
      const isRefundDeduction = draft.customerMethod === '환불' && draft.deduction === 'full';
      if (isRefundDeduction) {
        returnRecords = [...returnRecords, {
          company: draft.company,
          productKey: draft.productKey,
          productName: product?.displayName || draft.productName || '',
          count: 1,
          marginPerUnit,
          totalMargin: -marginPerUnit,
          memo: `CS환불 - ${draft.reason.trim()}`,
          type: 'CS환불' as const,
          csRecordId: id,
        }];
      }
      const returnTotal = returnRecords.reduce((s, r) => s + r.totalMargin, 0);

      await upsertDailySales({
        ...base,
        csRecords,
        returnRecords: returnRecords.length > 0 ? returnRecords : undefined,
        returnTotal: returnTotal || undefined,
      }, businessId);
      window.dispatchEvent(new CustomEvent(CS_SAVED_EVENT, { detail: { businessId, date: targetDate } }));

      const wasRefundDeduction = editing ? (editing.record.deduction === 'full' && editing.record.customerMethod === '환불') : false;
      const wasAccountRefund = editing ? (editing.record.customerMethod === '환불' && editing.record.refundMethod === '계좌환불') : false;

      if (isRefundDeduction && supplyPrice > 0) {
        await setSettlementAdjustment(businessId, draft.company, `cs-adj-${id}`, -supplyPrice, `${draft.recipientName}환불`, false);
        window.dispatchEvent(new CustomEvent(WORKSPACE_ADJUSTMENT_EVENT, { detail: { businessId } }));
      } else if (wasRefundDeduction) {
        await setSettlementAdjustment(businessId, draft.company, `cs-adj-${id}`, 0, '', true);
        window.dispatchEvent(new CustomEvent(WORKSPACE_ADJUSTMENT_EVENT, { detail: { businessId } }));
      }

      if (isAccountRefund) {
        await setManualTransferForRefund(businessId, `cs-refund-${id}`, {
          label: `${draft.recipientName || '고객'} CS환불`,
          bankName: draft.refundBankName.trim(),
          accountNumber: draft.refundAccountNumber.trim(),
          amount: parseInt(draft.refundAmount, 10) || 0,
        });
        window.dispatchEvent(new CustomEvent(WORKSPACE_ADJUSTMENT_EVENT, { detail: { businessId } }));
      } else if (wasAccountRefund) {
        await setManualTransferForRefund(businessId, `cs-refund-${id}`, null);
        window.dispatchEvent(new CustomEvent(WORKSPACE_ADJUSTMENT_EVENT, { detail: { businessId } }));
      }

      onSaved();
      onClose();
    } catch (e: any) {
      setError('저장 실패: ' + (e?.message || '알 수 없는 오류'));
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={() => !saving && onClose()}
    >
      <div
        className="relative bg-zinc-900 border border-zinc-700 rounded-[2rem] shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <div>
            <div className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-1">{editing ? 'CS 수정' : 'CS 접수'}</div>
            <div className="text-white font-black text-lg">{draft.recipientName || '이름없음'} · {draft.orderNumber || '주문번호없음'}</div>
            <div className="text-[11px] text-zinc-500 font-bold mt-0.5">
              {draft.company} · {draft.productName}{draft.qty > 1 ? ` x${draft.qty}` : ''}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-600 hover:text-white transition-colors text-2xl font-bold w-9 h-9 flex items-center justify-center rounded-xl hover:bg-zinc-800"
          >
            ×
          </button>
        </div>

        <div className="overflow-y-auto custom-scrollbar flex-1 px-6 py-5 space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] font-black text-zinc-500 uppercase tracking-widest mb-1.5 block">주문번호</label>
              <input
                type="text"
                value={draft.orderNumber}
                onChange={e => onChange({ ...draft, orderNumber: e.target.value })}
                placeholder="주문번호"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:ring-1 focus:ring-violet-500/30 focus:border-violet-500/30 outline-none"
              />
            </div>
            <div>
              <label className="text-[11px] font-black text-zinc-500 uppercase tracking-widest mb-1.5 block">받는사람</label>
              <input
                type="text"
                value={draft.recipientName}
                onChange={e => onChange({ ...draft, recipientName: e.target.value })}
                placeholder="받는사람"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:ring-1 focus:ring-violet-500/30 focus:border-violet-500/30 outline-none"
              />
            </div>
          </div>

          <div>
            <label className="text-[11px] font-black text-zinc-500 uppercase tracking-widest mb-1.5 block">품목명 (표시용)</label>
            <input
              type="text"
              value={draft.productName}
              onChange={e => onChange({ ...draft, productName: e.target.value })}
              placeholder="품목명"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:ring-1 focus:ring-violet-500/30 focus:border-violet-500/30 outline-none"
            />
          </div>

          <div>
            <label className="text-[11px] font-black text-zinc-500 uppercase tracking-widest mb-1.5 block">사유</label>
            <textarea
              value={draft.reason}
              onChange={e => onChange({ ...draft, reason: e.target.value })}
              rows={2}
              placeholder="CS 발생 사유"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:ring-1 focus:ring-violet-500/30 focus:border-violet-500/30 outline-none resize-none"
            />
          </div>

          <div>
            <label className="text-[11px] font-black text-zinc-500 uppercase tracking-widest mb-1.5 block">업체방법</label>
            <input
              list="cs-vendor-method-options"
              value={draft.vendorMethod}
              onChange={e => onChange({ ...draft, vendorMethod: e.target.value })}
              placeholder="업체가 어떻게 처리하는지"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:ring-1 focus:ring-violet-500/30 focus:border-violet-500/30 outline-none"
            />
            <datalist id="cs-vendor-method-options">
              {CS_VENDOR_METHOD_SUGGESTIONS.map(o => <option key={o} value={o} />)}
            </datalist>
          </div>

          <div>
            <label className="text-[11px] font-black text-zinc-500 uppercase tracking-widest mb-1.5 block">고객방법</label>
            <div className="flex gap-2">
              {(['재배송', '환불'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => onChange({ ...draft, customerMethod: m, deduction: m === '재배송' ? 'none' : draft.deduction })}
                  className={`flex-1 py-2 rounded-xl text-sm font-black border transition-all ${
                    draft.customerMethod === m ? 'bg-violet-500 text-white border-violet-500' : 'bg-zinc-950 text-zinc-500 border-zinc-800 hover:text-white'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {draft.customerMethod === '환불' && (
            <div className="bg-zinc-950/60 border border-zinc-800 rounded-2xl p-4 space-y-3">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm font-bold text-zinc-300">계좌로 환불</span>
                <button
                  type="button"
                  onClick={() => onChange({ ...draft, refundMethod: draft.refundMethod === '계좌환불' ? '전산환불' : '계좌환불' })}
                  className={`relative w-11 h-6 rounded-full shrink-0 transition-colors ${draft.refundMethod === '계좌환불' ? 'bg-indigo-500' : 'bg-zinc-700'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${draft.refundMethod === '계좌환불' ? 'translate-x-5' : ''}`} />
                </button>
              </label>

              {draft.refundMethod === '계좌환불' && (
                <div className="space-y-2 pt-1">
                  <textarea
                    rows={2}
                    placeholder="계좌정보 복붙 (예: 국민은행 123-456-789012 홍길동 30000원)"
                    onChange={e => {
                      const parsed = parseRefundAccountPaste(e.target.value);
                      onChange({
                        ...draft,
                        refundBankName: parsed.bankName || draft.refundBankName,
                        refundAccountNumber: parsed.accountNumber || draft.refundAccountNumber,
                        refundHolder: parsed.holder || draft.refundHolder,
                        refundAmount: parsed.amount ? String(parsed.amount) : draft.refundAmount,
                      });
                    }}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-mono text-zinc-300 placeholder-zinc-600 focus:ring-1 focus:ring-indigo-500/30 focus:border-indigo-500/30 outline-none resize-none"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      placeholder="은행"
                      value={draft.refundBankName}
                      onChange={e => onChange({ ...draft, refundBankName: e.target.value })}
                      className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-bold text-white placeholder-zinc-600 outline-none"
                    />
                    <input
                      type="text"
                      placeholder="계좌번호"
                      value={draft.refundAccountNumber}
                      onChange={e => onChange({ ...draft, refundAccountNumber: e.target.value })}
                      className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono font-bold text-white placeholder-zinc-600 outline-none"
                    />
                    <input
                      type="text"
                      placeholder="예금주"
                      value={draft.refundHolder}
                      onChange={e => onChange({ ...draft, refundHolder: e.target.value })}
                      className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-bold text-white placeholder-zinc-600 outline-none"
                    />
                    <input
                      type="number"
                      placeholder="환불금액"
                      value={draft.refundAmount}
                      onChange={e => onChange({ ...draft, refundAmount: e.target.value })}
                      className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-black text-rose-500 placeholder-zinc-600 outline-none"
                    />
                  </div>
                </div>
              )}

              <label className="flex items-center justify-between cursor-pointer pt-2 border-t border-zinc-800/70">
                <span className="text-sm font-bold text-zinc-300">마진 전액 차감</span>
                <button
                  type="button"
                  onClick={() => onChange({ ...draft, deduction: draft.deduction === 'full' ? 'none' : 'full' })}
                  className={`relative w-11 h-6 rounded-full shrink-0 transition-colors ${draft.deduction === 'full' ? 'bg-rose-500' : 'bg-zinc-700'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${draft.deduction === 'full' ? 'translate-x-5' : ''}`} />
                </button>
              </label>

              {draft.deduction === 'full' && (
                <div className="pt-1">
                  <select
                    value={draft.productKey}
                    onChange={e => onChange({ ...draft, productKey: e.target.value })}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-white outline-none focus:ring-1 focus:ring-rose-500/30 focus:border-rose-500/30"
                  >
                    <option value="">품목 선택...</option>
                    {Object.entries(pricingConfig?.[draft.company]?.products || {}).map(([key, p]: [string, any]) => (
                      <option key={key} value={key}>
                        {p.displayName}{p.orderFormName && p.orderFormName !== p.displayName ? ` → ${p.orderFormName}` : ''} (공급가 {(p.supplyPrice || 0).toLocaleString()}원)
                      </option>
                    ))}
                  </select>
                  {draft.productKey && (() => {
                    const p = pricingConfig?.[draft.company]?.products?.[draft.productKey] as any;
                    if (!p) return null;
                    return (
                      <p className="text-[11px] text-zinc-500 font-bold mt-1.5">
                        공급가 {(p.supplyPrice || 0).toLocaleString()}원 · 마진 {(p.margin || 0).toLocaleString()}원 차감됩니다
                      </p>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          {error && <p className="text-rose-400 text-xs font-bold">{error}</p>}
        </div>

        <div className="px-6 py-4 border-t border-zinc-800 shrink-0">
          <button
            onClick={handleSubmit}
            disabled={
              saving ||
              !draft.reason.trim() ||
              (draft.customerMethod === '환불' && draft.deduction === 'full' && !draft.productKey) ||
              (draft.customerMethod === '환불' && draft.refundMethod === '계좌환불' && (!draft.refundBankName.trim() || !draft.refundAccountNumber.trim() || !(parseInt(draft.refundAmount, 10) > 0)))
            }
            className="w-full py-3 rounded-xl bg-violet-500 hover:bg-violet-400 disabled:bg-zinc-800 disabled:text-zinc-600 text-white font-black text-sm transition-all"
          >
            {saving ? '저장 중...' : editing ? '수정 완료' : '접수 완료'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default CsEntryModal;
