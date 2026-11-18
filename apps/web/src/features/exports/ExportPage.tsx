import { Button, EmptyState } from '@tms/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import { useDateText } from '../rate-cards/rateFormat';
import { fetchExport, openDownload } from './exportJob';

/** วันที่ (Bangkok) ของเวลา ISO */
const bkkDay = (iso: string) =>
  new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 10);

/**
 * ลิงก์จากแจ้งเตือน/อีเมล "ไฟล์ส่งออกพร้อมแล้ว" (ST9-T10) — `/exports/{jobId}`
 * ต้นแบบไม่มีหน้านี้ → ใช้หน้าว่างแบบเต็มหน้า (EmptyState variant page แบบหน้า "ไม่พบหน้า") [DECISION spec/12 §3]
 * เปิดแล้วดาวน์โหลดให้อัตโนมัติครั้งเดียว + ปุ่มดาวน์โหลดอีกครั้ง (ขอ URL ลายเซ็นใหม่ทุกครั้ง — อายุ 5 นาที)
 */
export function ExportPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const dateText = useDateText();
  const { id = '' } = useParams();
  const q = useQuery({
    queryKey: ['exports', id],
    queryFn: () => fetchExport(id),
    retry: false,
    refetchInterval: (s) =>
      s.state.data?.status === 'pending' || s.state.data?.status === 'running' ? 2000 : false,
  });
  const auto = useRef(false);
  const s = q.data;
  useEffect(() => {
    if (s?.status === 'succeeded' && s.downloadUrl && !auto.current) {
      auto.current = true;
      openDownload(s.downloadUrl);
    }
  }, [s]);

  const back = (
    <Button variant="secondary" icon="layout-dashboard" onClick={() => nav('/')}>
      {t('empty.backDash')}
    </Button>
  );
  if (q.isLoading) return <EmptyState variant="page" icon="loader" title={t('trk.loading')} />;
  if (q.error || !s) {
    const notFound = q.error instanceof ApiError && q.error.problem.status === 404;
    return (
      <EmptyState
        variant="page"
        icon="file-question"
        title={t(notFound ? 'export.page.notFound' : 'trk.err')}
        description={notFound ? t('export.page.notFoundDesc') : undefined}
        action={back}
      />
    );
  }
  if (s.status === 'pending' || s.status === 'running')
    return (
      <EmptyState
        variant="page"
        icon="hourglass"
        title={t('export.page.pending')}
        description={t('export.page.pendingDesc')}
        action={back}
      />
    );
  if (s.status === 'expired')
    return (
      <EmptyState
        variant="page"
        icon="file-x"
        title={t('export.page.expired')}
        description={t('export.page.expiredDesc')}
        action={back}
      />
    );
  if (s.status !== 'succeeded')
    return (
      <EmptyState
        variant="page"
        icon="file-x"
        title={t('export.page.failed')}
        description={t(s.error?.code === 'too_many_rows' ? 'export.tooMany' : 'export.failedDesc')}
        action={back}
      />
    );
  return (
    <EmptyState
      variant="page"
      icon="file-down"
      title={t('export.page.ready')}
      description={t('export.page.readyDesc', {
        file: s.fileName ?? '',
        n: (s.rows ?? 0).toLocaleString('en-US'),
        d: s.expiresAt ? dateText(bkkDay(s.expiresAt)) : '',
      })}
      action={
        <Button
          icon="download"
          onClick={() =>
            void fetchExport(id).then((x) => x.downloadUrl && openDownload(x.downloadUrl))
          }
        >
          {t('export.page.download')}
        </Button>
      }
    />
  );
}
