import { Injectable } from '@nestjs/common';
import { Prisma, type OrderTemplate } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { iEquals } from '../../common/ilike';
import { keysetArgs, toPage } from '../../common/pagination';
import { ProblemException, type FieldError } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { likeEscape, lockKey } from '../master/master-kit';
import { normalizeOrderInput, type NormalizedOrder } from './order-input';
import type {
  CreateOrderTemplateDto,
  OrderTemplateDto,
  OrderTemplateListQuery,
  OrderTemplatePayloadDto,
  UpdateOrderTemplateDto,
} from './order-template.dto';
import { toInput } from './orders.service';

type Tx = Prisma.TransactionClient;

/** จำนวนเทมเพลตที่ใช้งานได้สูงสุดต่อบริษัท — กันข้อมูลบวม (ไม่ใช่ข้อกำหนดธุรกิจ) */
export const TEMPLATE_LIMIT = 500;

/**
 * payload → รูปกลาง (กฎชุดเดียวกับใบสั่ง `normalizeOrderInput` — ที่มา MANUAL) แล้วแปลงกลับเป็น public id
 * เก็บรูปที่ล้างแล้ว (ข้อความไม่มีอักขระควบคุม, ทศนิยมรูปมาตรฐาน, เวลา UTC) · ผิด → 422 รวมทุกช่อง (path `payload.…`)
 */
export function canonicalPayload(p: OrderTemplatePayloadDto): OrderTemplatePayloadDto {
  let n: NormalizedOrder;
  try {
    n = normalizeOrderInput({ ...toInput(p), source: 'MANUAL' });
  } catch (e) {
    if (e instanceof ProblemException && e.code === 'validation_failed')
      throw new ProblemException(
        'validation_failed',
        undefined,
        (e.errors ?? []).map((x: FieldError) => ({ ...x, field: `payload.${x.field}` })),
      );
    throw e;
  }
  const pub = (kind: Parameters<typeof encodeId>[0], v: string | null) =>
    v ? encodeId(kind, v) : null;
  return {
    customer: {
      id: pub('customer', n.customer.id),
      externalId: n.customer.externalId,
      name: n.customer.text,
    },
    billingCompanyId: pub('company', n.billingCompanyId),
    // เทมเพลตไม่เก็บเลข PO (เปลี่ยนทุกครั้ง — spec/12 §3) ส่งมาก็ตัดทิ้ง
    customerRef: null,
    requestedDate: n.requestedDate,
    vehicleTypeId: pub('vehicleType', n.vehicleTypeId),
    stops: n.stops.map((s) => ({
      type: s.type,
      siteId: pub('site', s.siteId),
      siteText: s.siteText || null,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
    })),
    lines: n.lines.map((l) => ({
      description: l.description,
      qty: l.qty,
      unitId: pub('unit', l.unitId),
      unit: l.unit,
      productId: pub('product', l.productId),
      itemCode: l.itemCode,
      weightKg: l.weightKg,
      cbm: l.cbm,
      isDangerous: l.isDangerous,
      tempMin: l.tempMin,
      tempMax: l.tempMax,
    })),
  };
}

/**
 * เทมเพลตงานประจำ (ST3-T02) — บันทึก/แก้/ลบ(soft) ข้อมูลฟอร์มใบสั่งขนส่ง เพื่อสร้างใบใหม่ซ้ำได้
 * ไม่สร้างใบสั่งเอง: ผู้ใช้/ระบบนำ payload ไปเรียก `POST /v1/orders` (ทางเข้าเดียว `upsertOrder`)
 * อ้างอิง (ลูกค้า/สถานที่/ประเภทรถ/หน่วย) ไม่ตรวจว่ายังใช้งานอยู่ — ตรวจตอนสร้างใบ (ข้อมูลหลักเปลี่ยนได้ระหว่างนั้น)
 */
