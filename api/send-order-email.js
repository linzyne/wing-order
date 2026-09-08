import nodemailer from 'nodemailer';

/**
 * 발주서(엑셀)를 Gmail 계정으로 메일 발송하는 Vercel 서버리스 함수.
 *
 * 필수 환경변수 (Vercel > Project > Settings > Environment Variables):
 *   GMAIL_USER          발신 Gmail 주소 (예: linzyne@gmail.com)
 *   GMAIL_APP_PASSWORD  해당 계정의 앱 비밀번호 (16자리, 공백 제거)
 *
 * 선택 환경변수:
 *   MAIL_SHARED_TOKEN   설정한 경우에만 클라이언트 토큰(x-mail-token)을 검사한다.
 *                       클라이언트는 같은 값을 빌드타임 env VITE_MAIL_TOKEN 으로 주입받아야 하며,
 *                       두 값이 어긋나면 401이 난다. 설정하지 않으면 아래 Origin 검사만 적용된다.
 *                       (VITE_ 값은 번들에 그대로 노출되므로 진짜 비밀은 아니다.)
 */

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8MB (base64 기준 원본)
const MAX_RECIPIENTS = 10;

/** 브라우저에서 온 동일 출처 요청인지 확인 (비브라우저 호출은 Origin이 없어 통과) */
function isForeignOrigin(req) {
  const origin = req.headers.origin || '';
  if (!origin) return false; // curl 등 Origin 없는 요청은 토큰/자격증명 단계에서 걸러진다
  let host;
  try { host = new URL(origin).host; } catch { return true; }
  const self = req.headers['x-forwarded-host'] || req.headers.host || '';
  if (host === self) return false;
  if (host === process.env.VERCEL_URL) return false;
  if (host === 'localhost:3000' || host.startsWith('localhost:')) return false;
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (isForeignOrigin(req)) {
    return res.status(403).json({ error: 'forbidden_origin' });
  }

  // MAIL_SHARED_TOKEN을 설정한 경우에만 토큰을 검사한다.
  const expected = process.env.MAIL_SHARED_TOKEN;
  if (expected && req.headers['x-mail-token'] !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    const missing = [!user && 'GMAIL_USER', !pass && 'GMAIL_APP_PASSWORD'].filter(Boolean);
    return res.status(500).json({ error: 'mail_not_configured', detail: `누락된 환경변수: ${missing.join(', ')}` });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'invalid_json' }); }
  }
  const { to, cc, subject, text, filename, contentBase64 } = body || {};

  const recipients = String(to || '')
    .split(/[,;]/)
    .map(s => s.trim())
    .filter(Boolean);
  if (recipients.length === 0) return res.status(400).json({ error: 'no_recipient' });
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!recipients.every(r => emailRe.test(r))) return res.status(400).json({ error: 'bad_recipient' });

  if (!filename || !contentBase64) return res.status(400).json({ error: 'no_attachment' });
  const buf = Buffer.from(contentBase64, 'base64');
  if (buf.length === 0) return res.status(400).json({ error: 'empty_attachment' });
  if (buf.length > MAX_ATTACHMENT_BYTES) return res.status(413).json({ error: 'attachment_too_large' });

  const ccList = String(cc || '')
    .split(/[,;]/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(r => emailRe.test(r));

  if (recipients.length + ccList.length > MAX_RECIPIENTS) {
    return res.status(400).json({ error: 'too_many_recipients' });
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });

  try {
    const info = await transporter.sendMail({
      from: user,
      to: recipients,
      cc: ccList.length ? ccList : undefined,
      subject: subject ? String(subject) : '발주서',
      text: text ? String(text) : '발주서를 첨부합니다.',
      attachments: [{
        filename: String(filename),
        content: buf,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }],
    });
    return res.status(200).json({ ok: true, id: info.messageId, accepted: info.accepted });
  } catch (err) {
    console.error('send-order-email failed:', err);
    return res.status(502).json({ error: 'send_failed', detail: String(err && err.message || err) });
  }
}
