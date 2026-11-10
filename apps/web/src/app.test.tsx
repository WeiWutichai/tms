import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { I18nProvider, formatDate, formatLongDate, formatMoney, useI18n } from './i18n';
import { NotReady } from './pages/Simple';

function Probe() {
  const { t, setLang } = useI18n();
  return (
    <>
      <span data-testid="v">{t('nav.ops.plan')}</span>
      <button onClick={() => setLang('en')}>en</button>
    </>
  );
}

describe('i18n', () => {
  it('ไทยเป็นค่าเริ่มต้น สลับเป็นอังกฤษได้ (คำจากพจนานุกรมต้นแบบ)', async () => {
    render(
      <I18nProvider lang="th">
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('v')).toHaveTextContent('กระดานวางแผน');
    screen.getByText('en').click();
    expect(await screen.findByText('Planning board')).toBeInTheDocument();
  });

  it('วันที่ตามต้นแบบ พ.ศ./ค.ศ.', () => {
    const d = new Date(2026, 10, 3); // 3 พ.ย. 2026 (วันอังคาร)
    expect(formatLongDate(d, 'th')).toBe('อังคารที่ 3 พ.ย. 2569');
    expect(formatDate(d, 'th', 'CE')).toBe('3 พ.ย. 2026');
  });

  it('เงินจาก string ไม่ผ่าน float', () => {
    expect(formatMoney('1234567.5')).toBe('1,234,567.50');
    expect(formatMoney('-0.07')).toBe('-0.07');
  });

  it('หน้า "ยังไม่เปิดใช้" บอก stage', () => {
    render(
      <I18nProvider lang="th">
        <MemoryRouter>
          <NotReady page="so" stage="ST3" />
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(screen.getByText(/ST3/)).toBeInTheDocument();
  });
});
