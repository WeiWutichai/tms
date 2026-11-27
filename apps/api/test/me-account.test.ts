import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { Clock } from '../src/common/clock';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { TenantLifecycleService } from '../src/modules/tenants/tenant-lifecycle.service';
import { api, bootApp, platform, tokenFor, truncateAll } from './helpers';

/**
 * P1-ST1-T05 ข้อมูลแถบสถานะใน GET /v1/me (`account`) + GET /v1/me/billing-admins (spec/01 §5 PLT-050/051)
 * ลำดับการเลือกแถบอยู่ที่ UI (apps/web/src/shell/StatusBanner.test.tsx)
 */
describe('แถบสถานะบัญชี — /v1/me account (P1-ST1-T05)', () => {
  let app: NestExpressApplication;
  let clock: Clock;
  const db = platform();
  const bkk = (s: string) => new Date(`${s.replace(' ', 'T')}:00+07:00`);

  async function tenant(status: 'TRIALING' | 'PAST_DUE' | 'ACTIVE') {
    const t = await createTenantWithDefaults(db, {
      name: `บริษัท แถบสถานะ ${randomUUID().slice(0, 6)} จำกัด`,
      status,
    });
    return t.id;
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    clock = app.get(Clock);
  });
  afterAll(async () => {
    clock.set(null);
    await app.close();
  });

  it('trialing: เหลือกี่วันตามวันที่เวลาไทย ปัดลง (PLT-051) · canManageBilling ตามสิทธิ์', async () => {
    const id = await tenant('TRIALING');
    // หมด trial = 10 ธ.ค. 2569 00:00 ไทย · ตอนนี้ 28 พ.ย. 23:59 ไทย → เหลือ 12 วัน (ไม่ปัดขึ้น)
    await db.subscription.update({
      where: { tenantId: id },
      data: { trialEndsAt: bkk('2026-12-10 00:00'), cancelAtPeriodEnd: true },
    });
    clock.set(bkk('2026-11-28 23:59'));
    const me = await api(app, await tokenFor(id))
      .get('/v1/me')
      .expect(200);
    expect(me.body.account).toMatchObject({
      trialDaysLeft: 12,
      pastDueSince: null,
      readOnlyInDays: null,
      cancelAtPeriodEnd: true,
      vehicles: { active: 0 },
      accountingSoftware: null,
      canManageBilling: true,
    });
    const viewer = await api(app, await tokenFor(id, 'orders:read'))
      .get('/v1/me')
      .expect(200);
    expect(viewer.body.account.canManageBilling).toBe(false);
  });

  it('past_due วันที่ 3: เหลือ (dunning.pastDueDays + 1 − 3) วันก่อนเป็นอ่านอย่างเดียว', async () => {
    const id = await tenant('PAST_DUE');
    await db.tenant.update({
      where: { id },
      data: { pastDueSince: new Date('2026-11-25T00:00:00Z'), dunningKind: 'invoice' },
    });
    clock.set(bkk('2026-11-28 09:00'));
    const days = (await app.get(TenantLifecycleService).dunningSettings()).pastDueDays;
    const me = await api(app, await tokenFor(id))
      .get('/v1/me')
      .expect(200);
    expect(me.body.tenant.status).toBe('past_due');
    expect(me.body.account).toMatchObject({
      pastDueSince: '2026-11-25',
      readOnlyInDays: days + 1 - 3,
      trialDaysLeft: null,
    });
  });

  it('billing-admins: รายชื่อผู้ใช้ active ที่จัดการแพ็กเกจได้ของบริษัทตัวเองเท่านั้น', async () => {
    const id = await tenant('ACTIVE');
    const other = await tenant('ACTIVE');
    for (const [tid, tag] of [
      [id, 'a'],
      [other, 'b'],
    ] as const) {
      const roles = await ensureSystemRoles(db, tid);
      const mk = async (email: string, role: string, status: 'ACTIVE' | 'DISABLED' = 'ACTIVE') => {
        const u = await db.appUser.create({
          data: { tenantId: tid, email, name: email.split('@')[0]!, status },
        });
        await db.userRole.create({ data: { tenantId: tid, userId: u.id, roleId: roles[role]! } });
      };
      await mk(`owner-${tag}@banner.test`, 'owner');
      await mk(`gone-${tag}@banner.test`, 'owner', 'DISABLED');
      await mk(`driver-${tag}@banner.test`, 'dispatcher');
    }
    const r = await api(app, await tokenFor(id, 'orders:read'))
      .get('/v1/me/billing-admins')
      .expect(200);
    expect(r.body.data).toEqual([{ name: 'owner-a', email: 'owner-a@banner.test' }]);
  });
});
