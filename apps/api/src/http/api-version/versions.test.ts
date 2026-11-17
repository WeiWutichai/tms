import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_RELEASES,
  bangkokDate,
  deprecationHeaders,
  effectiveRelease,
  FIRST_API_VERSION,
  LATEST_API_VERSION,
  noticeAtLeast12Months,
  parseApiVersion,
  pendingChanges,
  resolveApiVersion,
  VERSION_CHANGES,
  versionChange,
} from './versions';

const NOW = new Date('2026-11-18T05:00:00Z'); // 12:00 น. เวลาไทย

describe('ST7-T07 versions: การแปลง/เลือกเวอร์ชัน', () => {
  it('registry: เรียงจากเก่าไปใหม่ · gate ทุกตัวชี้เวอร์ชันที่ออกแล้ว · id ไม่ซ้ำ', () => {
    const v = API_RELEASES.map((r) => r.version);
    expect([...v].sort()).toEqual(v);
    expect(new Set(v).size).toBe(v.length);
    for (const c of VERSION_CHANGES) {
      expect(v).toContain(c.version);
      expect(c.version > FIRST_API_VERSION).toBe(true);
    }
    expect(new Set(VERSION_CHANGES.map((c) => c.id)).size).toBe(VERSION_CHANGES.length);
    for (const r of API_RELEASES)
      if (r.deprecatedAt)
        expect(noticeAtLeast12Months({ ...r, deprecatedAt: r.deprecatedAt })).toBe(true);
  });

  it('client ที่ generate (packages/contracts) ส่งเวอร์ชันล่าสุดเสมอ', () => {
    const src = readFileSync(
      join(__dirname, '../../../../../packages/contracts/src/index.ts'),
      'utf8',
    );
    expect(src).toContain(`export const API_VERSION = '${LATEST_API_VERSION}';`);
  });

  it('parseApiVersion: รูปแบบ / วันที่มีจริง / ก่อนเวอร์ชันแรก / อนาคต', () => {
    expect(parseApiVersion('2026-11-01', NOW)).toEqual({ ok: true, version: '2026-11-01' });
    expect(parseApiVersion(' 2026-11-10 ', NOW)).toEqual({ ok: true, version: '2026-11-10' });
    for (const bad of [
      '',
      'latest',
      '2026-11',
      '20261110',
      '2026-1-10',
      '2026-11-10T00:00Z',
      '2026-02-30',
      '2026-13-01',
    ])
      expect(parseApiVersion(bad, NOW)).toEqual({ ok: false, reason: 'format' });
    expect(parseApiVersion('2026-10-31', NOW)).toEqual({ ok: false, reason: 'before_first' });
    expect(parseApiVersion('2026-11-19', NOW)).toEqual({ ok: false, reason: 'future' });
    // วันนี้ตามเวลาไทย (UTC 18 พ.ย. 18:00 = ไทย 19 พ.ย. 01:00) ไม่ใช่อนาคต
    expect(parseApiVersion('2026-11-19', new Date('2026-11-18T18:00:00Z')).ok).toBe(true);
  });

  it('ลำดับ: header → key → วันสร้างบริษัท (เวลาไทย) → ล่าสุด', () => {
    const created = new Date('2026-11-09T20:00:00Z'); // ไทย 10 พ.ย. 03:00
    expect(
      resolveApiVersion(
        { header: '2026-11-05', keyPin: '2026-11-07', tenantCreatedAt: created },
        NOW,
      ),
    ).toEqual({ ok: true, version: '2026-11-05', source: 'header' });
    expect(resolveApiVersion({ keyPin: '2026-11-07', tenantCreatedAt: created }, NOW)).toEqual({
      ok: true,
      version: '2026-11-07',
      source: 'api_key',
    });
    expect(resolveApiVersion({ tenantCreatedAt: created }, NOW)).toEqual({
      ok: true,
      version: '2026-11-10',
      source: 'tenant',
    });
    // บริษัทที่สร้างก่อนเวอร์ชันแรก → เวอร์ชันแรก
    expect(
      resolveApiVersion({ tenantCreatedAt: new Date('2025-01-01T00:00:00Z') }, NOW),
    ).toMatchObject({
      version: FIRST_API_VERSION,
    });
    expect(resolveApiVersion({}, NOW)).toEqual({
      ok: true,
      version: LATEST_API_VERSION,
      source: 'latest',
    });
    // header ผิดไม่ตกไปใช้ค่าอื่น
    expect(resolveApiVersion({ header: 'x', keyPin: '2026-11-07' }, NOW)).toEqual({
      ok: false,
      reason: 'format',
    });
    expect(bangkokDate(new Date('2026-11-17T17:00:00Z'))).toBe('2026-11-18');
  });

  it('effectiveRelease / pendingChanges', () => {
    expect(effectiveRelease('2026-11-10').version).toBe('2026-11-01');
    expect(effectiveRelease('2026-11-18').version).toBe('2026-11-18');
    expect(pendingChanges(['api_key.status_rotating'], '2026-11-17').map((c) => c.id)).toEqual([
      'api_key.status_rotating',
    ]);
    expect(pendingChanges(['api_key.status_rotating'], '2026-11-18')).toEqual([]);
    expect(pendingChanges(['ไม่มีจริง'], '2026-11-01')).toEqual([]);
  });

  it('gate ตัวอย่าง api_key.status_rotating: request + response ของ client เก่า', () => {
    const c = versionChange('api_key.status_rotating')!;
    const q: Record<string, unknown> = { status: 'active,revoked' };
    c.upgradeRequest!({ query: q });
    expect(q.status).toBe('active,revoked,rotating');
    const q2: Record<string, unknown> = { status: 'revoked' };
    c.upgradeRequest!({ query: q2 });
    expect(q2.status).toBe('revoked');
    const key = { status: 'rotating', prefix: 'tk_live_x', scopes: [] };
    expect(c.downgradeResponse!({ data: [key, { ...key, status: 'revoked' }] })).toEqual({
      data: [
        { ...key, status: 'active' },
        { ...key, status: 'revoked' },
      ],
    });
    expect(c.downgradeResponse!({ ...key })).toEqual({ ...key, status: 'active' });
    expect(
      c.downgradeResponse!({ all: 5, active: 2, expiring: 1, rotating: 1, expired: 0, revoked: 1 }),
    ).toEqual({ all: 5, active: 3, expiring: 1, expired: 0, revoked: 1 });
    expect(c.downgradeResponse!(undefined)).toBeUndefined();
  });

  it('Deprecation/Sunset/Link ตาม RFC 9745/8594 · ประกาศ ≥ 12 เดือน', () => {
    expect(
      deprecationHeaders({ deprecatedAt: '2026-11-18', sunset: '2027-11-18', link: 'https://d/x' }),
    ).toEqual({
      Deprecation: `@${Date.UTC(2026, 10, 18) / 1000}`,
      Sunset: 'Thu, 18 Nov 2027 00:00:00 GMT',
      Link: '<https://d/x>; rel="deprecation"; type="text/html"',
    });
    expect(deprecationHeaders({ deprecatedAt: '2026-11-18' })).toEqual({
      Deprecation: `@${Date.UTC(2026, 10, 18) / 1000}`,
    });
    expect(noticeAtLeast12Months({ deprecatedAt: '2026-11-18', sunset: '2027-11-17' })).toBe(false);
    expect(noticeAtLeast12Months({ deprecatedAt: '2026-11-18', sunset: '2027-11-18' })).toBe(true);
  });
});
