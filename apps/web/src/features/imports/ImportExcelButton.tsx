import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@tms/ui';
import { useState } from 'react';
import { api, unwrap } from '../../api';
import { useI18n } from '../../i18n';
import { useMe } from '../../shell/AppShell';
import { ImportWizard } from './ImportWizard';

/** query ที่ต้องโหลดใหม่หลังนำเข้าแต่ละชนิด (key ของ hook รายการในแต่ละหน้า) */
const AFFECTS: Record<string, string[]> = {
  customer: ['customers'],
  customer_site: ['customer-sites'],
  carrier: ['carriers'],
  vehicle: ['vehicles'],
  driver: ['drivers', 'carriers'],
  route: ['routes'],
  product: ['products'],
  service_item: ['service-items'],
  rate_card_sell: ['rate-cards'],
  rate_card_buy: ['rate-cards'],
  // ST3-T04 — หน้ารายการ SO (ST3-T02) ใช้ key 'orders'
  order: ['orders'],
};

/**
 * ชนิดที่ผู้ใช้นำเข้าได้ (GET /v1/imports/kinds คืนเฉพาะชนิดที่มี scope เท่ากับสิทธิ์สร้าง)
 * cache ต่อผู้ใช้ + บทบาท (เปลี่ยนผู้ใช้/สิทธิ์ = ดึงใหม่) และไม่เก่าเกิน 1 นาที
 */
export function useImportKind(kind: string) {
  const me = useMe();
  const who = me.data
    ? `${me.data.user?.email ?? '-'}:${[...me.data.scopes].sort().join(' ')}`
    : null;
  const kinds = useQuery({
    queryKey: ['import-kinds', who],
    queryFn: () => unwrap(api.GET('/v1/imports/kinds')),
    enabled: !!who,
    staleTime: 60_000,
  });
  return kinds.data?.find((x) => x.kind === kind);
}

/**
 * ปุ่ม "นำเข้า Excel" ของหน้ารายการข้อมูลหลัก (ST2-T23) — ต้นแบบ TMS v4: ปุ่ม secondary ไอคอน file-spreadsheet → vWiz
 * แสดงเฉพาะผู้มีสิทธิ์นำเข้าชนิดนั้น · นำเข้าเสร็จ → toast ของหน้า + โหลดรายการของชนิดนั้นใหม่
 * open/onOpenChange: เปิด wizard จากที่อื่นได้ (เช่น ปุ่มท้าย drawer เพิ่มรถ — ต้นแบบ)
 */
export function ImportExcelButton({
  kind,
  label,
  onDone,
  open: openProp,
  onOpenChange,
  icon = 'file-spreadsheet',
}: {
  kind: string;
  label: string;
  /** ไอคอนปุ่ม — ต้นแบบ SO ใช้ upload ("นำเข้า CSV"), หน้าข้อมูลหลักใช้ file-spreadsheet */
  icon?: string;
  onDone: (message: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [own, setOwn] = useState(false);
  const open = openProp ?? own;
  const setOpen = onOpenChange ?? setOwn;
  const k = useImportKind(kind);
  if (!k) return null;
  return (
    <>
      <Button variant="secondary" icon={icon} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && (
        <ImportWizard
          kind={k}
          onClose={(n, entities) => {
            setOpen(false);
            if (n === null) return;
            for (const key of [...(AFFECTS[kind] ?? []), 'history'])
              void qc.invalidateQueries({ queryKey: [key] });
            onDone(
              entities != null
                ? t('imp.doneEntities', { kind: k.label, n, m: entities })
                : t('imp.done', { kind: k.label, n }),
            );
          }}
        />
      )}
    </>
  );
}