@Injectable()
export class OrderTemplatesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async get(id: string): Promise<OrderTemplate> {
    const t = await this.db.tx.orderTemplate.findFirst({ where: { id, deletedAt: null } });
    if (!t) throw new ProblemException('not_found');
    return t;
  }

  async list(q: OrderTemplateListQuery) {
    const k = keysetArgs(q);
    const rows = await this.db.tx.orderTemplate.findMany({
      where: {
        AND: [
          { deletedAt: null },
          q.q ? { name: { contains: likeEscape(q.q), mode: 'insensitive' } } : {},
          k.where as Prisma.OrderTemplateWhereInput,
        ],
      },
      orderBy: k.orderBy as unknown as Prisma.OrderTemplateOrderByWithRelationInput[],
      take: k.take,
    });
    const customers = await this.customersOf(rows);
    return toPage(rows, k, (r) => toTemplateDto(r, customers), q.fields);
  }

  async create(body: CreateOrderTemplateDto): Promise<OrderTemplate> {
    const tx = this.db.tx;
    const payload = canonicalPayload(body.payload);
    await this.assertRefs(tx, payload);
    const ctx = requestContext.require();
    await lockKey(tx, 'order_template.name');
    await this.assertNameFree(tx, body.name);
    if ((await tx.orderTemplate.count({ where: { deletedAt: null } })) >= TEMPLATE_LIMIT)
      throw new ProblemException('conflict', `at most ${TEMPLATE_LIMIT} templates`);
    const t = await tx.orderTemplate.create({
      data: {
        tenantId: ctx.tenantId!,
        name: body.name,
        payload: payload as unknown as Prisma.InputJsonValue,
        createdBy: actorUuid(),
        updatedBy: actorUuid(),
      },
    });
    await this.audit.record({
      action: 'order_template.created',
      entityType: 'order_template',
      entityId: t.id,
      after: { name: t.name, payload },
    });
    return t;
  }

  async update(id: string, body: UpdateOrderTemplateDto, expected?: number) {
    const tx = this.db.tx;
    const cur = await this.get(id);
    if (expected !== undefined && expected !== cur.version)
      throw new ProblemException('precondition_failed');
    const payload = body.payload !== undefined ? canonicalPayload(body.payload) : undefined;
    if (payload) await this.assertRefs(tx, payload);
    if (body.name !== undefined && body.name.toLowerCase() !== cur.name.toLowerCase()) {
      await lockKey(tx, 'order_template.name');
      await this.assertNameFree(tx, body.name, id);
    }
    const r = await tx.orderTemplate.updateMany({
      where: { id, version: cur.version, deletedAt: null },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(payload !== undefined ? { payload: payload as unknown as Prisma.InputJsonValue } : {}),
        updatedBy: actorUuid(),
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    const t = (await tx.orderTemplate.findUnique({ where: { id } }))!;
    await this.audit.record({
      action: 'order_template.updated',
      entityType: 'order_template',
      entityId: id,
      before: { name: cur.name, payload: cur.payload },
      after: { name: t.name, payload: t.payload },
    });
    return t;
  }

  /** ลบ = soft delete พร้อมเหตุผล (≥ 10 ตัวอักษร) + audit — ใบสั่งที่สร้างจากเทมเพลตแล้วไม่กระทบ */
  async remove(id: string, reason: string, expected?: number): Promise<void> {
    const tx = this.db.tx;
    const cur = await this.get(id);
    if (expected !== undefined && expected !== cur.version)
      throw new ProblemException('precondition_failed');
    const r = await tx.orderTemplate.updateMany({
      where: { id, version: cur.version, deletedAt: null },
      data: {
        deletedAt: new Date(),
        deletedReason: reason,
        updatedBy: actorUuid(),
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    await this.audit.record({
      action: 'order_template.deleted',
      entityType: 'order_template',
      entityId: id,
      before: { name: cur.name },
      reason,
    });
  }

  async customersOf(rows: OrderTemplate[]) {
    const ids = [
      ...new Set(
        rows
          .map((r) => templateCustomerUuid(r.payload))
          .filter((x): x is string => typeof x === 'string'),
      ),
    ];
    if (!ids.length) return new Map<string, { code: string; legalName: string }>();
    const cs = await this.db.tx.customer.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, code: true, legalName: true },
    });
    return new Map(cs.map((c) => [c.id, { code: c.code, legalName: c.legalName }]));
  }

  /**
   * อ้างอิงใน payload ต้องมีอยู่ในบริษัทนี้ (RLS — id ของบริษัทอื่นมองไม่เห็น) → ไม่พบ = 422 `reference_not_found` ที่ช่องนั้น
   * ไม่ตรวจสถานะใช้งาน (ข้อมูลหลักปิดใช้ได้ระหว่างนั้น — ตรวจซ้ำตอนสร้างใบ)
   */
  private async assertRefs(tx: Tx, p: OrderTemplatePayloadDto) {
    const errors: FieldError[] = [];
    const check = async (
      kind: Parameters<typeof tryDecodeId>[0],
      field: string,
      v: string | null | undefined,
      count: (id: string) => Promise<number>,
    ) => {
      if (!v) return;
      const id = tryDecodeId(kind, v);
      if (!id || (await count(id)) === 0)
        errors.push({ field, code: 'reference_not_found', message: `${kind} not found` });
    };
    await check('customer', 'payload.customer.id', p.customer?.id, (id) =>
      tx.customer.count({ where: { id, deletedAt: null } }),
    );
    await check('company', 'payload.billingCompanyId', p.billingCompanyId, (id) =>
      tx.company.count({ where: { id } }),
    );
    await check('vehicleType', 'payload.vehicleTypeId', p.vehicleTypeId, (id) =>
      tx.vehicleType.count({ where: { id, deletedAt: null } }),
    );
    for (const [i, st] of p.stops.entries())
      await check('site', `payload.stops[${i}].siteId`, st.siteId, (id) =>
        tx.customerSite.count({ where: { id, deletedAt: null } }),
      );
    for (const [i, l] of (p.lines ?? []).entries()) {
      await check('unit', `payload.lines[${i}].unitId`, l.unitId, (id) =>
        tx.unit.count({ where: { id, deletedAt: null } }),
      );
      await check('product', `payload.lines[${i}].productId`, l.productId, (id) =>
        tx.product.count({ where: { id, deletedAt: null } }),
      );
    }
    if (errors.length) throw new ProblemException('validation_failed', undefined, errors);
  }

  private async assertNameFree(tx: Tx, name: string, exceptId?: string) {
    const dup = await tx.orderTemplate.findFirst({
      where: {
        deletedAt: null,
        name: iEquals(name),
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (dup)
      throw new ProblemException('duplicate', undefined, [
        { field: 'name', code: 'duplicate', message: 'template name already exists' },
      ]);
  }
}

function actorUuid(): string | null {
  const a = requestContext.get()?.actorId;
  return a && /^[0-9a-f-]{36}$/i.test(a) ? a : null;
}

/** uuid ของลูกค้าใน payload (public id `cus_…`) */
function templateCustomerUuid(payload: Prisma.JsonValue): string | null {
  const id = (payload as { customer?: { id?: unknown } } | null)?.customer?.id;
  return typeof id === 'string' ? tryDecodeId('customer', id) : null;
}

export function toTemplateDto(
  t: OrderTemplate,
  customers: Map<string, { code: string; legalName: string }>,
): OrderTemplateDto {
  const cu = templateCustomerUuid(t.payload);
  const c = cu ? customers.get(cu) : undefined;
  return {
    id: encodeId('orderTemplate', t.id),
    name: t.name,
    payload: t.payload as unknown as OrderTemplatePayloadDto,
    customer:
      c && cu ? { id: encodeId('customer', cu), code: c.code, legalName: c.legalName } : null,
    version: t.version,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
