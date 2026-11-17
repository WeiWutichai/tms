import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { SecretDialog } from '../api-keys/SecretDialog';
import { HOOK_URL_RE, parseHeaders, TAB_QUERY } from './useWebhooks';

describe('Webhooks (ST7-T04)', () => {
  it('Header เพิ่มเติม: บรรทัดละ `Name: value` · บรรทัดผิดรูปแบบ = null (ต้นแบบ cfHook)', () => {
    expect(parseHeaders(' X-Client-Id: srithai-erp \n\nAuthorization: Bearer abc:def ')).toEqual([
      { name: 'X-Client-Id', value: 'srithai-erp' },
      { name: 'Authorization', value: 'Bearer abc:def' },
    ]);
    expect(parseHeaders('')).toEqual([]);
    expect(parseHeaders('X-Bad header: x')).toBeNull();
    expect(parseHeaders('X-Empty:')).toBeNull();
  });

  it('URL ต้องเป็น https:// และมีโดเมน', () => {
    expect(HOOK_URL_RE.test('https://erp.siamplastic.co.th/tms/webhook')).toBe(true);
    expect(HOOK_URL_RE.test('https://')).toBe(false);
    expect(HOOK_URL_RE.test('http://erp.example.com/hook')).toBe(false);
    expect(HOOK_URL_RE.test('https://localhost')).toBe(false);
  });

  it('แท็บ "ปิด" รวมที่ระบบปิดอัตโนมัติ', () => {
    expect(TAB_QUERY.disabled).toBe('disabled,auto_disabled');
    expect(TAB_QUERY.failing).toBe('failing');
  });

  it('หน้าต่าง secret ใช้ป้าย "Signing secret"', () => {
    const onCopy = vi.fn();
    render(
      <I18nProvider lang="th">
        <SecretDialog
          title="เพิ่ม endpoint แล้ว"
          sub="https://erp.example.com/hook · 2 event"
          warn="ใช้ secret นี้ตรวจ header X-TMS-Signature ระบบจะไม่แสดงอีก"
          label="Signing secret"
          value="whsec_abc"
          copied={false}
          onCopy={onCopy}
          onClose={() => {}}
        />
      </I18nProvider>,
    );
    expect(screen.getByLabelText('Signing secret')).toHaveValue('whsec_abc');
    fireEvent.click(screen.getByRole('button', { name: 'คัดลอก' }));
    expect(onCopy).toHaveBeenCalled();
  });
});
