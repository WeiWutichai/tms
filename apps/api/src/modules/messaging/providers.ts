import { Logger } from '@nestjs/common';
import { isLocalEnv } from '../../auth/tokens';

/**
 * ผู้ให้บริการส่งข้อความ (ST3-T21; docs/04 G4 "LINE OA / Messaging API — LINE Notify ปิดบริการแล้ว ใช้ Messaging API")
 * ST0-T01 ยังไม่เลือกผู้ให้บริการ SMS (PROGRESS ST0 T01 "ยังเปิด: อีเมล/SMS, LINE OA") → [OPEN #49]
 * - `mock`  : dev/test เท่านั้น — ไม่ออกนอกเครื่อง เขียน log (ปิดบังผู้รับ) + เก็บในหน่วยความจำให้ test ตรวจ
 * - `line`  : LINE Messaging API push (`POST https://api.line.me/v2/bot/message/push`) ด้วย channel access token ของ tenant
 * - `http`  : SMS ผ่าน HTTP JSON แบบกลาง (`SMS_HTTP_URL` + `SMS_HTTP_TOKEN`) — โครงไว้รอเลือกเจ้าจริง (ปรับ payload ใน adapter นี้ที่เดียว)
 * - `none`  : ปิดช่องทาง (ค่าเริ่มต้นนอก dev/test) — ปุ่มส่งซ่อน ผู้ใช้คัดลอกลิงก์ไปส่งเอง
 * production ตั้ง `mock` = ล้มตอนเริ่ม (ข้อความปลอมห้ามหลุดไปใช้จริง) · ไม่มี secret ใน repo (token ต่อ tenant อยู่ในฐาน เข้ารหัส)
 */
export type MessageChannel = 'LINE' | 'SMS';

export interface OutgoingMessage {
  /** LINE userId (U + 32 hex) หรือเบอร์ 0XXXXXXXXX */
  to: string;
  text: string;
  /** id ของแถว message_delivery — ใช้เป็น X-Line-Retry-Key (ส่งซ้ำหลัง timeout ไม่ได้ข้อความซ้ำ) */
  retryKey: string;
  /** credential ต่อ tenant (LINE channel access token) — ถอดรหัสใน worker เท่านั้น */
  credentials?: { lineToken?: string };
}

export interface MessagingProvider {
  readonly name: string;
  readonly channel: MessageChannel;
  /** ใช้ credential ของ tenant ไหม (LINE จริง = ต้องตั้ง token ก่อนส่ง) */
  readonly needsTenantCredentials: boolean;
  send(m: OutgoingMessage): Promise<{ messageId?: string }>;
}

/** ส่งไม่สำเร็จ — retryable = ลองใหม่ได้ (เครือข่าย/429/5xx) · ไม่ได้ = ล้มทันที (token ผิด/ผู้รับผิด) */
export class MessagingError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** ผู้รับใน log/API: LINE `U1234…cdef` → `U12•••cdef` · เบอร์ `0812345678` → `081•••5678` */
export function maskRecipient(channel: MessageChannel, to: string): string {
  if (channel === 'LINE') return `${to.slice(0, 3)}•••${to.slice(-4)}`;
  return to.length > 6 ? `${to.slice(0, 3)}•••${to.slice(-4)}` : '•••';
}

/** ข้อความใน log: ตัด token ของลิงก์ (ml1.…) ออก */
export const redactLinks = (s: string) => s.replace(/ml1\.[A-Za-z0-9._-]+/g, 'ml1.•••');

