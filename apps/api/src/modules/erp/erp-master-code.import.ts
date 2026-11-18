import type { ErpMasterCodeKind } from '@tms/domain';
import { tryDecodeId } from '../../common/ids';
import type { ImportContext, ImportSpec, RowIssue, RowResult } from '../imports/import-spec';

/** ชนิดรหัส ↔ ป้ายในไฟล์ (ตัวแรก = ค่าใน template) */
const KINDS: Record<ErpMasterCodeKind, string[]> = {
  UNIT: ['หน่วย', 'UNIT'],
  SALESPERSON: ['พนักงานขาย', 'SALESPERSON'],
  ACCOUNT: ['ผังบัญชี', 'บัญชี', 'ACCOUNT'],
  ITEM: ['รหัสสินค้า/บริการ', 'สินค้า/บริการ', 'สินค้า', 'ITEM'],
  VAT_RATE: ['อัตรา VAT', 'VAT', 'VAT_RATE'],
};
const CODE_RE = /^[^\s\p{Cc}](?:[^\p{Cc}]{0,62}[^\s\p{Cc}])?$/u;
const RATE_RE = /^\d{1,3}(\.\d{1,2})?$/;

export interface ErpMasterCodeImportRow {
  connectorId: string;
  kind: ErpMasterCodeKind;
  code: string;
  name: string | null;
  rate: string | null;
  active: boolean;
}

function kindOf(v: string): ErpMasterCodeKind | null {
  const s = v.trim().toLowerCase();
  for (const [k, labels] of Object.entries(KINDS))
    if (labels.some((l) => l.toLowerCase() === s)) return k as ErpMasterCodeKind;
  return null;
}

/**
 * ผังรหัส ERP จากไฟล์ (ST7-T18; docs/01 §7.4 "กรอก/import CSV") — สำหรับ connector ที่ดึงผังรหัสเองไม่ได้
 * คอลัมน์ connector = รหัส connector (`con_…`) หรือ adapterKey (ถ้ามีตัวเดียวที่ยังไม่ยกเลิก) · รหัสเดิม (ไม่สนตัวพิมพ์) = แก้ชื่อ/อัตรา/สถานะ
 * ไม่ปิดรหัสที่ไม่อยู่ในไฟล์ (ปิดเองด้วยคอลัมน์ "ใช้งาน" = ไม่) · อัตรา VAT เป็นข้อมูลอ้างอิงของ ERP ไม่เปลี่ยนการคำนวณภาษีของ TMS
 * scope `settings:write` + แพ็กเกจมี `conn` (เท่ากับสิทธิ์จัดการ connector)
 */
