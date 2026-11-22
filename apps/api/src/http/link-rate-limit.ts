import { rateLimitInstance, slidingWindow, type Bucket } from './rate-limit/rate-limit.service';

/**
 * rate limit ต่อลิงก์ (magic link) สำหรับคำขอเขียนของหน้าลิงก์สาธารณะ (ST4-T08 review L; spec/11 NFR-1106
 * "30 req/นาที ต่อ token") — ซ้อนกับ rate limit ต่อ IP ของ `/v1/public/*`
 * ST7-T08: ใช้ตัวจำกัดกลาง (`RateLimitService.assert`, ใช้ร่วมทุก instance; หน้าต่างเลื่อน 1 นาทีเหมือนเดิม)
 */
export const LINK_WRITE_LIMIT_PER_MIN = Number(process.env.LINK_WRITE_RATE_LIMIT_PER_MIN ?? 30);

/** bucket คำขอเขียนของลิงก์ `linkId` — เกินเพดาน → 429 `rate_limited` (+ `retryAfter` วินาที, scope `link`) */
export const linkWriteBucket = (linkId: string): Bucket =>
  slidingWindow(`lw:${linkId}`, LINK_WRITE_LIMIT_PER_MIN, 60_000, 'link');

/**
 * ST6-T04 review M1: PDF ของลิงก์ (render Chromium — คิว PdfRenderer ใช้ร่วมทุก tenant) จำกัดต่อลิงก์แยกจากคำขอเขียน
 * ค่าเริ่ม 10 ครั้ง/นาที ต่อลิงก์ (ซ้อนกับเพดานต่อ IP ของ `/v1/public/*`) — key ขึ้นต้น `lw:` ให้ `resetLinkWriteRate` ล้างด้วย
 */
export const LINK_PDF_LIMIT_PER_MIN = Number(process.env.LINK_PDF_RATE_LIMIT_PER_MIN ?? 10);
export const linkPdfBucket = (linkId: string): Bucket =>
  slidingWindow(`lw:pdf:${linkId}`, LINK_PDF_LIMIT_PER_MIN, 60_000, 'link');

/**
 * ST6-T11 review M2: คำขออ่านของหน้าลิงก์ที่คำนวณหนัก (ค่าเที่ยวของฉัน — รวมงวด/ประมาณการ WHT) จำกัดต่อลิงก์
 * ค่าเริ่ม 30 ครั้ง/นาที (เท่าเพดานต่อลิงก์ของหน้าติดตาม) ซ้อนกับเพดานต่อ IP ของ `/v1/public/*` — key ขึ้นต้น `lw:` ให้ `resetLinkWriteRate` ล้างด้วย
 */
export const LINK_READ_LIMIT_PER_MIN = Number(process.env.LINK_READ_RATE_LIMIT_PER_MIN ?? 30);
export const linkReadBucket = (linkId: string): Bucket =>
  slidingWindow(`lw:read:${linkId}`, LINK_READ_LIMIT_PER_MIN, 60_000, 'link');

/** สำหรับ test: ล้างตัวนับต่อลิงก์ของไฟล์ test นี้ */
export async function resetLinkWriteRate(): Promise<void> {
  await rateLimitInstance()?.reset('lw:');
}
