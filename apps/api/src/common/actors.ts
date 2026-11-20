import type { Tx } from '../db/db.service';

const KEY_PREFIX = 'apikey:';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ผู้ใช้ (คน) ที่อยู่เบื้องหลัง actor ใน audit/created_by (ST6-T07 review H1 — separation of duties)
 * - `apikey:<uuid>` (API key / OAuth client — ST7-T01) → `api_key.created_by` = ผู้ใช้ที่ออก key
 * - อื่น ๆ = id ผู้ใช้ตามเดิม
 * - ว่าง / key ไม่พบ / key ไม่มีผู้สร้าง → null (ผู้เรียกตัดสินเอง — งานคุมเงินต้อง fail closed)
 */
export async function resolveActors(
  tx: Tx,
  actors: readonly (string | null | undefined)[],
): Promise<(string | null)[]> {
  const keyIds = [
    ...new Set(
      actors
        .filter((a): a is string => !!a && a.startsWith(KEY_PREFIX))
        .map((a) => a.slice(KEY_PREFIX.length))
        .filter((id) => UUID_RE.test(id)),
    ),
  ];
  const keys = keyIds.length
    ? await tx.apiKey.findMany({
        where: { id: { in: keyIds } },
        select: { id: true, createdBy: true },
      })
    : [];
  const owner = new Map(keys.map((k) => [k.id, k.createdBy]));
  return actors.map((a) => {
    if (!a) return null;
    if (!a.startsWith(KEY_PREFIX)) return a;
    return owner.get(a.slice(KEY_PREFIX.length)) ?? null;
  });
}

/** a กับ b เป็นคนเดียวกันไหม (หลังแปลง key → ผู้ออก key) — null ฝั่งใดฝั่งหนึ่ง = ไม่ถือว่าเป็นคนเดียวกัน */
export async function sameHuman(
  tx: Tx,
  a: string | null | undefined,
  b: string | null | undefined,
): Promise<boolean> {
  const [x, y] = await resolveActors(tx, [a, b]);
  return x !== null && x === y;
}
