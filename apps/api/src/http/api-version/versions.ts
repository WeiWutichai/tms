/**
 * ST7-T07 Versioning (docs/04 G1 "Versioning"; docs/01 §5.1; spec/07 INT-050/059)
 *
 * - major อยู่ใน path (`/v1`) · พฤติกรรมย่อย pin ด้วย `X-Api-Version: YYYY-MM-DD`
 * - วันที่ที่ pin = "ใช้พฤติกรรมของทุกการเปลี่ยนแปลงที่ออกในหรือก่อนวันนั้น" (แบบ Stripe) — วันใดก็ได้ตั้งแต่เวอร์ชันแรกถึงวันนี้
 * - ลำดับการเลือก: header ในคำขอ → เวอร์ชันที่ pin ไว้บน API key → วันที่สร้างบริษัท (Asia/Bangkok) — ไม่มี tenant = ล่าสุด
 * - เพิ่ม field / enum / endpoint = ไม่ breaking (ไม่ต้องมี gate) · client ต้องรับ enum ที่ไม่รู้จักได้
 * - การเปลี่ยนที่ breaking ต้องลงทะเบียนเป็น "gate" ใน VERSION_CHANGES พร้อมตัวแปลงย้อนกลับ (downgrade) ของ response
 *   และ/หรือตัวแปลง request ของ client เวอร์ชันเก่า แล้วติด `@VersionGate(id)` ที่ route ที่ได้รับผล
 */

import { ProblemException } from '../../common/problem';

/** วันที่รูปแบบ YYYY-MM-DD */
export type ApiVersion = string;

export interface ApiRelease {
  version: ApiVersion;
  /** คำอธิบายสั้น (ลง OpenAPI `info.x-api-versions`) */
  summary: string;
  /** ประกาศเลิกใช้เวอร์ชันนี้เมื่อ (ต้อง ≥ 12 เดือนก่อน sunset — docs/04 G1) */
  deprecatedAt?: ApiVersion;
  /** วันที่หยุดรองรับ (header `Sunset`) */
  sunset?: ApiVersion;
}

/** คำขอแบบย่อที่ตัวแปลง request เข้าถึงได้ (query ที่ parse แล้ว — แก้ในที่ได้) */
export interface VersionedRequest {
  query: Record<string, unknown>;
}

export interface VersionChange {
  /** ชื่อคงที่ของการเปลี่ยน — ใช้กับ `@VersionGate(id)` */
  id: string;
  /** เวอร์ชันแรกที่ได้พฤติกรรมใหม่ — คำขอที่ pin ก่อนวันนี้ได้พฤติกรรมเดิม */
  version: ApiVersion;
  description: string;
  /** แปลงคำขอของ client เวอร์ชันเก่าให้เป็นรูปแบบปัจจุบัน (ก่อน validation) */
  upgradeRequest?(req: VersionedRequest): void;
  /** แปลง response ปัจจุบันกลับเป็นรูปแบบเดิม (คืนค่าใหม่หรือแก้ในที่ก็ได้) */
  downgradeResponse?(body: unknown): unknown;
}

/** เวอร์ชันที่ออกแล้ว เรียงจากเก่าไปใหม่ — ตัวแรก = เวอร์ชันแรกของ API สาธารณะ (ตัวอย่างใน docs/01 §5.1) */
export const API_RELEASES: readonly ApiRelease[] = [
  { version: '2026-11-01', summary: 'เวอร์ชันแรกของ /v1' },
  {
    version: '2026-11-18',
    summary: 'API key: สถานะ `rotating` แยกจาก `active` (ST7-T07 — ตัวอย่างกลไก gate)',
  },
];

export const FIRST_API_VERSION: ApiVersion = API_RELEASES[0]!.version;
export const LATEST_API_VERSION: ApiVersion = API_RELEASES[API_RELEASES.length - 1]!.version;

// ---------- การเปลี่ยนที่มี gate ----------

