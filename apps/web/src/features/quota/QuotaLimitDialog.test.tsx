import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import { I18nProvider } from '../../i18n';
import { limitProblem, QuotaLimitDialog } from './QuotaLimitDialog';

/** P1-ST1-T08 hard limit (PLT-079) → dialog ครบโควตา + เสนออัปเกรด */
const err = (extra: object) =>
  new ApiError({ type: '', title: '', status: 409, ...extra } as never);

describe('limitProblem', () => {
  it('เฉพาะรหัส *_limit_reached ของโควตา', () => {
    expect(limitProblem(err({ code: 'webhook_limit_reached', limit: 3 }))?.limit).toBe(3);
    expect(limitProblem(err({ code: 'seat_limit_reached' }))?.code).toBe('seat_limit_reached');
    expect(limitProblem(err({ code: 'saved_view_limit' }))).toBeNull();
    expect(limitProblem(new Error('x'))).toBeNull();
    expect(limitProblem(null)).toBeNull();
  });
});

describe('QuotaLimitDialog', () => {
  const mount = (p: object, onClose = () => {}) =>
    render(
      <I18nProvider>
        <QuotaLimitDialog
          problem={limitProblem(
            err({ code: 'webhook_limit_reached', featureKey: 'webhook', ...p }),
          )!}
          onClose={onClose}
        />
      </I18nProvider>,
    );

  it('หัว = ข้อความ problem · จำนวนที่ใช้/รองรับ · แพ็กเกจถัดไปแบบไม่จำกัด · ปิดได้', () => {
    const onClose = vi.fn();
    mount(
      { limit: 3, used: 3, upgradePlan: { code: 'ent', name: 'Enterprise', limit: null } },
      onClose,
    );
    const d = screen.getByTestId('quota-limit-dialog');
    expect(d).toHaveTextContent('จำนวน webhook endpoint ครบตามแพ็กเกจแล้ว');
    expect(d).toHaveTextContent('รองรับ 3 endpoint · ตอนนี้ใช้ 3 endpoint');
    expect(d).toHaveTextContent('อัปเกรดเป็นEnterprise รองรับไม่จำกัด endpoint');
    fireEvent.click(screen.getAllByRole('button', { name: 'ปิด' }).at(-1)!);
    expect(onClose).toHaveBeenCalled();
  });

  it('มี limit ของแพ็กเกจถัดไป / ไม่มีแพ็กเกจถัดไป → ติดต่อทีมงาน', () => {
    mount({ limit: 3, used: 3, upgradePlan: { code: 'biz', name: 'Business', limit: 10 } });
    expect(screen.getByTestId('quota-limit-dialog')).toHaveTextContent('รองรับ 10 endpoint');
  });
  it('ไม่มี upgradePlan', () => {
    mount({ limit: 3, used: 3, upgradePlan: null });
    expect(screen.getByTestId('quota-limit-dialog')).toHaveTextContent(
      'ติดต่อทีมงานเพื่อเพิ่มโควตา',
    );
  });
});
