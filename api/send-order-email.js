import nodemailer from 'nodemailer';

/**
 * 발주서(엑셀)를 Gmail 계정으로 메일 발송하는 Vercel 서버리스 함수.
 *
 * 필요한 환경변수 (Vercel > Project > Settings > Environment Variables):
 *   GMAIL_USER          발신 Gmail 주소 (예: linzyne@gmail.com)
 *   GMAIL_APP_PASSWORD  해당 계정의 앱 비밀번호 (16자리, 공백 제거)
 *   MAIL_SHARED_TOKEN   클라이언트와 공유하는 단순 토큰 (무단 호출 차단용)
 *
 * 클라이언트는 같은 토큰을 빌드타임 env VITE_MAIL_TOKEN 로 주입받아 헤더로 전송한다.
 */

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8MB (base64 기준 원본)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const expected = process.env.MAIL_SHARED_TOKEN;
  const got = req.headers['x-mail-token'];
  if (!expected || got !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    return res.status(500).json({ error: 'mail_not_configured' });
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
