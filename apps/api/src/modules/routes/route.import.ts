import { iEquals } from '../../common/ilike';
import { byCode, defineMasterImport, put } from '../imports/master-import';
import { CreateRouteDto, UpdateRouteDto } from './route.dto';
import type { RoutesService } from './routes.service';

/** เส้นทาง OD (ST2-T09) — POST/PATCH /v1/routes · คู่ต้นทาง–ปลายทางซ้ำ → 409 จาก service (ในไฟล์เดียวกันก็ผิด) */
export function routeImportSpec(svc: RoutesService) {
  return defineMasterImport({
    kind: 'route',
    label: 'เส้นทาง',
    scope: 'master:write',
    modes: ['create_only', 'upsert_by_code', 'update_only'],
    createDto: CreateRouteDto,
    updateDto: UpdateRouteDto,
    identity: 'code',
    columns: [
      {
        key: 'code',
        header: 'รหัส',
        aliases: ['Code', 'รหัสเส้นทาง'],
        example: 'RT-0101',
        hint: 'ว่าง = ระบบออกเลขถัดไป',
      },
      {
        key: 'origin',
        header: 'ต้นทาง',
        aliases: ['Origin', 'From'],
        required: true,
        fields: ['originId'],
        example: 'LOC-0101',
        hint: 'รหัสหรือชื่อสถานที่ที่ตรงตัว',
      },
      {
        key: 'destination',
        header: 'ปลายทาง',
        aliases: ['Destination', 'To'],
        required: true,
        fields: ['destinationId'],
        example: 'LOC-0102',
      },
      {
        key: 'distanceKm',
        header: 'ระยะทาง (กม.)',
        aliases: ['Distance', 'ระยะทาง'],
        required: true,
        example: '85.5',
      },
      {
        key: 'standardMinutes',
        header: 'เวลามาตรฐาน (นาที)',
        aliases: ['Minutes', 'เวลามาตรฐาน'],
        example: '120',
      },
      {
        key: 'tollAmount',
        header: 'ค่าผ่านทาง (บาท)',
        aliases: ['Toll', 'ค่าทางด่วน'],
        example: '150',
      },
      { key: 'notes', header: 'หมายเหตุ', aliases: ['Notes'] },
      { key: 'externalId', header: 'รหัสในระบบอื่น', aliases: ['External ID', 'externalId'] },
    ],
    uniqueInFile: [{ column: 'code', label: 'รหัส', key: (v) => v.code?.toUpperCase() || null }],
    // คู่ต้นทาง–ปลายทางซ้ำในไฟล์ (หลังแปลงรหัส/ชื่อเป็นสถานที่เดียวกัน) — ในระบบตรวจโดย service
    inFile: (body, prior) => {
      const hit = prior.find(
        (p) => p.body.originId === body.originId && p.body.destinationId === body.destinationId,
      );
      return hit && body.originId
        ? {
            column: 'origin',
            code: 'duplicate_in_file',
            message: `คู่ต้นทาง–ปลายทางซ้ำกับแถว ${hit.row} ในไฟล์เดียวกัน`,
          }
        : null;
    },
    findExisting: byCode((tx, code) =>
      tx.route.findFirst({ where: { code: iEquals(code), deletedAt: null }, select: { id: true } }),
    ),
    async build(r, op) {
      const b: Record<string, unknown> = {};
      if (op === 'create') put(b, 'code', r.text('code') ?? undefined);
      put(b, 'originId', await r.ref('origin', 'site'));
      put(b, 'destinationId', await r.ref('destination', 'site'));
      put(b, 'distanceKm', r.num('distanceKm'));
      put(b, 'standardMinutes', r.int('standardMinutes'));
      put(b, 'tollAmount', r.decimal('tollAmount'));
      put(b, 'notes', r.text('notes'));
      put(b, 'externalId', r.text('externalId'));
      return b;
    },
    create: (dto) => svc.create(dto as CreateRouteDto),
    update: (id, dto) => svc.update(id, dto as UpdateRouteDto),
  });
}
