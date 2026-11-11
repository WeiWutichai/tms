import { Button, EmptyState } from '@tms/ui';
import { useNavigate } from 'react-router-dom';
import { formatDate, useI18n } from '../i18n';
import { SetupChecklist } from '../features/setup/SetupChecklist';
import { PageHeader } from '../shell/Header';

/** ภาพรวม — หัวหน้าตามต้นแบบ; KPI/กราฟต้องใช้ข้อมูลจาก ST3–ST6 จึงยังแสดง "ยังไม่เปิดใช้" (ทำใน ST9) */
export function Dashboard() {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  return (
    <>
      <PageHeader
        title={t('page.dash.title')}
        sub={t('page.dash.sub', { date: formatDate(new Date(), lang) })}
      />
      <SetupChecklist />
      <EmptyState
        variant="page"
        icon="construction"
        title={t('empty.notReady.title')}
        description={t('empty.notReady.desc', { stage: 'ST9' })}
        action={
          <Button variant="secondary" icon="palette" onClick={() => nav('/design-system')}>
            {t('nav.ds')}
          </Button>
        }
      />
    </>
  );
}