type KeyLike = { status?: unknown; prefix?: unknown; scopes?: unknown };
const isKey = (o: unknown): o is KeyLike =>
  !!o && typeof o === 'object' && 'status' in o && 'prefix' in o && 'scopes' in o;

/**
 * [DECISION ST7-T07 — ตัวอย่าง gate จริง 1 รายการ] ก่อน 2026-11-18 API key ที่หมุนแล้วแต่ยังไม่ถึง revokeAt แสดงเป็น `active`
 * (client เก่าไม่รู้จัก `rotating`): ตอบ `status: active` · ตัวกรอง `status=active` รวม key ที่กำลังหมุน ·
 * summary รวมจำนวน rotating เข้า active และไม่มี field `rotating` — ข้อมูลยังถูกต้อง (key ใช้ได้จริงถึง revokeAt)
 */
const apiKeyRotatingStatus: VersionChange = {
  id: 'api_key.status_rotating',
  version: '2026-11-18',
  description:
    'API key ที่หมุนแล้ว (ใช้ได้ถึง revokeAt) มีสถานะ `rotating` — ก่อนหน้านี้แสดงเป็น `active` และตัวกรอง `status=active` รวม key เหล่านี้',
  upgradeRequest(req) {
    const s = req.query.status;
    if (typeof s !== 'string' || !s) return;
    const list = s.split(',');
    // client เก่าไม่รู้จัก `rotating` — ค่าที่ไม่มีในเวอร์ชันนั้น = 422 เหมือนค่าที่ไม่รู้จักอื่น (review ST7-T07)
    if (list.includes('rotating'))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'status',
          code: 'unknown_value',
          message: '`rotating` is not available before X-Api-Version 2026-11-18',
        },
      ]);
    if (list.includes('active')) req.query.status = [...list, 'rotating'].join(',');
  },
  downgradeResponse(body) {
    const fix = (k: unknown) => {
      if (isKey(k) && k.status === 'rotating') k.status = 'active';
    };
    if (!body || typeof body !== 'object') return body;
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.data)) b.data.forEach(fix);
    else if (isKey(b)) fix(b);
    else if (typeof b.rotating === 'number' && typeof b.active === 'number') {
      // ApiKeySummaryDto
      b.active += b.rotating;
      delete b.rotating;
    }
    return b;
  },
};

export const VERSION_CHANGES: readonly VersionChange[] = [apiKeyRotatingStatus];

const CHANGES_BY_ID = new Map(VERSION_CHANGES.map((c) => [c.id, c]));
export const versionChange = (id: string): VersionChange | undefined => CHANGES_BY_ID.get(id);

