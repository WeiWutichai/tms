import { Prisma } from '@prisma/client';

/**
 * หน่วยของบรรทัดรายได้บนเอกสาร (ST5-T07 review M3) — ค่าขนส่งตามสูตรปริมาณ (rate card PER_TON / PER_CBM / PER_UNIT) ใช้หน่วยของสูตร
 * (ตัน / ลบ.ม. / หน่วยนับของ rate card — ตรงกับ order-billing `unitLabel`) · อื่น ๆ = หน่วยของรายการบริการ (snapshot → ปัจจุบัน)
 * ใช้กับ alias: `l` = revenue_line · ต้อง LEFT JOIN ตาม `LINE_UNIT_JOINS`
 */
export const LINE_UNIT_JOINS = Prisma.sql`
  LEFT JOIN sales_order_charge uc ON l.source_type = 'SO_CHARGE' AND uc.id = l.source_id
  LEFT JOIN rate_card urc ON urc.id = uc.rate_card_id
  LEFT JOIN unit uru ON uru.id = urc.unit_id
  LEFT JOIN service_item usi ON usi.id = l.service_item_id`;

export const LINE_UNIT_EXPR = Prisma.sql`coalesce(
  CASE urc.pricing_model::text
    WHEN 'PER_TON' THEN (SELECT x.name_th FROM unit x WHERE upper(x.code) = 'TON' AND x.deleted_at IS NULL LIMIT 1)
    WHEN 'PER_CBM' THEN (SELECT x.name_th FROM unit x WHERE upper(x.code) = 'CBM' AND x.deleted_at IS NULL LIMIT 1)
    WHEN 'PER_UNIT' THEN uru.name_th
  END,
  l.service_item_snapshot->>'unitLabel',
  usi.unit_label)`;
