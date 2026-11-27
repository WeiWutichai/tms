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

  it('past_due ที่ทีมงานตั้งเอง (ไม่มีวัน 0) → readOnlyInDays null', async () => {
    const id = await tenant('PAST_DUE');
    const me = await api(app, await tokenFor(id))
      .get('/v1/me')
      .expect(200);
    expect(me.body.account).toMatchObject({ pastDueSince: null, readOnlyInDays: null });
  });

  it('billing-admins: ชื่ออย่างเดียว เฉพาะบริษัทตัวเอง · notify ส่งถึงผู้ดูแล (ไม่รวมผู้ขอ) กันซ้ำ 24 ชม. · token ไม่ใช่ผู้ใช้ → 403', async () => {
    const id = await tenant('ACTIVE');
    const other = await tenant('ACTIVE');
    const users: Record<string, string> = {};
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
        users[email] = u.id;
      };
      await mk(`owner-${tag}@banner.test`, 'owner');
      await mk(`gone-${tag}@banner.test`, 'owner', 'DISABLED');
      await mk(`viewer-${tag}@banner.test`, 'viewer');
    }
    const viewer = await tokenFor(id, 'orders:read', users['viewer-a@banner.test']);
    const r = await api(app, viewer).get('/v1/me/billing-admins').expect(200);
    expect(r.body.data).toEqual([{ name: 'owner-a' }]);
    // token ที่ไม่ใช่ผู้ใช้ของบริษัท (API client / คนขับ / ลิงก์) → 403
    await api(app, await tokenFor(id, '*', 'client-x'))
      .get('/v1/me/billing-admins')
      .expect(403);
    await api(app, await tokenFor(id, '*', 'client-x'))
      .post('/v1/me/billing-admins/notify')
      .expect(403);

    const n1 = await api(app, viewer).post('/v1/me/billing-admins/notify').expect(200);
    expect(n1.body).toEqual({ notified: 1, alreadyRequested: false });
    const sent = await db.notification.findMany({
      where: { tenantId: id, templateCode: 'billing.attention_requested' },
    });
    expect(new Set(sent.map((x) => x.recipientId))).toEqual(
      new Set([users['owner-a@banner.test']]),
    );
    expect(new Set(sent.map((x) => x.channel))).toContain('in_app');
    const n2 = await api(app, viewer).post('/v1/me/billing-admins/notify').expect(200);
    expect(n2.body).toEqual({ notified: 0, alreadyRequested: true });
  });
});
