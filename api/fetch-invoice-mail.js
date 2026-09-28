import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/**
 * 업체가 메일로 보낸 송장 엑셀을 Gmail(IMAP)에서 읽어 오는 Vercel 서버리스 함수.
 * 앱의 '메일 송장 자동 가져오기'가 켜져 있으면 주기적으로 호출한다.
 *
 * 필수 환경변수:
 *   GMAIL_USER / GMAIL_APP_PASSWORD  발주서 메일 발송에 쓰는 것과 같은 계정
 *   INVOICE_MAIL_TOKEN               받은편지함(고객 이름·주소가 든 송장)을 읽는 API라서
 *                                    반드시 비밀번호를 건다. 번들에 넣지 않고, 앱에서 기기마다
 *                                    한 번 입력받아 브라우저에만 저장한다.
 *
 * POST { senders: string[] }  → 오늘(한국시간) 온, 아직 처리 안 된 메일의 엑셀 첨부 목록
 * POST { ack: number[] }      → 처리 끝난 메일에 PROCESSED_LABEL 라벨을 붙여 다시 안 가져오게 함
 */

const PROCESSED_LABEL = 'wing-invoice-done';
const MAX_RESPONSE_BYTES = 3.5 * 1024 * 1024; // Vercel 응답 한도(4.5MB) 안쪽, base64 기준
const MAX_SENDERS = 100;
const emailRe = /^[^\s@(){}"]+@[^\s@(){}"]+\.[^\s@(){}"]+$/;

function isForeignOrigin(req) {
  const origin = req.headers.origin || '';
  if (!origin) return false;
  let host;
  try { host = new URL(origin).host; } catch { return true; }
  const self = req.headers['x-forwarded-host'] || req.headers.host || '';
  if (host === self) return false;
  if (host === process.env.VERCEL_URL) return false;
  if (host.startsWith('localhost:')) return false;
  return true;
}

/** 오늘 0시(한국시간)의 Date */
function kstMidnight() {
  const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
  kstNow.setUTCHours(0, 0, 0, 0);
  return new Date(kstNow.getTime() - 9 * 3600 * 1000);
}

/** Gmail은 라벨 없는 [Gmail]/전체보관함에서 찾아야 필터로 보관처리된 메일도 잡힌다 */
async function openAllMail(client) {
  const boxes = await client.list();
  const all = boxes.find(b => b.specialUse === '\\All');
  await client.mailboxOpen(all ? all.path : 'INBOX');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (isForeignOrigin(req)) return res.status(403).json({ error: 'forbidden_origin' });

  const expected = process.env.INVOICE_MAIL_TOKEN;
  if (!expected) return res.status(500).json({ error: 'token_not_configured' });
  if (req.headers['x-invoice-token'] !== expected) return res.status(401).json({ error: 'unauthorized' });

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return res.status(500).json({ error: 'mail_not_configured' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'invalid_json' }); }
  }
  const ack = Array.isArray(body?.ack) ? body.ack.map(Number).filter(n => Number.isInteger(n) && n > 0) : null;
  const senders = Array.isArray(body?.senders)
    ? [...new Set(body.senders.map(s => String(s).trim().toLowerCase()).filter(s => emailRe.test(s)))].slice(0, MAX_SENDERS)
    : [];
  if (!ack && senders.length === 0) return res.status(400).json({ error: 'no_senders' });

  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();
    await openAllMail(client);

    if (ack) {
      if (ack.length > 0) {
        await client.messageFlagsAdd(ack, [PROCESSED_LABEL], { uid: true, useLabels: true });
      }
      return res.status(200).json({ ok: true, acked: ack.length });
    }

    const since = kstMidnight();
    const fromQuery = senders.map(s => `from:${s}`).join(' ');
    const uids = await client.search(
      { gmraw: `has:attachment newer_than:2d -label:${PROCESSED_LABEL} {${fromQuery}}` },
      { uid: true },
    );

    const messages = [];
    let totalBytes = 0;
    let truncated = false;
    for (const uid of (uids || []).sort((a, b) => a - b)) {
      const msg = await client.fetchOne(String(uid), { envelope: true, internalDate: true, source: true }, { uid: true });
      if (!msg || !msg.source) continue;
      if (msg.internalDate && new Date(msg.internalDate) < since) continue; // 어제 온 메일은 제외

      const from = (msg.envelope?.from?.[0]?.address || '').toLowerCase();
      if (!senders.includes(from)) continue;

      const parsed = await simpleParser(msg.source);
      const attachments = [];
      const skipped = [];
      for (const a of parsed.attachments || []) {
        const name = String(a.filename || '');
        if (!/\.(xlsx|xls)$/i.test(name)) continue;
        const b64 = a.content.toString('base64');
        if (b64.length > MAX_RESPONSE_BYTES) { skipped.push(name); continue; }
        attachments.push({ filename: name, contentBase64: b64 });
      }
      const size = attachments.reduce((s, a) => s + a.contentBase64.length, 0);
      if (messages.length > 0 && totalBytes + size > MAX_RESPONSE_BYTES) { truncated = true; break; }
      totalBytes += size;

      messages.push({
        uid,
        from,
        subject: parsed.subject || msg.envelope?.subject || '',
        date: (msg.internalDate ? new Date(msg.internalDate) : new Date()).toISOString(),
        attachments,
        skipped,
      });
    }

    return res.status(200).json({ ok: true, messages, truncated });
  } catch (err) {
    console.error('fetch-invoice-mail failed:', err);
    return res.status(502).json({ error: 'imap_failed', detail: String((err && err.message) || err) });
  } finally {
    try { await client.logout(); } catch { /* noop */ }
  }
}
