import { render, screen } from '@testing-library/react';
import { API_VERSION, createTmsClient } from '@tms/contracts';
import { StatusDot, statusOf } from '@tms/ui';
import { describe, expect, it, vi } from 'vitest';
import { enumLabel, I18nProvider, type T } from './i18n';
import type { ApiKey } from './features/api-keys/useApiKeys';

vi.mock('./shell/AppShell', () => ({ useMe: () => ({ data: { tenant: { yearStyle: 'BE' } } }) }));
vi.mock('./features/master/HistoryTab', () => ({ HistoryTab: () => null }));
const { ApiKeyDrawer } = await import('./features/api-keys/ApiKeyDrawer');

/** API อนาคตเพิ่มค่า enum ใหม่ (ไม่ breaking ตาม docs/04 G1) — UI ต้องไม่พัง */
const futureKey = {
  id: 'key_x',
  name: 'ERP sync',
  mode: 'staging',
  prefix: 'tk_live_8f3a',
  scopes: ['orders:read'],
  ipAllowlist: [],
  status: 'suspended_by_platform',
  expiresAt: null,
  lastUsedAt: null,
  lastUsedIp: null,
  revokeAt: null,
  revokeReason: null,
  rotatedToId: null,
  rotatedFromId: null,
  createdBy: null,
  createdByName: null,
  creatorInactive: false,
  lastRejectedIp: null,
  lastRejectedAt: null,
  apiVersion: null,
  version: 1,
  createdAt: '2026-11-18T03:00:00.000Z',
  updatedAt: '2026-11-18T03:00:00.000Z',
  someNewField: { nested: true },
} as unknown as ApiKey;

describe('ST7-T07 versioning ฝั่ง client', () => {
  it('client ส่ง X-Api-Version ล่าสุดทุกคำขอ และส่งค่า enum/field ที่ไม่รู้จักผ่านโดยไม่ตรวจ/ไม่ throw', async () => {
    const seen: Request[] = [];
    const client = createTmsClient({
      baseUrl: 'http://api.test',
      getToken: () => 'tok',
      fetch: async (req) => {
        seen.push(req);
        return new Response(
          JSON.stringify({ data: [futureKey], nextCursor: null, hasMore: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    const r = await client.GET('/v1/api-keys');
    expect(API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(seen[0]!.headers.get('X-Api-Version')).toBe(API_VERSION);
    expect(seen[0]!.headers.get('Authorization')).toBe('Bearer tok');
    expect(r.data?.data[0]?.status).toBe('suspended_by_platform');
  });

  it('enumLabel: ค่าที่รู้จัก → ข้อความไทย · ค่าที่ไม่รู้จัก → ค่าดิบ (ไม่ใช่ชื่อ key) · ว่าง → —', () => {
    const dict: Record<string, string> = { 'akey.st.active': 'ใช้งาน' };
    const t = ((k: string) => dict[k] ?? k) as T;
    expect(enumLabel(t, 'akey.st.', 'active')).toBe('ใช้งาน');
    expect(enumLabel(t, 'akey.st.', 'brand_new')).toBe('brand_new');
    expect(enumLabel(t, 'akey.st.', null)).toBe('—');
  });

  it('StatusDot / statusOf: ป้ายที่ไม่รู้จักได้สีกลาง (off) ไม่พัง', () => {
    expect(statusOf('สถานะใหม่ที่ไม่รู้จัก')).toEqual({ tone: 'off', icon: 'circle' });
    render(<StatusDot label="สถานะใหม่ที่ไม่รู้จัก" />);
    expect(screen.getByText('สถานะใหม่ที่ไม่รู้จัก')).toBeInTheDocument();
  });

  it('Drawer ของ API key แสดง key ที่มีสถานะ/โหมดที่ UI ไม่รู้จักได้ (ค่าดิบ)', () => {
    render(
      <I18nProvider lang="th">
        <ApiKeyDrawer
          k={futureKey}
          canWrite
          onScope={() => {}}
          onRotate={() => {}}
          onRevoke={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>,
    );
    expect(screen.getAllByText('ERP sync').length).toBeGreaterThan(0);
    expect(screen.getAllByText('suspended_by_platform').length).toBeGreaterThan(0);
    expect(screen.queryByText(/akey\.st\./)).toBeNull();
  });
});
