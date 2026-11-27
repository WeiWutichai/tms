import type { components } from '@tms/contracts';
import { useMutation } from '@tanstack/react-query';
import { Button, EmptyState, Icon, Toast } from '@tms/ui';
import { Component, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, unwrap } from '../api';
import { isImpersonating } from '../auth/session';
import { problemText } from '../features/master/problems';
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

/** ข้อมูลโมดูลที่ล็อกจาก /me (`locks[featureKey]`) */
export type MeLock = components['schemas']['MeLockDto'];

/** ราคา "1280.00" → "1,280" (ต้นแบบ plans.js priceL: บาทเต็ม ใส่ comma — สัญลักษณ์บาทอยู่ใน `lock.price`) · มีสตางค์ → 2 ตำแหน่ง */
export function planPriceText(v: string): string {
  const [i = '0', f = '00'] = v.split('.');
  const baht = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return /^0*$/.test(f) ? baht : `${baht}.${f.padEnd(2, '0').slice(0, 2)}`;
}

/**
 * ฟีเจอร์ไม่รวมในแพ็กเกจ (is.locked / `lkp` ของต้นแบบ v4; spec/01 PLT-076) — ซ้าย: ชื่อ/คำอธิบาย/จุดเด่นของโมดูล + ปุ่ม, ขวา: แพ็กเกจที่มี + ราคา
 * P1-ST1-T02: ผู้จัดการแพ็กเกจได้ (`canManage`) → "อัปเกรดเป็น…" หรือ "ซื้อ Add-on" (แพ็กเกจปัจจุบันขายเป็น add-on) + "เทียบแพ็กเกจ"
 * ไปหน้า "แพ็กเกจและการเรียกเก็บเงิน" (`/settings/billing` — P1-ST3-T03/T05) · ผู้ไม่มีสิทธิ์ → "แจ้งผู้ดูแลระบบ" (PLT-076; ต้นแบบไม่มี — spec/12 §3)
 */
export function LockedPage({
  feature,
  plan,
  lock,
  canManage,
}: {
  feature: string;
  plan: string;
  lock?: MeLock;
  canManage: boolean;
}) {
  const { t } = useI18n();
  const nav = useNavigate();
  const [toast, setToast] = useState<{ m: string; err?: boolean } | null>(null);
  const k = (x: string) => t(`lock.${feature}.${x}` as MessageKey);
  const notify = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/v1/me/feature-requests', { body: { featureKey: feature } })),
    onSuccess: (r) =>
      setToast({ m: t(r.alreadyRequested ? 'lock.notifiedAgain' : 'lock.notified') }),
    onError: (e) => setToast({ m: problemText(e, t) ?? t('lock.notifyFailed'), err: true }),
  });
  const need = lock?.planName ?? null;
  return (
    <>
      <PageHeader title={k('t')} sub={t('lock.pageSub')} />
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
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {canManage ? (
              <>
                {lock?.addon ? (
                  <Button
                    variant="primary"
                    icon="plus"
                    style={{ padding: '0 16px' }}
                    onClick={() => nav(`/settings/billing?addon=${encodeURIComponent(feature)}`)}
                  >
                    {t('lock.buy')}
                  </Button>
                ) : (
                  need &&
                  lock?.planCode && (
                    <Button
                      variant="primary"
                      icon="circle-arrow-up"
                      style={{ padding: '0 16px' }}
                      onClick={() =>
                        nav(`/settings/billing?plan=${encodeURIComponent(lock.planCode!)}`)
                      }
                    >
                      {t('lock.up', { plan: need })}
                    </Button>
                  )
                )}
                <Button variant="secondary" onClick={() => nav('/settings/billing')}>
                  {t('lock.compare')}
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                icon="send"
                style={{ padding: '0 16px' }}
                disabled={notify.isPending || isImpersonating()}
                onClick={() => notify.mutate()}
              >
                {t('lock.notify')}
              </Button>
            )}
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
            <span style={{ fontVariantNumeric: 'tabular-nums', color: '#3B424C' }}>
              {lock?.pricePerVehicleMonthly
                ? t('lock.price', { price: planPriceText(lock.pricePerVehicleMonthly) })
                : t('lock.contactSales')}
            </span>
            <span style={{ fontSize: 13, color: '#59606B', marginTop: 6 }}>{t('lock.note')}</span>
          </div>
        )}
        <Toast
          message={toast?.m ?? null}
          tone={toast?.err ? 'err' : 'ok'}
          onClose={() => setToast(null)}
          closeLabel={t('drawer.close')}
        />
      </section>
    </>
  );
}

/** หน้าที่ยังไม่ถึง stage — ใช้รูปแบบ is.empty ของต้นแบบ (การ์ดเต็ม padding 72) */
export function NotReady({
  page,
  stage,
  phase1,
}: {
  page: string;
  stage: string;
  /** หน้าของแผนเฟส 1 (`plan/13`) — ข้อความ "ตามแผนพัฒนาเฟส 1" */
  phase1?: boolean;
}) {
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
        description={t(phase1 ? 'empty.notReady.descP1' : 'empty.notReady.desc', { stage })}
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