/** dev/test — ไม่ออกนอกเครื่อง · `down = true` จำลองผู้ให้บริการล่ม (test) */
export class MockMessagingProvider implements MessagingProvider {
  readonly name = 'mock';
  readonly needsTenantCredentials = false;
  readonly sent: OutgoingMessage[] = [];
  down = false;
  /** ล่มเฉพาะ N ครั้งถัดไป (test retry) */
  failTimes = 0;
  private readonly log = new Logger('MockMessaging');
  constructor(readonly channel: MessageChannel) {}
  async send(m: OutgoingMessage) {
    if (this.down || this.failTimes > 0) {
      if (this.failTimes > 0) this.failTimes--;
      throw new MessagingError('mock provider unavailable', 'provider_unavailable', true);
    }
    this.sent.push(m);
    this.log.log(
      `${this.channel} to=${maskRecipient(this.channel, m.to)} text=${redactLinks(m.text).slice(0, 200)}`,
    );
    return { messageId: `mock-${this.channel.toLowerCase()}-${this.sent.length}` };
  }
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
/** ต้องสั้นกว่า lease ของ outbox มาก (dispatcher: 2 นาที) */
const TIMEOUT_MS = 15_000;

async function post(
  fetchFn: FetchFn,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  try {
    return await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new MessagingError(
      `network error: ${String((e as Error).message ?? e).slice(0, 200)}`,
      'provider_unavailable',
      true,
    );
  }
}

/** สถานะ HTTP → ลองใหม่ได้ไหม (429/5xx = ได้) */
function httpError(prefix: string, status: number, detail: string): MessagingError {
  const retryable = status === 429 || status >= 500;
  const code = retryable
    ? 'provider_unavailable'
    : status === 401 || status === 403
      ? 'provider_auth_failed'
      : 'provider_rejected';
  return new MessagingError(`${prefix} ${status}: ${detail.slice(0, 300)}`, code, retryable);
}

/**
 * LINE Messaging API — push message (ข้อความ text 1 ชิ้น)
 * https://developers.line.biz/en/reference/messaging-api/#send-push-message
 * `X-Line-Retry-Key` = id แถว (UUID) → ส่งซ้ำหลัง timeout แล้ว LINE ตอบ 409 = ถือว่าส่งแล้ว (ไม่ส่งซ้ำถึงผู้รับ)
 */
export class LineMessagingProvider implements MessagingProvider {
  readonly name = 'line';
  readonly channel = 'LINE' as const;
  readonly needsTenantCredentials = true;
  constructor(
    private readonly base = 'https://api.line.me',
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
  ) {}
  async send(m: OutgoingMessage) {
    const token = m.credentials?.lineToken;
    if (!token) throw new MessagingError('LINE channel is not configured', 'not_configured', false);
    const res = await post(
      this.fetchFn,
      `${this.base}/v2/bot/message/push`,
      { Authorization: `Bearer ${token}`, 'X-Line-Retry-Key': m.retryKey },
      { to: m.to, messages: [{ type: 'text', text: m.text }] },
    );
    const requestId = res.headers.get('x-line-request-id') ?? undefined;
    if (res.status === 409 && res.headers.get('x-line-accepted-request-id'))
      return { messageId: res.headers.get('x-line-accepted-request-id') ?? requestId };
    if (!res.ok) throw httpError('LINE', res.status, await res.text().catch(() => ''));
    const json = (await res.json().catch(() => ({}))) as { sentMessages?: { id?: string }[] };
    return { messageId: json.sentMessages?.[0]?.id ?? requestId };
  }
}

/**
 * SMS ผ่าน HTTP JSON (โครงกลาง — ยังไม่เลือกเจ้า [OPEN #49]): `POST SMS_HTTP_URL`
 * body `{ to: "+66812345678", text, sender }` · header `Authorization: Bearer SMS_HTTP_TOKEN`
 * ตอบ 2xx + `{ id | messageId }` = สำเร็จ · เลือกเจ้าจริงแล้วปรับ payload/response ในคลาสนี้ที่เดียว
 */
export class HttpSmsProvider implements MessagingProvider {
  readonly name = 'http';
  readonly channel = 'SMS' as const;
  readonly needsTenantCredentials = false;
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly sender: string,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
  ) {}
  async send(m: OutgoingMessage) {
    const to = m.to.startsWith('0') ? `+66${m.to.slice(1)}` : m.to;
    const res = await post(
      this.fetchFn,
      this.url,
      { Authorization: `Bearer ${this.token}`, 'Idempotency-Key': m.retryKey },
      { to, text: m.text, sender: this.sender },
    );
    if (!res.ok) throw httpError('SMS', res.status, await res.text().catch(() => ''));
    const json = (await res.json().catch(() => ({}))) as { id?: string; messageId?: string };
    return { messageId: json.messageId ?? json.id };
  }
}

/** ค่า env ว่าง = ไม่ได้ตั้ง · dev/test = mock · อื่น ๆ = none (ปิดช่อง — ไม่ตกไปใช้ mock เงียบ ๆ) */
export function lineProviderFromEnv(env = process.env): MessagingProvider | null {
  const kind = env.LINE_PROVIDER || (isLocalEnv() ? 'mock' : 'none');
  if (kind === 'none') return null;
  if (kind === 'mock') {
    if (!isLocalEnv()) throw new Error('LINE_PROVIDER=mock is only allowed in development/test');
    return new MockMessagingProvider('LINE');
  }
  if (kind === 'line') {
    const base = env.LINE_API_BASE || undefined;
    if (base && !/^https:\/\//.test(base) && !isLocalEnv())
      throw new Error('LINE_API_BASE must use https');
    return new LineMessagingProvider(base?.replace(/\/+$/, ''));
  }
  throw new Error(`unknown LINE_PROVIDER '${kind}'`);
}

export function smsProviderFromEnv(env = process.env): MessagingProvider | null {
  const kind = env.SMS_PROVIDER || (isLocalEnv() ? 'mock' : 'none');
  if (kind === 'none') return null;
  if (kind === 'mock') {
    if (!isLocalEnv()) throw new Error('SMS_PROVIDER=mock is only allowed in development/test');
    return new MockMessagingProvider('SMS');
  }
  if (kind === 'http') {
    if (!env.SMS_HTTP_URL || !env.SMS_HTTP_TOKEN)
      throw new Error('SMS_HTTP_URL and SMS_HTTP_TOKEN are required for SMS_PROVIDER=http');
    if (!/^https:\/\//.test(env.SMS_HTTP_URL) && !isLocalEnv())
      throw new Error('SMS_HTTP_URL must use https');
    return new HttpSmsProvider(env.SMS_HTTP_URL, env.SMS_HTTP_TOKEN, env.SMS_SENDER || 'TMS');
  }
  throw new Error(`unknown SMS_PROVIDER '${kind}'`);
}
