import { Injectable, type PipeTransform } from '@nestjs/common';
import { decodeIdOr404, type IdKind } from './ids';
import { ProblemException } from './problem';

/**
 * External id (ST7-T02; docs/04 G1 "External id", docs/01 §5.1 Idempotency) — กลไกกลางของทุก resource
 *
 * - `externalId` = เลขของระบบต้นทาง unique `(tenant_id, external_id)` ต่อ resource (unique index ในแต่ละตาราง)
 * - path `{id}` ทุก route ของ resource รับ `ext:{externalId}` แทน id ได้ (`resolveRef`)
 * - `PUT /{resource}/external/{externalId}` = upsert idempotent → 201 สร้าง / 200 อัปเดต (ส่งซ้ำค่าเดิมไม่เพิ่ม version)
 * - `PATCH /{resource}/external/{externalId}` = แก้บางช่องของแถวที่มีอยู่ (= `PATCH /{resource}/ext:{externalId}`) → 200 · ไม่มี → 404
 *
 * resource ใหม่ที่มีคอลัมน์ `externalId` ต้องลงทะเบียนใน `test/external-id-conformance.test.ts`
 * (test fail ถ้ามีตาราง/route external ที่ไม่อยู่ในทะเบียนหรือรายการยกเว้นพร้อมเหตุผล)
 */
export const EXTERNAL_ID_RE = /^[\x21-\x7e]{1,100}$/;
export const EXT_PREFIX = 'ext:';

export const EXTERNAL_ID_PARAM_DOC =
  'เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource';

/** ตรวจ `externalId` จาก path — ผิดรูปแบบ → 422 `validation_failed` (field `externalId`) */
export function parseExternalId(raw: string): string {
  if (!EXTERNAL_ID_RE.test(raw))
    throw new ProblemException('validation_failed', undefined, [
      { field: 'externalId', code: 'matches', message: 'externalId must be 1-100 printable ASCII' },
    ]);
  return raw;
}

/** `@Param('externalId', ExternalIdPipe)` */
@Injectable()
export class ExternalIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    return parseExternalId(value);
  }
}

/**
 * แปลง `{id}` ของ path → แถว: `ext:{externalId}` หาด้วย externalId, อื่น ๆ ถอด id แบบ opaque (ผิดรูปแบบ = 404)
 * ไม่พบ/อยู่ tenant อื่น → 404 จาก service (RLS)
 */
export function resolveRef<T>(
  kind: IdKind,
  ref: string,
  byId: (uuid: string) => Promise<T>,
  byExternalId: (externalId: string) => Promise<T>,
): Promise<T> {
  if (ref.startsWith(EXT_PREFIX)) {
    const ext = ref.slice(EXT_PREFIX.length);
    if (!EXTERNAL_ID_RE.test(ext)) throw new ProblemException('not_found');
    return byExternalId(ext);
  }
  return byId(decodeIdOr404(kind, ref));
}

/** ref สำหรับส่งต่อให้ handler ที่รับ `{id}` (PATCH external → PATCH :id) */
export const extRef = (externalId: string): string => `${EXT_PREFIX}${externalId}`;

/** delegate ของ Prisma ที่มี `externalId` + `deletedAt` (ตาราง master) */
interface ExtDelegate {
  findFirst(args: {
    where: { externalId: string; deletedAt: null };
    select: { id: true };
  }): Promise<{ id: string } | null>;
}

/**
 * `ext:{externalId}` → uuid สำหรับ route ของ module อื่นที่อ้าง resource ด้วย `{id}` (เช่น `/carriers/{id}/upload-links`)
 * ไม่พบ/ลบแล้ว/tenant อื่น (RLS) → 404
 */
export async function idByExternalId(delegate: ExtDelegate, externalId: string): Promise<string> {
  const row = await delegate.findFirst({
    where: { externalId, deletedAt: null },
    select: { id: true },
  });
  if (!row) throw new ProblemException('not_found');
  return row.id;
}

/** `{id}` หรือ `ext:{externalId}` → uuid (ไม่โหลดทั้งแถว) */
export function refToId(kind: IdKind, ref: string, delegate: ExtDelegate): Promise<string> {
  return resolveRef(
    kind,
    ref,
    async (u) => u,
    (e) => idByExternalId(delegate, e),
  );
}
