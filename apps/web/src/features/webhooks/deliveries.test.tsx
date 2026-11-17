import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider, type T } from '../../i18n';
import { th } from '../../i18n/th';
import { codeLabel, groupDeliveries, payloadText, resendToast } from './deliveries';
import type { WebhookDelivery, WebhookDeliveryDetail } from './useWebhooks';
import { PayloadDialog } from './WebhookDeliveries';

const t: T = (k, p) =>
  String(th[k]).replace(/\{(\w+)\}/g, (_, n: string) => String(p?.[n] ?? `{${n}}`));

const row = (o: Partial<WebhookDelivery>): WebhookDelivery => ({
  id: 'whd_1',
  endpointId: 'whe_1',
  eventId: 'evt_a',
  eventType: 'order.created',
  attempt: 1,
  test: false,
  status: 'failed',
  requestUrl: 'https://erp.example.com/hook',
  responseStatus: 500,
  durationMs: 120,
  errorCode: 'http_status',
  sentAt: '2026-11-18T01:00:00.000Z',
  nextRetryAt: null,
  ...o,
});

describe('ประวัติการส่ง webhook (ST7-T05)', () => {
  it('จัดกลุ่มต่อ event — แถวเดียวต่อ event = ครั้งล่าสุด (ต้นแบบ "ลอง N ครั้ง") · ใหม่สุดก่อน', () => {
    const g = groupDeliveries([
      row({
        id: 'whd_3',
        eventId: 'evt_a',
        attempt: 2,
        status: 'delivered',
        responseStatus: 200,
        sentAt: '2026-11-18T03:00:00.000Z',
      }),
      row({ id: 'whd_2', eventId: 'evt_b', sentAt: '2026-11-18T02:00:00.000Z' }),
      row({ id: 'whd_1', eventId: 'evt_a', attempt: 1, sentAt: '2026-11-18T01:00:00.000Z' }),
    ]);
    expect(g.map((x) => [x.id, x.attempt])).toEqual([
      ['whd_3', 2],
      ['whd_2', 1],
    ]);
  });

  it('ป้ายผล: รหัส HTTP · หมดเวลา · เชื่อมต่อไม่ได้', () => {
    expect(codeLabel(t, { responseStatus: 503, errorCode: 'http_status' })).toBe('503');
    expect(codeLabel(t, { responseStatus: null, errorCode: 'timeout' })).toBe('หมดเวลา');
    expect(codeLabel(t, { responseStatus: null, errorCode: 'ssrf_blocked' })).toBe(
      'เชื่อมต่อไม่ได้',
    );
  });

  it('ข้อความ payload: POST + header (ไม่มี Content-Type/User-Agent) + body จัดรูป + response', () => {
    const d: WebhookDeliveryDetail = {
      ...row({}),
      requestHeaders: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-TMS-Event': 'order.created',
        'X-TMS-Signature': 't=1,v1=5f3c…',
        'X-Client-Token': '***',
      },
      requestBody: '{"id":"evt_a","type":"order.created"}',
      responseBody: '{"error":"down"}',
      errorMessage: null,
    };
    const s = payloadText(t, d);
    expect(s.split('\n').slice(0, 4)).toEqual([
      'POST https://erp.example.com/hook',
      'X-TMS-Event: order.created',
      'X-TMS-Signature: t=1,v1=5f3c…',
      'X-Client-Token: ***',
    ]);
    expect(s).toContain('"type": "order.created"');
    expect(s).toContain(
      '— response —\nHTTP/1.1 500 Internal Server Error\n{\n  "error": "down"\n}',
    );
    expect(
      payloadText(t, { ...d, responseStatus: null, responseBody: null, errorCode: 'timeout' }),
    ).toContain('ไม่ได้รับ response ภายใน 10 วินาที');
    expect(
      payloadText(t, {
        ...d,
        responseStatus: null,
        responseBody: null,
        errorCode: 'ssrf_blocked',
        errorMessage: '10.0.0.5',
      }),
    ).not.toContain('10.0.0.5');
  });

  it('toast ส่งซ้ำ ตามต้นแบบ resendDeliv', () => {
    const base = {
      endpointId: 'whe_1',
      eventId: 'evt_a',
      attempt: 2,
      deliveryId: 'whd_2',
      durationMs: 10,
    };
    expect(resendToast(t, { ...base, state: 'delivered', status: 200, errorCode: null })).toBe(
      'ส่งซ้ำสำเร็จ · 200 OK',
    );
    expect(
      resendToast(t, { ...base, state: 'failed', status: 503, errorCode: 'http_status' }),
    ).toBe('ส่งซ้ำไม่สำเร็จ · 503');
    expect(resendToast(t, { ...base, state: 'failed', status: null, errorCode: 'timeout' })).toBe(
      'ส่งซ้ำไม่สำเร็จ · หมดเวลา',
    );
    expect(resendToast(t, { ...base, state: 'queued', status: null, errorCode: null })).toBe(
      th['whk.toast.reQueued'],
    );
  });

  it('หน้าต่าง payload: ชื่อ/รายละเอียด/JSON · คัดลอก · Esc ปิด', () => {
    const onClose = vi.fn();
    const onCopy = vi.fn();
    render(
      <I18nProvider lang="th">
        <PayloadDialog
          title="Event order.created"
          sub="evt_a · 18/11/2569 08:00 · HTTP 500"
          json={'POST https://erp.example.com/hook'}
          onClose={onClose}
          onCopy={onCopy}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole('dialog', { name: 'Event order.created' })).toBeInTheDocument();
    expect(screen.getByText('POST https://erp.example.com/hook')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'คัดลอก' }));
    expect(onCopy).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
