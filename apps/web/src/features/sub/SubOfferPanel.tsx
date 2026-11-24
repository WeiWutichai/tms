import { Drawer } from '@tms/ui';
import { useState } from 'react';
import { useI18n } from '../../i18n';
import { can } from '../../nav';
import { useMe } from '../../shell/AppShell';
import { SubconHireDrawer } from '../trips/SubconHireDrawer';
import { SubconOfferDrawer } from '../trips/SubconOfferDrawer';
import { TripDrawer } from '../trips/TripDrawer';
import { useTrip } from '../trips/useTrips';

/**
 * แผง "จ่ายงานรถร่วม" ของแถวในหน้า `/sub` (ต้นแบบ `openP('sub', id)` → vPanel kind 'sub') — ใช้ drawer เดิมของ ST3-T22–T25:
 * - การจ้างที่ใช้งานอยู่ (รอตอบ/รับงาน) → `SubconOfferDrawer` (ส่งรายถัดไป / เปลี่ยนผู้รับเหมา → `SubconHireDrawer` แบบแทน/เปลี่ยน)
 * - ปฏิเสธ/หมดเวลาแล้วเที่ยวกลับวางแผน (`next` = เมนู "ส่งต่อผู้รับเหมาถัดไป" หรือคลิกแถว) → `SubconHireDrawer` จ้างรายใหม่
 *   (ต้องมี `trips:assign` + `prices.buy:read` แบบปุ่ม "ส่งต่อรถร่วม" ของ drawer เที่ยว)
 * - อื่น ๆ (เที่ยวถูกจัดรถบริษัท/ยกเลิกแล้ว หรือไม่มีสิทธิ์จ้าง) → drawer เที่ยว (อ่าน)
 */
export function SubOfferPanel({
  tripId,
  next = false,
  onClose,
  onDone,
}: {
  tripId: string;
  /** เมนู "ส่งต่อผู้รับเหมาถัดไป" — หมดเวลาแต่เที่ยวยังรอตอบ (job ยังไม่ปิด) → drawer จ้างแบบแทนรายเดิมทันที */
  next?: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { t } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canAssign = can(scopes, 'trips:assign');
  const canHire = canAssign && can(scopes, 'prices.buy:read');
  const q = useTrip(tripId);
  const [mode, setMode] = useState<'view' | 'next' | 'change'>(next ? 'next' : 'view');
  const [why, setWhy] = useState<string | null>(null);
  const tr = q.data;
  const labels = { close: t('drawer.close'), more: t('drawer.more') };
  if (!tr)
    return (
      <Drawer open onClose={onClose} kind={t('sub.kind')} title="…" labels={labels}>
        <span style={{ color: '#59606B' }}>
          {q.isError ? t('sub.loadError') : t('table.loading')}
        </span>
      </Drawer>
    );
  const done = (m: string) => {
    onDone(m);
    onClose();
  };
  if (tr.hire && mode === 'view')
    return (
      <SubconOfferDrawer
        trip={tr}
        onClose={onClose}
        {...(canHire ? { onNext: () => setMode('next') } : {})}
        {...(canHire
          ? {
              onChangeCarrier: (w: string) => {
                setWhy(w);
                setMode('change');
              },
            }
          : {})}
      />
    );
  const replacing = mode === 'next' && tr.status === 'OFFERED' && !!tr.hire;
  const changing =
    mode === 'change' && why !== null && !!tr.hire && ['OFFERED', 'ASSIGNED'].includes(tr.status);
  if (canHire && (tr.status === 'PLANNING' || replacing || changing))
    return (
      <SubconHireDrawer
        trip={tr}
        replace={replacing}
        change={changing ? why : null}
        onClose={tr.hire ? () => setMode('view') : onClose}
        onDone={done}
      />
    );
  return (
    <TripDrawer
      id={tripId}
      canEdit={canAssign}
      canDispatch={can(scopes, 'trips:dispatch')}
      canOverride={can(scopes, 'trips:override')}
      canPrint={can(scopes, 'documents:write')}
      canHire={canHire}
      onDone={done}
      onClose={onClose}
    />
  );
}
