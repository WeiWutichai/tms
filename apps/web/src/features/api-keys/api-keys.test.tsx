import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ipLines } from './ApiKeyFormDrawer';
import { SecretDialog } from './SecretDialog';

describe('API keys (ST7-T01)', () => {
  it('ipLines: บรรทัดละรายการหรือคั่นด้วย , · ตัดช่องว่าง/บรรทัดว่าง', () => {
    expect(ipLines(' 203.150.12.0/24 \n\n10.0.0.1, 2001:db8::/32 ')).toEqual([
      '203.150.12.0/24',
      '10.0.0.1',
      '2001:db8::/32',
    ]);
    expect(ipLines('')).toEqual([]);
  });

  it('หน้าต่าง secret: แสดงค่าเต็มครั้งเดียว + คัดลอก + ปิดด้วยปุ่มเท่านั้น', () => {
    const onCopy = vi.fn();
    const onClose = vi.fn();
    render(
      <I18nProvider lang="th">
        <SecretDialog
          title="สร้าง API key แล้ว"
          sub="ERP · Production · orders:read"
          warn="คำเตือน"
          value="tk_live_abc"
          copied={false}
          onCopy={onCopy}
          onClose={onClose}
        />
      </I18nProvider>,
    );
    expect(screen.getByLabelText('Secret key')).toHaveValue('tk_live_abc');
    fireEvent.click(screen.getByRole('button', { name: 'คัดลอก' }));
    expect(onCopy).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'คัดลอกแล้ว · ปิดหน้าต่าง' }));
    expect(onClose).toHaveBeenCalled();
  });
});
