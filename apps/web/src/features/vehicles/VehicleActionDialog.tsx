import { ReasonDialog } from '@tms/ui';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import { problemText } from '../master/problems';
import { useVehicleAction, vehPlate, type Vehicle, type VehicleStatus } from './useVehicles';

export type VehicleDialog =
  { kind: 'status'; v: Vehicle; to: VehicleStatus } | { kind: 'delete'; v: Vehicle };

const num = (n: number) => n.toLocaleString('th-TH');

/**
 * dialog เหตุผล (≥ 10 ตัวอักษร) สำหรับเปลี่ยนสถานะ / ลบรถ — ใช้ร่วมระหว่างทะเบียนรถ (ST2-T06) และโปรไฟล์รถ (ST2-T07)
 * `onDone(updated)` — updated = รถหลังเปลี่ยนสถานะ, null = ลบแล้ว
 */
export function VehicleActionDialog({
  dialog,
  onClose,
  onDone,
}: {
  dialog: VehicleDialog | null;
  onClose: () => void;
  onDone: (d: VehicleDialog, updated: Vehicle | null) => void;
}) {
  const { t } = useI18n();
  const action = useVehicleAction();

  const actionError = (): string | null => {
    const e = action.error;
    if (e instanceof ApiError && e.problem.code === 'in_use_active') {
      const refs = (e.problem as { references?: { trips?: number } }).references;
      return t('veh.retireBusy', { n: num(refs?.trips ?? 0) });
    }
    return problemText(e, t);
  };

  return (
    <ReasonDialog
      open={!!dialog}
      title={
        dialog
          ? dialog.kind === 'delete'
            ? t('veh.dlg.delT', { n: vehPlate(t, dialog.v) })
            : t('veh.dlg.statusT', { n: vehPlate(t, dialog.v), s: t(`veh.st.${dialog.to}`) })
          : ''
      }
      description={
        dialog
          ? t(
              dialog.kind === 'delete'
                ? 'veh.dlg.delD'
                : dialog.to === 'retired'
                  ? 'veh.dlg.retireD'
                  : 'veh.dlg.statusD',
            )
          : ''
      }
      label={t('veh.dlg.reason')}
      placeholder={t('veh.dlg.reasonPh')}
      okLabel={dialog?.kind === 'delete' ? t('veh.menu.delete') : t('veh.dlg.ok')}
      cancelLabel={t('common.cancel')}
      closeLabel={t('drawer.close')}
      busy={action.isPending}
      error={actionError()}
      onClose={() => {
        onClose();
        action.reset();
      }}
      onOk={(reason) => {
        if (!dialog) return;
        const d = dialog;
        action.mutate(
          d.kind === 'delete'
            ? { id: d.v.id, version: d.v.version, action: 'delete', reason }
            : { id: d.v.id, version: d.v.version, action: 'status', status: d.to, reason },
          { onSuccess: (u) => onDone(d, u) },
        );
      }}
    />
  );
}
