import { Button, EmptyState, Icon } from '@tms/ui';
import { Component, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { PageHeader } from '../shell/Header';

/** ไม่มีสิทธิ์ (is.noacc ของต้นแบบ — ข้อความทั่วไปแทนข้อความเฉพาะเมนูนักพัฒนา) */
export function NoAccess({ role }: { role: string }) {
  const { t } = useI18n();
  const nav = useNavigate();
  return (
    <EmptyState
      variant="page"
      icon="shield-x"
      title={t('noAccess.title')}
      description={t('noAccess.desc', { role })}
      action={
        <Button variant="secondary" onClick={() => nav('/')}>
          {t('noAccess.back')}
        </Button>
      }
    />
  );
}

/**
 * ฟีเจอร์ไม่รวมในแพ็กเกจ (is.locked ของต้นแบบ; spec/01 PLT-076) — ซ้าย: ชื่อ/คำอธิบาย/จุดเด่นของโมดูล, ขวา: แพ็กเกจที่มี
 * เฟส 0 ยังไม่มีหน้าแพ็กเกจ/ชำระเงิน → ไม่แสดงปุ่ม "อัปเกรด" / "ซื้อ Add-on" / "เทียบแพ็กเกจ" และราคา (spec/12 §3)
 */
export function LockedPage({
  feature,
  plan,
  need,
}: {
  feature: string;
  plan: string;
  need?: string;
}) {
  const { t } = useI18n();
  const k = (x: string) => t(`lock.${feature}.${x}` as MessageKey);
  return (
    <section
      style={{
        background: '#FFFFFF',
        border: '1px solid #CDD1C8',
        borderRadius: 12,
        boxShadow: '0 1px 2px rgba(16,20,24,.06),0 2px 6px rgba(16,20,24,.04)',
        padding: '40px 32px',
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr)',
        gap: 32,
        alignItems: 'center',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span
          style={{
            display: 'inline-flex',
            alignSelf: 'flex-start',
            alignItems: 'center',
            gap: 6,
            height: 26,
            padding: '0 10px',
            borderRadius: 999,
            background: '#EEF0EC',
            color: '#3B424C',
            fontSize: 12.5,
            fontWeight: 600,
          }}
        >
          <Icon n="lock" s={12} />
          {t('lock.badge', { plan })}
        </span>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: '#13213F' }}>{k('t')}</h2>
        <p style={{ margin: 0, color: '#3B424C', maxWidth: 520 }}>{k('d')}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {['p1', 'p2', 'p3'].map((p) => (
            <span key={p} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon n="check" s={16} style={{ color: '#17733F' }} />
              {k(p)}
            </span>
          ))}
        </div>
      </div>
      {need && (
        <div
          style={{
            background: '#F7F8F5',
            border: '1px solid #E4E6E0',
            borderRadius: 12,
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 500, color: '#59606B' }}>
            {t('lock.inPlan')}
          </span>
          <span style={{ fontSize: 18, fontWeight: 600, color: '#13213F' }}>{need}</span>
          <span style={{ fontSize: 13, color: '#59606B', marginTop: 6 }}>{t('lock.note')}</span>
        </div>
      )}
    </section>
  );
}

/** หน้าที่ยังไม่ถึง stage — ใช้รูปแบบ is.empty ของต้นแบบ (การ์ดเต็ม padding 72) */
export function NotReady({ page, stage }: { page: string; stage: string }) {
  const { t } = useI18n();
  const nav = useNavigate();
  return (
    <>
      <PageHeader
        title={t(`page.${page}.title` as MessageKey)}
        sub={t(`page.${page}.sub` as MessageKey)}
      />
      <EmptyState
        variant="page"
        icon="construction"
        title={t('empty.notReady.title')}
        description={t('empty.notReady.desc', { stage })}
        action={
          <Button variant="secondary" icon="layout-dashboard" onClick={() => nav('/')}>
            {t('empty.backDash')}
          </Button>
        }
      />
    </>
  );
}

export function NotFound() {
  const { t } = useI18n();
  const nav = useNavigate();
  return (
    <EmptyState
      variant="page"
      icon="file-question"
      title={t('empty.notFound.title')}
      description={t('empty.notFound.desc')}
      action={
        <Button variant="secondary" icon="layout-dashboard" onClick={() => nav('/')}>
          {t('empty.backDash')}
        </Button>
      }
    />
  );
}

/** error boundary — แสดงหน้า error พร้อม requestId (ถ้ามี) */
export class ErrorBoundary extends Component<
  { children: ReactNode; render: (err: Error) => ReactNode },
  { err: Error | null }
> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  render() {
    return this.state.err ? this.props.render(this.state.err) : this.props.children;
  }
}

export function ErrorPage({ requestId }: { requestId?: string }) {
  const { t } = useI18n();
  return (
    <EmptyState
      variant="page"
      icon="triangle-alert"
      title={t('error.title')}
      description={t('error.desc', { requestId: requestId ?? '—' })}
      action={
        <Button variant="secondary" icon="refresh-cw" onClick={() => window.location.reload()}>
          {t('error.reload')}
        </Button>
      }
    />
  );
}
