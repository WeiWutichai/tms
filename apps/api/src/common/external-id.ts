import { applyDecorators, Injectable, type PipeTransform } from '@nestjs/common';
import { ApiParam, type OpenAPIObject } from '@nestjs/swagger';
import { decodeIdOr404, type IdKind } from './ids';
import { PROBLEMS, ProblemException, type ProblemCode } from './problem';
import { ApiProblems } from './problem.dto';

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

/**
 * resource ที่ path `{id}` ทุก route รับ `ext:{externalId}` — ใช้เขียนคำอธิบาย `{id}` ใน OpenAPI (`describeExternalIdParams`)
 * conformance test ตรวจว่าตรงกับทะเบียน (REGISTRY ∪ EXT_ONLY)
 */
export const EXT_REF_RESOURCES = [
  'carriers',
  'companies',
  'customer-sites',
  'customers',
  'drivers',
  'orders',
  'products',
  'rate-cards',
  'reason-codes',
  'routes',
  'service-items',
  'vehicle-types',
  'vehicles',
] as const;

const ID_PARAM_DOC =
  'id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404)';

/** ใส่คำอธิบาย `{id}` (รับ `ext:`) และ `{externalId}` ใน OpenAPI ทีเดียวทุก route */
export function describeExternalIdParams(doc: OpenAPIObject): OpenAPIObject {
  for (const [path, item] of Object.entries(doc.paths)) {
    const m = /^\/v1\/([^/]+)\/\{id\}/.exec(path);
    const refs = m && (EXT_REF_RESOURCES as readonly string[]).includes(m[1]!);
    for (const op of Object.values(item) as { parameters?: unknown[] }[]) {
      if (!op || typeof op !== 'object' || !Array.isArray(op.parameters)) continue;
      for (const prm of op.parameters as { name?: string; in?: string; description?: string }[]) {
        if (prm.in !== 'path') continue;
        if (refs && prm.name === 'id') prm.description = ID_PARAM_DOC;
      }
    }
  }
  return doc;
}

const problem = (code: ProblemCode) => ({
  type: `https://docs.tms.example/problems/${code}`,
  title: PROBLEMS[code].th,
  status: PROBLEMS[code].status,
  code,
  requestId: 'b6a1…',
});
const EXT_422 = {
  status: 422,
  description:
    'ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId`',
  examples: {
    validation_failed: {
      ...problem('validation_failed'),
      errors: [
        {
          field: 'externalId',
          code: 'matches',
          message: 'externalId must be 1-100 printable ASCII',
        },
      ],
    },
  },
};
// 403: ตัวอย่าง `permission_denied` + `required` สร้างจาก scope ของ route (describeProblemDefaults — ST7-T11)
const EXT_404 = {
  status: 404,
  description: 'ยังไม่มีแถวที่ externalId นี้ (สร้างใหม่ใช้ PUT) หรืออยู่ tenant อื่น',
  examples: { not_found: problem('not_found') },
};
const EXT_409 = {
  status: 409,
  description: 'ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้)',
  examples: { conflict: problem('conflict'), duplicate: problem('duplicate') },
};
const EXT_412 = {
  status: 412,
  description: 'If-Match ไม่ตรงกับ version ปัจจุบัน',
  examples: { precondition_failed: problem('precondition_failed') },
};

/** `{externalId}` ใน path — pattern + คำอธิบาย */
export const ApiExternalIdParam = () =>
  ApiParam({
    name: 'externalId',
    description: EXTERNAL_ID_PARAM_DOC,
    schema: { type: 'string', pattern: '^[\\x21-\\x7e]{1,100}$', maxLength: 100 },
  });

/** เอกสารของ `PUT /{resource}/external/{externalId}` (master) */
export const ApiExternalPut = () =>
  applyDecorators(ApiExternalIdParam(), ApiProblems(EXT_409, EXT_412, EXT_422));

/** เอกสารของ `PATCH /{resource}/external/{externalId}` (master) */
export const ApiExternalPatch = () =>
  applyDecorators(ApiExternalIdParam(), ApiProblems(EXT_404, EXT_409, EXT_412, EXT_422));

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
