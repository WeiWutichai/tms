import type { T } from '../../i18n';
import type { WebhookDelivery, WebhookDeliveryDetail, WebhookResendResult } from './useWebhooks';

/**
 * ต้นแบบ vPanelApi hook `dl`: 1 แถวต่อ event (ป้ายรหัส HTTP ของครั้งล่าสุด + "ลอง N ครั้ง") — API คืน 1 แถวต่อครั้งที่ส่ง
 * จึงจัดกลุ่มตาม eventId (id ใน envelope) เก็บครั้งล่าสุด · ลำดับตามเวลาส่งล่าสุดของแต่ละ event (ใหม่สุดก่อน)
 */
export function groupDeliveries(rows: WebhookDelivery[]): WebhookDelivery[] {
  const out = new Map<string, WebhookDelivery>();
  for (const r of rows) {
    const cur = out.get(r.eventId);
    if (!cur || r.sentAt > cur.sentAt || (r.sentAt === cur.sentAt && r.attempt > cur.attempt))
      out.set(r.eventId, r);
  }
  return [...out.values()].sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
}

/** reason phrase มาตรฐาน (RFC 9110) ของรหัสที่พบบ่อย — บรรทัดสถานะ "HTTP/1.1 200 OK" ตามต้นแบบ */
const REASON: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/** "200 OK" / "503 Service Unavailable" (รหัสที่ไม่รู้จัก = ตัวเลขอย่างเดียว) */
export const statusLine = (s: number) => (REASON[s] ? `${s} ${REASON[s]}` : String(s));

export const okStatus = (s: number | null | undefined) => !!s && s >= 200 && s < 300;

/** ป้ายผล: รหัส HTTP · ไม่ได้ response = "หมดเวลา" (ต้นแบบ) หรือ "เชื่อมต่อไม่ได้" (DNS/ปฏิเสธ/SSRF) */
export function codeLabel(t: T, d: Pick<WebhookDelivery, 'responseStatus' | 'errorCode'>): string {
  if (d.responseStatus) return String(d.responseStatus);
  return t(d.errorCode === 'timeout' ? 'whk.dl.timeout' : 'whk.dl.noConn');
}

/**
 * ข้อความในหน้าต่าง "ดูข้อมูล" (ต้นแบบ PL: บรรทัด POST + header → body JSON → "— response —")
 * header ที่แสดงมาจาก API (ค่า header เพิ่มเติม = *** · ลายเซ็นแสดงบางส่วน)
 */
export function payloadText(t: T, d: WebhookDeliveryDetail): string {
  // null = body ไม่ใช่ JSON และผู้ดูไม่มีสิทธิ์อ่านราคาทั้งสองฝั่ง (API ตัดราคาไม่ได้จึงไม่ส่ง)
  let body = d.requestBody ?? t('whk.dl.bodyHidden');
  if (d.requestBody !== null)
    try {
      body = JSON.stringify(JSON.parse(d.requestBody), null, 2);
    } catch {
      /* ไม่ใช่ JSON — แสดงตามที่ส่ง */
    }
  const heads = Object.entries(d.requestHeaders)
    .filter(([k]) => !/^(content-type|user-agent)$/i.test(k))
    .map(([k, v]) => `${k}: ${v}`);
  let res: string;
  if (d.responseStatus) {
    let rb = d.responseBody ?? '';
    try {
      rb = rb ? JSON.stringify(JSON.parse(rb), null, 2) : '';
    } catch {
      /* ตามที่ได้รับ */
    }
    res = `HTTP/1.1 ${statusLine(d.responseStatus)}${rb ? `\n${rb}` : ''}`;
  } else res = noResponseText(t, d.errorCode);
  return [`POST ${d.requestUrl}`, ...heads, '', body, '', t('whk.dl.response'), res].join('\n');
}

/** ไม่ได้ response — ข้อความตามสาเหตุ (ต้นแบบมีเฉพาะ timeout) · ไม่แสดงข้อความ error ดิบ (อาจมี IP ภายใน) */
export function noResponseText(t: T, code: string | null): string {
  switch (code) {
    case 'timeout':
      return t('whk.dl.noResponse');
    case 'ssrf_blocked':
      return t('whk.dl.ssrf');
    case 'invalid_url':
    case 'invalid_request':
      return t('whk.dl.invalid');
    default:
      return t('whk.dl.network');
  }
}

/** toast หลังส่งซ้ำ (ต้นแบบ resendDeliv: "ส่งซ้ำสำเร็จ · 200 OK" / "ส่งซ้ำไม่สำเร็จ · 503") */
export function resendToast(t: T, r: WebhookResendResult): string {
  if (r.state === 'delivered') return t('whk.toast.reOk', { code: statusLine(r.status ?? 200) });
  if (r.state === 'queued') return t('whk.toast.reQueued');
  if (r.state === 'skipped') return t('whk.toast.reEnableFirst');
  return t('whk.toast.reFail', {
    code: r.status
      ? String(r.status)
      : codeLabel(t, { responseStatus: null, errorCode: r.errorCode }),
  });
}
