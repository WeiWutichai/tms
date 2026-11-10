import { Prisma } from '@prisma/client';
import { requestContext } from '../common/request-context';

/** model ที่มี field tenantId (คำนวณจาก DMMF ครั้งเดียว) */
const TENANT_MODELS = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === 'tenantId'))
    .map((m) => m.name),
);

const WRITE_DATA_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);
const WHERE_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
]);

/**
 * ชั้นแรกของการแยก tenant (ST0-T04): ใส่ tenantId ให้อัตโนมัติตอนสร้าง และเติม where.tenantId ตอนค้น
 * ชั้นที่สองคือ RLS ในฐานข้อมูล — ถึง query จะข้าม extension นี้ (raw SQL) ก็ยังโดน RLS กัน
 */
export const tenantExtension = Prisma.defineExtension({
  name: 'tenant-scope',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!model || !TENANT_MODELS.has(model)) return query(args);
        const tenantId = requestContext.get()?.tenantId;
        if (!tenantId) return query(args); // RLS จะคืน 0 แถว / ปฏิเสธการเขียน
        const a = (args ?? {}) as Record<string, any>;
        if (WRITE_DATA_OPS.has(operation)) {
          if (Array.isArray(a.data)) a.data = a.data.map((d: any) => ({ tenantId, ...d }));
          else a.data = { tenantId, ...a.data };
        } else if (operation === 'upsert') {
          a.create = { tenantId, ...a.create };
        } else if (WHERE_OPS.has(operation)) {
          a.where = { ...(a.where ?? {}), tenantId };
        }
        return query(a);
      },
    },
  },
});
