import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider, useI18n } from '../../i18n';
import { OrderSourceBadge, orderSourceText, type OrderSourceProps } from './OrderSource';

function Long(p: OrderSourceProps) {
  const { t } = useI18n();
  return <span data-testid="long">{orderSourceText(t, p)}</span>;
}

const wrap = (ui: ReactNode) => render(<I18nProvider lang="th">{ui}</I18nProvider>);

describe('ที่มาของ SO (ST3-T01 — ข้อความตามต้นแบบ TMS v4)', () => {
  it.each([
    ['MANUAL', null, 'มือ', 'สร้างเอง'],
    ['IMPORT', null, 'CSV', 'นำเข้า CSV'],
    ['API', null, 'API', 'API'],
    ['PORTAL', null, 'พอร์ทัล', 'พอร์ทัลลูกค้า'],
    ['CONNECTOR', 'krs', 'KRS', 'ERP'],
  ] as const)('%s → ชิป / drawer', (source, connector, chip, long) => {
    wrap(
      <>
        <OrderSourceBadge source={source} connector={connector} />
        <Long source={source} connector={connector} />
      </>,
    );
    const el = screen.getByText(chip, { selector: '.tms-tag' });
    expect(el).toHaveAttribute('data-source', source);
    expect(screen.getByTestId('long')).toHaveTextContent(long);
  });

  it('ชื่อ connector จากหน้าการเชื่อมต่อใช้แทนรหัส · tooltip บอกเลขอ้างอิงต้นทาง', () => {
    wrap(
      <OrderSourceBadge
        source="CONNECTOR"
        connector="express"
        connectorName="Express"
        externalId="SO-0042"
      />,
    );
    expect(screen.getByText('Express')).toHaveAttribute(
      'title',
      'ที่มา: Express · เลขอ้างอิงต้นทาง SO-0042',
    );
  });
});
