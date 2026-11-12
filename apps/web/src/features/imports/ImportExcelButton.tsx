import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@tms/ui';
import { useState } from 'react';
import { api, unwrap } from '../../api';
import { useI18n } from '../../i18n';
import { ImportWizard } from './ImportWizard';

/**
 * ปุ่ม "นำเข้า Excel" ของหน้ารายการข้อมูลหลัก (ST2-T23) — ต้นแบบ TMS v4: ปุ่ม secondary ไอคอน file-spreadsheet → vWiz
 * แสดงเฉพาะผู้มีสิทธิ์นำเข้าชนิดนั้น (GET /v1/imports/kinds คืนเฉพาะชนิดที่มี scope เท่ากับสิทธิ์สร้าง)
 * นำเข้าเสร็จ → แจ้งผล (toast ของหน้า) + โหลดรายการใหม่
 */
export function ImportExcelButton({
  kind,
  label,
  onDone,
}: {
  kind: string;
  label: string;
  /** นำเข้าแล้ว n แถว — หน้าแสดง toast ของตัวเอง */
  onDone: (message: string) => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const kinds = useQuery({
    queryKey: ['import-kinds'],
    queryFn: () => unwrap(api.GET('/v1/imports/kinds')),
    staleTime: 5 * 60_000,
  });
  const [open, setOpen] = useState(false);
  const k = kinds.data?.find((x) => x.kind === kind);
  if (!k) return null;
  return (
    <>
      <Button variant="secondary" icon="file-spreadsheet" onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && (
        <ImportWizard
          kind={k}
          onClose={(n) => {
            setOpen(false);
            if (n === null) return;
            void qc.invalidateQueries();
            onDone(t('imp.done', { kind: k.label, n }));
          }}
        />
      )}
    </>
  );
}
