import { Button, EmptyState } from '@tms/ui';
import { Component, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { PageHeader } from '../shell/Header';

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
