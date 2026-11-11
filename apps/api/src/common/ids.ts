import { ProblemException } from './problem';

/**
 * ID opaque prefix ใน API (docs/01 §5.1) — DB เก็บ uuid, API แสดง `<prefix>_<hex32>`
 * prefix ต้องลงทะเบียนที่นี่ที่เดียว (กันชนกัน)
 */
export const ID_PREFIX = {
  company: 'cmp',
  job: 'job',
  event: 'evt',
  tenant: 'ten',
  user: 'usr',
  role: 'rol',
  branch: 'brn',
  sequence: 'seq',
  audit: 'aud',
  document: 'doc',
  invitation: 'inv',
  notification: 'ntf',
  import: 'imp',
  customer: 'cus',
} as const;
export type IdKind = keyof typeof ID_PREFIX;

const HEX32 = /^[0-9a-f]{32}$/;

export function encodeId(kind: IdKind, uuid: string): string {
  return `${ID_PREFIX[kind]}_${uuid.replace(/-/g, '')}`;
}

/** คืน uuid หรือ null ถ้ารูปแบบผิด/prefix ไม่ตรง */
export function tryDecodeId(kind: IdKind, value: string): string | null {
  const prefix = `${ID_PREFIX[kind]}_`;
  if (!value.startsWith(prefix)) return null;
  const hex = value.slice(prefix.length).toLowerCase();
  if (!HEX32.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** id ที่ผิดรูปแบบตอบ 404 เหมือนไม่พบ — ไม่บอกใบ้ว่ามีอยู่หรือไม่ */
export function decodeIdOr404(kind: IdKind, value: string): string {
  const id = tryDecodeId(kind, value);
  if (!id) throw new ProblemException('not_found');
  return id;
}
