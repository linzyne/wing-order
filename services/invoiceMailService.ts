// 업체가 메일로 보낸 송장 엑셀을 서버리스 함수(/api/fetch-invoice-mail)로 가져온다.

const TOKEN_KEY = 'invoiceMailToken';

export const getInvoiceMailToken = (): string => {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
};
export const setInvoiceMailToken = (token: string) => {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
  } catch { /* 저장 불가 환경 — 이번 세션만 동작 */ }
};

const ERROR_MESSAGES: Record<string, string> = {
  unauthorized: '메일 가져오기 비밀번호가 틀렸습니다.',
  token_not_configured: 'Vercel 환경변수에 INVOICE_MAIL_TOKEN 이 없습니다. 추가 후 재배포하세요.',
  mail_not_configured: 'Vercel 환경변수에 GMAIL_USER / GMAIL_APP_PASSWORD 가 없습니다.',
  forbidden_origin: '허용되지 않은 출처에서의 요청입니다.',
  no_senders: '품목/업체 탭에 이메일이 등록된 업체가 없습니다.',
  imap_failed: 'Gmail 메일함을 읽지 못했습니다. (Gmail 설정에서 IMAP 사용이 켜져 있는지 확인하세요)',
};

export interface InvoiceMail {
  uid: number;
  from: string;
  subject: string;
  date: string;
  attachments: { filename: string; contentBase64: string }[];
  skipped: string[];
}

export class InvoiceMailError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}

async function call(body: object): Promise<any> {
  let res: Response;
  try {
    res = await fetch('/api/fetch-invoice-mail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-invoice-token': getInvoiceMailToken() },
      body: JSON.stringify(body),
    });
  } catch {
    throw new InvoiceMailError('메일 서버에 연결하지 못했습니다. (배포 환경에서만 동작합니다)');
  }
  let data: any = null;
  try { data = await res.json(); } catch { /* noop */ }
  if (!res.ok || !data?.ok) {
    const code = data?.error as string | undefined;
    const msg = (code && ERROR_MESSAGES[code]) || `메일 가져오기 실패 (HTTP ${res.status})`;
    throw new InvoiceMailError(data?.detail ? `${msg}\n${data.detail}` : msg, code);
  }
  return data;
}

export async function fetchInvoiceMails(senders: string[]): Promise<{ messages: InvoiceMail[]; truncated: boolean }> {
  const data = await call({ senders });
  return { messages: data.messages || [], truncated: !!data.truncated };
}

/** 처리 끝난 메일에 라벨을 붙여 다음부터 안 가져오게 한다 */
export async function ackInvoiceMails(uids: number[]): Promise<void> {
  if (uids.length === 0) return;
  await call({ ack: uids });
}

export const base64ToFile = (b64: string, filename: string): File => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const type = /\.xls$/i.test(filename)
    ? 'application/vnd.ms-excel'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return new File([bytes], filename, { type });
};

/** 업체 설정의 email 칸(콤마·세미콜론 구분)을 소문자 주소 목록으로 */
export const splitEmails = (raw?: string): string[] =>
  String(raw || '').split(/[,;]/).map(s => s.trim().toLowerCase()).filter(Boolean);
