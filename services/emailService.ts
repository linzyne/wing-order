// 발주서 등 엑셀 파일을 서버리스 함수(/api/send-order-email)를 통해 Gmail로 발송한다.

const MAIL_TOKEN: string = (import.meta as any).env?.VITE_MAIL_TOKEN || '';

const ERROR_MESSAGES: Record<string, string> = {
  unauthorized: '메일 토큰이 일치하지 않습니다. Vercel의 MAIL_SHARED_TOKEN 과 VITE_MAIL_TOKEN 값을 같게 맞추고 재배포하거나, MAIL_SHARED_TOKEN 을 삭제하세요.',
  forbidden_origin: '허용되지 않은 출처에서의 요청입니다.',
  mail_not_configured: '서버에 Gmail 계정이 설정되지 않았습니다. Vercel 환경변수에 GMAIL_USER / GMAIL_APP_PASSWORD 를 추가하고 재배포하세요.',
  no_recipient: '받는사람 이메일이 없습니다.',
  bad_recipient: '받는사람 이메일 형식이 올바르지 않습니다.',
  no_attachment: '첨부할 발주서 파일이 없습니다.',
  attachment_too_large: '첨부파일이 너무 큽니다. (최대 8MB)',
  too_many_recipients: '받는사람이 너무 많습니다. (최대 10명)',
  send_failed: 'Gmail 발송에 실패했습니다. 앱 비밀번호를 확인하세요.',
};

export interface SendOrderEmailParams {
  to: string;              // 콤마로 여러 명 가능
  cc?: string;
  subject: string;
  text: string;
  filename: string;        // 첨부 파일명 (.xlsx)
  contentBase64: string;   // XLSX.write(wb, { bookType: 'xlsx', type: 'base64' })
}

export async function sendOrderEmail(params: SendOrderEmailParams): Promise<{ accepted: string[] }> {
  let res: Response;
  try {
    res = await fetch('/api/send-order-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mail-token': MAIL_TOKEN },
      body: JSON.stringify(params),
    });
  } catch {
    throw new Error('메일 서버에 연결하지 못했습니다. (배포 환경에서만 동작합니다)');
  }

  let data: any = null;
  try { data = await res.json(); } catch { /* noop */ }

  if (!res.ok || !data?.ok) {
    const code = data?.error as string | undefined;
    const msg = (code && ERROR_MESSAGES[code]) || `메일 전송 실패 (HTTP ${res.status})`;
    throw new Error(data?.detail ? `${msg}\n${data.detail}` : msg);
  }
  return { accepted: data.accepted || [] };
}

/** 발주서 메일 기본 제목/본문. 업체 설정(emailSubject/emailBody)이 비어있을 때 사용된다. */
export const DEFAULT_ORDER_MAIL_SUBJECT = '[발주서] {사업자} {업체} {차수} ({날짜})';
export const DEFAULT_ORDER_MAIL_BODY =
  '안녕하세요, {사업자} 입니다.\n\n{날짜} {업체} {차수} 발주서를 첨부드립니다.\n총 {건수}건입니다.\n\n확인 부탁드립니다. 감사합니다.';

export interface OrderMailVars {
  업체: string;
  사업자: string;
  날짜: string;
  차수: string;
  건수: string | number;
}

/** {업체} {사업자} {날짜} {차수} {건수} 치환. 연속 공백은 하나로 줄인다. */
export function renderMailTemplate(template: string, vars: OrderMailVars): string {
  return template
    .replace(/\{(업체|사업자|날짜|차수|건수)\}/g, (_m, k: keyof OrderMailVars) => String(vars[k] ?? '').trim())
    .split('\n')
    .map(line => line.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/g, ''))
    .join('\n');
}
