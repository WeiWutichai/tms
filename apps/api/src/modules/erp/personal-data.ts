import { BlindIndex } from '../../common/blind-index';
import { FieldCipher } from '../../common/crypto';
import type { Tx } from '../../db/db.service';
import type { CanonicalDocument, CanonicalPersonalField } from './erp-adapter';

/**
 * D-80 (PO 23 พ.ย. 2569 — D68-08) ข้อมูลส่วนบุคคลที่ core ใส่ลงเอกสาร **ณ ตอนส่ง** (ใน sink) ให้เฉพาะ adapter ที่ประกาศ
 * `personalDataNeeds` — ไม่ใส่ตอนสร้าง canonical/เข้าคิว → payload ที่เก็บใน `integration_outbox` ไม่มีค่าเต็มเลย
 * (แบบเดียวกับการใส่รหัสคู่ค้าฝั่ง ERP ณ ตอนส่งของ ST7-T15)
 *
 * ตอนนี้มีช่องเดียว: `carrier.taxId` = เลขบัตรประชาชนเต็มของรถร่วม**บุคคลธรรมดา**ในใบสำคัญจ่าย (docs/01 §7.3 เลขผู้เสียภาษีคู่ค้า)
 * — ระบบบัญชีที่ออก 50 ทวิ / ภ.ง.ด.3 ต้องใช้ (D-58) · นิติบุคคลส่งเลขอยู่แล้วตั้งแต่สร้าง canonical (ไม่ผ่านที่นี่)
 * อ่านจาก**ข้อมูลรถร่วมปัจจุบัน** (`carrier.tax_id_enc` — snapshot ของใบเก็บแค่เลขท้าย 4 หลัก; แบบเดียวกับ D-73)
 *
 * hash (ST7-T15 "hash ของเอกสารที่ส่งจริง"): คำนวณจากเอกสารที่ส่งจริง โดยช่องข้อมูลส่วนบุคคลแทนด้วย blind index (HMAC มีกุญแจ —
 * `BLIND_INDEX_KEY`) ของค่านั้น → เลขเปลี่ยน = hash เปลี่ยน (ส่งใหม่ได้) แต่ hash ที่เก็บใน `external_mapping.last_synced_hash` /
 * `result.sentHash` ย้อนหาเลขบัตร (มีแค่ ~10^12 แบบ) ด้วยการลองทุกค่าไม่ได้
 */
export interface PersonalDataInjection<T extends CanonicalDocument> {
  /** เอกสารที่ส่งให้ adapter (มีค่าเต็ม) — ห้ามเก็บลงฐาน */
  document: T;
  /** เอกสารเดียวกันแต่ช่องที่ใส่แทนด้วย blind index — ใช้คำนวณ `sync.hash` */
  forHash: T;
  /** ค่าเต็มที่ใส่ (sink ตัดออกจากข้อความ error/ผลของคำสั่งก่อนเก็บ) */
  secrets: string[];
  /** ช่องที่ใส่ค่าจริง (ลง audit — ไม่มีตัวเลข) */
  fields: CanonicalPersonalField[];
}

let cipher: FieldCipher | undefined;
let blind: BlindIndex | undefined;

/** เลขบัตร 13 หลัก → รูปที่มักพิมพ์ในข้อความ (ตัวเลขล้วน + มีขีด 1-2345-67890-12-3) */
function forms(id: string): string[] {
  const d = id.replace(/\D/g, '');
  const out = new Set([id, d]);
  if (d.length === 13)
    out.add(`${d[0]}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d[12]}`);
  return [...out].filter((s) => s.length >= 4);
}

/**
 * ใส่ข้อมูลส่วนบุคคลที่ adapter ประกาศลงเอกสาร (ไม่แก้ `doc` เดิม) · ไม่ประกาศ / ไม่ใช่เอกสารที่มีช่องนั้น / ไม่มีค่า /
 * ถอดรหัสไม่ได้ (กุญแจเดิมถูกถอดแล้ว) = คืนเอกสารเดิม (ค่าว่างเหมือนก่อน D-80) · ไม่รู้จัก adapter ใด (ทั่วไป)
 */
export async function injectPersonalData<T extends CanonicalDocument>(
  tx: Tx,
  doc: T,
  needs: readonly CanonicalPersonalField[],
): Promise<PersonalDataInjection<T>> {
  const none: PersonalDataInjection<T> = { document: doc, forHash: doc, secrets: [], fields: [] };
  if (!needs.includes('carrier.taxId')) return none;
  const d = doc as CanonicalDocument & {
    kind?: unknown;
    carrier?: { id?: unknown; entityType?: unknown; taxId?: unknown };
  };
  const carrier = d.carrier;
  if (d.kind !== 'settlement' || !carrier || carrier.entityType !== 'INDIVIDUAL') return none;
  if (typeof carrier.id !== 'string') return none;
  const row = await tx.carrier.findFirst({
    where: { id: carrier.id, entityType: 'INDIVIDUAL' },
    select: { taxIdEnc: true },
  });
  if (!row?.taxIdEnc) return none;
  let plain: string;
  try {
    plain = (cipher ??= new FieldCipher()).decrypt(row.taxIdEnc);
  } catch {
    return none;
  }
  if (!plain) return none;
  const digest = (blind ??= new BlindIndex()).of(plain);
  return {
    document: { ...doc, carrier: { ...carrier, taxId: plain } },
    forHash: { ...doc, carrier: { ...carrier, taxId: digest } },
    secrets: forms(plain),
    fields: ['carrier.taxId'],
  };
}
