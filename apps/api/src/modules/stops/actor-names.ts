import type { Tx } from '../../db/db.service';

const UUID = /^[0-9a-f-]{36}$/i;
const LINK_ACTOR = /^link:([0-9a-f-]{36})$/i;

/**
 * ชื่อผู้ทำรายการจาก actor id (ผู้บันทึก event / หลักฐานส่ง / audit)
 * - uuid = ผู้ใช้ภายใน (`app_user.name`)
 * - `link:{magic_link.id}` ของลิงก์งาน/ข้อเสนอรถร่วม (ST4-T08/T09) = ชื่อรถร่วมของการจ้างที่ลิงก์ชี้
 * - อื่น ๆ (dev token / ระบบ) = ไม่มีชื่อ
 */
export async function actorNames(
  tx: Tx,
  ids: (string | null | undefined)[],
): Promise<Map<string, string>> {
  const uuids = [...new Set(ids.filter((x): x is string => !!x && UUID.test(x)))];
  const users = !uuids.length
    ? []
    : await tx.appUser.findMany({ where: { id: { in: uuids } }, select: { id: true, name: true } });
  const out = new Map(users.map((u) => [u.id, u.name]));
  const linkIds = [
    ...new Set(
      ids.flatMap((x) => {
        const m = x ? LINK_ACTOR.exec(x) : null;
        return m ? [m[1]!] : [];
      }),
    ),
  ];
  if (linkIds.length) {
    const links = await tx.magicLink.findMany({
      where: { id: { in: linkIds }, entityType: 'subcon_offer' },
      select: { id: true, entityId: true },
    });
    const offers = links.length
      ? await tx.subconOffer.findMany({
          where: { id: { in: links.map((l) => l.entityId) } },
          select: { id: true, carrierNameSnapshot: true },
        })
      : [];
    const nameOf = new Map(offers.map((o) => [o.id, o.carrierNameSnapshot]));
    for (const l of links) {
      const n = nameOf.get(l.entityId);
      if (n) out.set(`link:${l.id}`, n);
    }
  }
  return out;
}
