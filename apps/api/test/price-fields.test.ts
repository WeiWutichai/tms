import { Controller, Get, Module, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { createApp } from '../src/bootstrap';
import { RequireScope } from '../src/common/decorators';
import { PriceField } from '../src/common/price-fields';
import { api, createTenant, platform, tokenFor, truncateAll } from './helpers';

class PricedTripDto {
  id!: string;
  @PriceField('sell') sellAmount!: string;
  @PriceField('buy') buyAmount!: string;
}
void PricedTripDto;

/** controller ชั่วคราวเฉพาะ test — endpoint จริงที่มีราคามาใน ST2+ (rate card, SO, settlement) */
@Controller('__test/priced')
class PricedController {
  @Get()
  @RequireScope('trips:read')
  get() {
    return { data: [{ id: 'trp_1', sellAmount: '1000.00', buyAmount: '800.00' }] };
  }
  @Post()
  @RequireScope('trips:read')
  create() {
    return { id: 'trp_2', sellAmount: '500.00', buyAmount: '400.00' };
  }
}
@Module({ imports: [AppModule], controllers: [PricedController] })
class TestModule {}

/** ST1-T13: Dispatcher (ค่าเริ่มต้น) เรียก API แล้ว response ไม่มี field ราคาขาย — ตัดที่ serializer */
describe('price field permission ผ่าน API จริง', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  const as = (role: keyof typeof SYSTEM_ROLES) =>
    tokenFor(tenantId, SYSTEM_ROLES[role].permissions.join(' '));

  beforeAll(async () => {
    await truncateAll();
    app = await createApp(TestModule);
    tenantId = (await createTenant(db)).id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('Dispatcher ไม่เห็นราคาขาย เห็นราคาซื้อ; Invoicer เห็นทั้งคู่', async () => {
    const d = await api(app, await as('dispatcher'))
      .get('/v1/__test/priced')
      .expect(200);
    expect(d.body.data[0]).toEqual({ id: 'trp_1', buyAmount: '800.00' });
    const i = await api(app, await as('invoicer'))
      .get('/v1/__test/priced')
      .expect(200);
    expect(i.body.data[0]).toEqual({ id: 'trp_1', sellAmount: '1000.00', buyAmount: '800.00' });
  });

  it('replay ด้วย Idempotency-Key เดียวกันถูกตัดตามผู้เรียกซ้ำ (ไม่ใช่ตามคนแรก)', async () => {
    const key = `price-${Date.now()}`;
    const first = await api(app, await as('owner'))
      .post('/v1/__test/priced')
      .set('Idempotency-Key', key)
      .send({});
    expect(first.body.sellAmount).toBe('500.00');
    const again = await api(app, await as('dispatcher'))
      .post('/v1/__test/priced')
      .set('Idempotency-Key', key)
      .send({});
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual({ id: 'trp_2', buyAmount: '400.00' });
  });
  it('เขียนราคาขายโดยไม่มี prices.sell:write → 403 (Dispatcher); Invoicer ส่งได้', async () => {
    const d = await api(app, await as('dispatcher'))
      .post('/v1/__test/priced')
      .send({ lines: [{ sellAmount: '9.00' }] });
    expect(d.status).toBe(403);
    expect(d.body).toMatchObject({
      code: 'permission_denied',
      module: 'prices.sell',
      action: 'write',
    });
    await api(app, await as('invoicer'))
      .post('/v1/__test/priced')
      .send({ sellAmount: '9.00' })
      .expect(201);
  });
});