// ---------- การแปลง/เลือกเวอร์ชัน ----------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** วันที่ (YYYY-MM-DD) ของเวลา `d` ในเขตเวลา Asia/Bangkok (UTC+7 ไม่มี DST) */
export function bangkokDate(d: Date): ApiVersion {
  return new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

export type VersionError = 'format' | 'before_first' | 'future';

/** ตรวจค่า `X-Api-Version` — คืนวันที่ปกติ หรือเหตุผลที่ไม่ผ่าน */
export function parseApiVersion(
  raw: string,
  now = new Date(),
): { ok: true; version: ApiVersion } | { ok: false; reason: VersionError } {
  const v = raw.trim();
  const m = DATE_RE.exec(v);
  if (!m) return { ok: false, reason: 'format' };
  const d = new Date(`${v}T00:00:00Z`);
  // วันที่ต้องมีจริงในปฏิทิน (2026-02-30 ไม่ผ่าน)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v)
    return { ok: false, reason: 'format' };
  if (v < FIRST_API_VERSION) return { ok: false, reason: 'before_first' };
  if (v > bangkokDate(now)) return { ok: false, reason: 'future' };
  return { ok: true, version: v };
}

/** วันที่ pin จากวันสร้าง (บริษัท) — ก่อนเวอร์ชันแรก = เวอร์ชันแรก */
export function versionFromDate(d: Date): ApiVersion {
  const v = bangkokDate(d);
  return v < FIRST_API_VERSION ? FIRST_API_VERSION : v;
}

export type VersionSource = 'header' | 'api_key' | 'tenant' | 'latest';

/**
 * เลือกวันที่ pin ตามลำดับ docs/04 G1: header → key → วันสร้างบริษัท → ล่าสุด (คำขอที่ไม่มีบริษัท เช่น public/platform)
 * header ผิดรูปแบบ/ก่อนเวอร์ชันแรก/อนาคต → error (ผู้เรียกตอบ 400 invalid_api_version)
 */
export function resolveApiVersion(
  input: {
    header?: string | null;
    keyPin?: ApiVersion | null;
    tenantCreatedAt?: Date | null;
  },
  now = new Date(),
): { ok: true; version: ApiVersion; source: VersionSource } | { ok: false; reason: VersionError } {
  if (input.header !== undefined && input.header !== null) {
    const p = parseApiVersion(input.header, now);
    return p.ok ? { ok: true, version: p.version, source: 'header' } : p;
  }
  if (input.keyPin) return { ok: true, version: input.keyPin, source: 'api_key' };
  if (input.tenantCreatedAt)
    return { ok: true, version: versionFromDate(input.tenantCreatedAt), source: 'tenant' };
  return { ok: true, version: LATEST_API_VERSION, source: 'latest' };
}

/** เวอร์ชันที่ออกแล้วล่าสุดที่ ≤ วันที่ pin */
export function effectiveRelease(pinned: ApiVersion): ApiRelease {
  let r = API_RELEASES[0]!;
  for (const x of API_RELEASES) if (x.version <= pinned) r = x;
  return r;
}

/** การเปลี่ยนของ route นี้ที่คำขอ (pin วันที่ `pinned`) ยังไม่ได้รับ — เรียงจากใหม่ไปเก่า (ลำดับการ downgrade) */
export function pendingChanges(ids: readonly string[], pinned: ApiVersion): VersionChange[] {
  return ids
    .map((id) => CHANGES_BY_ID.get(id))
    .filter((c): c is VersionChange => !!c && pinned < c.version)
    .sort((a, b) => (a.version < b.version ? 1 : a.version > b.version ? -1 : 0));
}

// ---------- Deprecation / Sunset (RFC 9745 / RFC 8594) ----------

export interface DeprecationInfo {
  /** วันที่ประกาศเลิกใช้ (YYYY-MM-DD) */
  deprecatedAt: ApiVersion;
  /** วันที่หยุดรองรับ (YYYY-MM-DD) — docs/04 G1: ≥ 12 เดือนหลังประกาศ */
  sunset?: ApiVersion;
  /** หน้าเอกสาร/changelog ที่อธิบายทางย้าย */
  link?: string;
}

const utc = (v: ApiVersion) => new Date(`${v}T00:00:00Z`);

/** header ที่ต้องส่งเมื่อ route/เวอร์ชันถูกประกาศเลิกใช้ */
export function deprecationHeaders(info: DeprecationInfo): Record<string, string> {
  const h: Record<string, string> = {
    // RFC 9745: Structured Field Date `@<epoch seconds>`
    Deprecation: `@${Math.floor(utc(info.deprecatedAt).getTime() / 1000)}`,
  };
  // RFC 8594: HTTP-date (IMF-fixdate)
  if (info.sunset) h.Sunset = utc(info.sunset).toUTCString();
  if (info.link) h.Link = `<${info.link}>; rel="deprecation"; type="text/html"`;
  return h;
}

/** ตรวจว่าระยะประกาศ ≥ 12 เดือน (docs/04 G1) — ใช้ใน test ของ registry/decorator */
export function noticeAtLeast12Months(info: DeprecationInfo): boolean {
  if (!info.sunset) return true;
  const a = utc(info.deprecatedAt);
  const min = new Date(Date.UTC(a.getUTCFullYear() + 1, a.getUTCMonth(), a.getUTCDate()));
  return utc(info.sunset) >= min;
}
