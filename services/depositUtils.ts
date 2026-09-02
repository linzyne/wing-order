import type { CompanyDeposit } from '../types';
import type { DepositLedger } from './firestoreService';

/** anchorDate < d.date <= toDate 인 입금액 합계 (anchorDate가 ''이면 처음부터) */
export const sumDepositsBetween = (
  deposits: CompanyDeposit[] | undefined,
  anchorDateExclusive: string,
  toDateInclusive: string
): number =>
  (deposits || [])
    .filter(d => d.date > anchorDateExclusive && d.date <= toDateInclusive)
    .reduce((s, d) => s + (Number(d.amount) || 0), 0);

/** date(미포함) 이전의 가장 최근 잔액 스냅샷 */
export const latestSnapshotBefore = (
  companyLedger: Record<string, number> | undefined,
  date: string
): { date: string; balance: number } | null => {
  if (!companyLedger) return null;
  const dates = Object.keys(companyLedger).filter(d => d < date).sort();
  if (dates.length === 0) return null;
  const last = dates[dates.length - 1];
  return { date: last, balance: companyLedger[last] };
};

/** workDate의 정산을 반영하기 "직전"의 남은 예치금 (직전 스냅샷 + 그 이후 입금분) */
export const balanceBeforeSettlement = (
  deposits: CompanyDeposit[] | undefined,
  companyLedger: Record<string, number> | undefined,
  workDate: string
): number => {
  const anchor = latestSnapshotBefore(companyLedger, workDate);
  const anchorDate = anchor?.date ?? '';
  const anchorBalance = anchor?.balance ?? 0;
  return anchorBalance + sumDepositsBetween(deposits, anchorDate, workDate);
};

/** 이 업체에 예치금 개념이 존재하는가 (입금내역이 있거나 과거 스냅샷이 있으면) */
export const hasDepositLedger = (
  deposits: CompanyDeposit[] | undefined,
  companyLedger: Record<string, number> | undefined
): boolean =>
  (deposits?.length ?? 0) > 0 || Object.keys(companyLedger || {}).length > 0;

export type CompanyDepositInfo = {
  hasLedger: boolean;
  balanceBeforeToday: number;
  recordedToday: boolean;
  recordedBalance: number;
};

/** workDate 기준 업체별 예치금 표시 정보 */
export const buildDepositInfo = (
  deposits: CompanyDeposit[] | undefined,
  ledger: DepositLedger,
  company: string,
  workDate: string
): CompanyDepositInfo | null => {
  const companyLedger = ledger[company];
  if (!hasDepositLedger(deposits, companyLedger)) return null;
  const recordedToday = !!companyLedger && companyLedger[workDate] !== undefined;
  return {
    hasLedger: true,
    balanceBeforeToday: balanceBeforeSettlement(deposits, companyLedger, workDate),
    recordedToday,
    recordedBalance: recordedToday ? companyLedger![workDate] : 0,
  };
};
