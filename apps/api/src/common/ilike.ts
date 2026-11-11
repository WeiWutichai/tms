/** escape `%` `_` `\` สำหรับ LIKE/ILIKE (Prisma `contains`/`equals` ไม่ escape ให้) */
export function likeEscape(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * เทียบ "เท่ากันทุกตัวอักษร ไม่สนตัวพิมพ์" ใน where ของ Prisma
 * Prisma แปล `{ equals, mode: 'insensitive' }` เป็น `ILIKE $1` โดยไม่ escape → `_`/`%` กลายเป็น wildcard
 * (`a_b@x.com` ตรงกับ `axb@x.com`, ชื่อ `6_ล้อ` ตรงกับ `6 ล้อ`) — ใช้ตัวนี้แทนเสมอ (test: test/ilike.test.ts)
 */
export function iEquals(v: string): { equals: string; mode: 'insensitive' } {
  return { equals: likeEscape(v), mode: 'insensitive' };
}