export function erpMasterCodeImportSpec(): ImportSpec<ErpMasterCodeImportRow> {
  return {
    kind: 'erp_master_code',
    label: 'ผังรหัสระบบบัญชี',
    scope: 'settings:write',
    feature: 'conn',
    modes: ['upsert_by_code'],
    defaultMode: 'upsert_by_code',
    columns: [
      {
        key: 'connector',
        header: 'ระบบบัญชี',
        aliases: ['Connector', 'connector'],
        required: true,
        example: 'con_…',
        hint: 'รหัส connector หรือชื่อ adapter (เช่น demo) ถ้าเชื่อมไว้ตัวเดียว',
      },
      {
        key: 'kind',
        header: 'ชนิดรหัส',
        aliases: ['Kind', 'ชนิด'],
        required: true,
        example: KINDS.ITEM[0],
        options: Object.values(KINDS).map((l) => l[0]!),
      },
      {
        key: 'code',
        header: 'รหัส',
        aliases: ['Code'],
        required: true,
        example: 'SV-FRT-01',
        hint: 'ตามที่ระบบบัญชีใช้ 1–64 ตัว',
      },
      { key: 'name', header: 'ชื่อ', aliases: ['Name'], example: 'ค่าขนส่ง' },
      {
        key: 'rate',
        header: 'อัตรา (%)',
        aliases: ['Rate'],
        requiredWhen: 'ไม่บังคับ ใช้กับชนิด "อัตรา VAT" เท่านั้น',
        hint: 'เฉพาะอัตรา VAT เช่น 7 หรือ 7.00 (ข้อมูลอ้างอิง ไม่เปลี่ยนการคำนวณภาษี)',
      },
      {
        key: 'active',
        header: 'ใช้งาน',
        aliases: ['Active'],
        example: 'ใช่',
        options: ['ใช่', 'ไม่'],
        hint: 'ว่าง = ใช่',
      },
    ],
    async validate(ctx: ImportContext, rows) {
      const connectors = await ctx.tx.connector.findMany({
        where: { status: { not: 'DISCONNECTED' } },
        select: { id: true, adapterKey: true },
      });
      const resolve = (v: string): string | RowIssue => {
        const byId = tryDecodeId('connector', v);
        if (byId) {
          const c = connectors.find((x) => x.id === byId);
          return c
            ? c.id
            : {
                column: 'connector',
                code: 'reference_not_found',
                message: 'ไม่พบ connector นี้ (หรือยกเลิกการเชื่อมแล้ว)',
              };
        }
        const same = connectors.filter((x) => x.adapterKey === v.trim().toLowerCase());
        if (same.length === 1) return same[0]!.id;
        return same.length
          ? {
              column: 'connector',
              code: 'ambiguous_reference',
              message: 'มี connector ชนิดนี้หลายตัว — ระบุรหัส connector (con_…)',
            }
          : { column: 'connector', code: 'reference_not_found', message: 'ไม่พบ connector นี้' };
      };
      const seen = new Map<string, number>();
      return rows.map((r): RowResult<ErpMasterCodeImportRow> => {
        const issues: RowIssue[] = [];
        const con = resolve(r.values.connector ?? '');
        if (typeof con !== 'string') issues.push(con);
        const kind = kindOf(r.values.kind ?? '');
        if (!kind)
          issues.push({
            column: 'kind',
            code: 'invalid_option',
            message: `ชนิดรหัสต้องเป็น ${Object.values(KINDS)
              .map((l) => l[0])
              .join(' / ')}`,
          });
        const code = (r.values.code ?? '').trim();
        if (!CODE_RE.test(code))
          issues.push({
            column: 'code',
            code: 'invalid_format',
            message: 'รหัสยาว 1–64 ตัว ไม่มีอักขระควบคุม',
          });
        const name = (r.values.name ?? '').trim();
        if (name.length > 200)
          issues.push({ column: 'name', code: 'too_long', message: 'ชื่อยาวเกิน 200 ตัว' });
        let rate: string | null = null;
        const rv = (r.values.rate ?? '').trim().replace(/%$/, '');
        if (rv) {
          if (kind && kind !== 'VAT_RATE')
            issues.push({
              column: 'rate',
              code: 'not_applicable',
              message: 'อัตราใช้กับชนิด "อัตรา VAT" เท่านั้น',
            });
          else if (!RATE_RE.test(rv) || Number(rv) > 100)
            issues.push({
              column: 'rate',
              code: 'invalid_format',
              message: 'อัตราเป็นตัวเลข 0–100 ทศนิยมไม่เกิน 2 ตำแหน่ง',
            });
          else rate = Number(rv).toFixed(2);
        }
        const av = (r.values.active ?? '').trim();
        let active = true;
        if (av === 'ไม่' || av.toLowerCase() === 'no' || av.toLowerCase() === 'false')
          active = false;
        else if (av && !['ใช่', 'yes', 'true'].includes(av.toLowerCase()))
          issues.push({
            column: 'active',
            code: 'invalid_option',
            message: 'ใช้งานต้องเป็น ใช่ / ไม่',
          });
        if (typeof con === 'string' && kind && code) {
          const key = `${con}|${kind}|${code.toLowerCase()}`;
          const first = seen.get(key);
          if (first)
            issues.push({
              column: 'code',
              code: 'duplicate_in_file',
              message: `รหัสซ้ำกับแถว ${first}`,
            });
          else seen.set(key, r.row);
        }
        if (issues.length) return { issues };
        return {
          issues,
          value: {
            connectorId: con as string,
            kind: kind!,
            code,
            name: name || null,
            rate,
            active,
          },
        };
      });
    },
    async commit(ctx, rows) {
      const groups = new Map<string, ErpMasterCodeImportRow[]>();
      for (const { value } of rows) {
        const k = `${value.connectorId}|${value.kind}`;
        groups.set(k, [...(groups.get(k) ?? []), value]);
      }
      const at = new Date();
      let n = 0;
      for (const list of groups.values()) {
        const { connectorId, kind } = list[0]!;
        const existing = await ctx.tx.erpMasterCode.findMany({ where: { connectorId, kind } });
        const byCode = new Map(existing.map((e) => [e.code.toLowerCase(), e]));
        for (const v of list) {
          const cur = byCode.get(v.code.toLowerCase());
          const data = {
            code: v.code,
            name: v.name,
            rate: v.rate,
            active: v.active,
            source: 'IMPORT',
            syncedAt: at,
          };
          if (cur) await ctx.tx.erpMasterCode.update({ where: { id: cur.id }, data });
          else
            await ctx.tx.erpMasterCode.create({
              data: { ...data, tenantId: ctx.tenantId, connectorId, kind },
            });
          n++;
        }
      }
      return n;
    },
  };
}
