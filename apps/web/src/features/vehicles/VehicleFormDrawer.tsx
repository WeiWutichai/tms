import { FormDrawer } from '@tms/ui';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import { fieldErrors, problemText } from '../master/problems';
import { EMPTY_FORM, VehicleFields, toBody, validate, type VehicleForm } from './VehicleFields';
import { useCreateVehicle, useVehicleTypeOptions, type Vehicle } from './useVehicles';

/**
 * "เพิ่มรถ" — ต้นแบบ TMS v4 newWithCf('veh'): ส่วน "ข้อมูลหลัก" (ทะเบียน ประเภทรถ น้ำหนักบรรทุก) + "ข้อมูลเพิ่มเติม" (เลข GPS box)
 * ช่องที่ต้นแบบไม่มีแต่ backlog/spec บังคับ [OPEN spec/12 §3]: จังหวัด, เจ้าของ + ชื่อเจ้าของ (ผู้รับเหมา — รถร่วมบังคับ),
 * ทะเบียนรถขยาย (บทบาทหัวลาก/หาง + จับคู่, ยี่ห้อ รุ่น ปี สี เลขตัวถัง/เครื่อง น้ำหนัก เชื้อเพลิง ถัง เลขไมล์),
 * การซื้อและค่าเสื่อม (เฉพาะสิทธิ์ reports.finance:read)
 */
export function VehicleFormDrawer({
  open,
  finance,
  tenantName,
  quota,
  onClose,
  onSaved,
}: {
  open: boolean;
  finance: boolean;
  tenantName: string;
  /** โควตารถ (soft limit) — ครบแล้วเตือนแต่ยังเพิ่มได้ */
  quota?: { limit: number | null; used: number } | undefined;
  onClose: () => void;
  onSaved: (v: Vehicle) => void;
}) {
  const { t } = useI18n();
  const create = useCreateVehicle();
  const types = useVehicleTypeOptions();
  const [f, setF] = useState<VehicleForm>(EMPTY_FORM);
  const [tried, setTried] = useState(false);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const submitting = useRef(false);
  const [shown, setShown] = useState(false);
  if (open !== shown) {
    setShown(open);
    if (open) {
      setF(EMPTY_FORM);
      setTried(false);
    }
  }
  useEffect(() => {
    if (open) {
      setIdemKey(crypto.randomUUID());
      submitting.current = false;
      create.reset();
    }
  }, [open]);

  const set = <K extends keyof VehicleForm>(k: K, v: VehicleForm[K]) =>
    setF((x) => ({ ...x, [k]: v }));
  const local = validate(f, t);
  const server = fieldErrors(create.error, t);
  if (
    create.error instanceof ApiError &&
    create.error.problem.errors?.some((e) => e.field === 'plate' && e.code === 'duplicate')
  )
    server.plate = t('veh.v.dup');
  const errs = { ...(tried ? local : {}), ...server };
  const topErr = create.error && !Object.keys(server).length ? problemText(create.error, t) : null;
  const opts = (types.data ?? []).map((x) => ({ id: x.id, name: x.name, payloadKg: x.payloadKg }));
  const over = quota && quota.limit !== null && quota.used >= quota.limit;

  const submit = () => {
    setTried(true);
    if (Object.keys(local).length || submitting.current) return;
    submitting.current = true;
    create.mutate(
      { idempotencyKey: idemKey, body: toBody(f, finance) },
      {
        onSuccess: onSaved,
        onError: () => setIdemKey(crypto.randomUUID()),
        onSettled: () => {
          submitting.current = false;
        },
      },
    );
  };

  return (
    <FormDrawer
      open={open}
      title={t('veh.create.title')}
      onClose={onClose}
      closeLabel={t('drawer.close')}
      {...(tried && Object.keys(local).length
        ? { alert: t('form.incomplete', { n: Object.keys(local).length }) }
        : {})}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="tms-fdrawer__cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="tms-drawer__pri"
            style={{ height: 40, padding: '0 18px' }}
            disabled={create.isPending}
          >
            {t('veh.add')}
          </button>
        </>
      }
    >
      {over && (
        <div
          className="tms-alert"
          style={{ background: '#FCF0DC', borderColor: '#C98A1B', color: '#8F5500' }}
        >
          {t('veh.quota', { limit: quota!.limit!, used: quota!.used })}
        </div>
      )}
      {topErr && <div className="tms-alert">{topErr}</div>}
      <section className="tms-fsec">
        <h3 className="tms-fsec__h">{t('veh.sec.main')}</h3>
        <div className="tms-fgrid tms-fgrid--create">
          <VehicleFields
            t={t}
            f={f}
            set={set}
            errs={errs}
            section="main"
            tenantName={tenantName}
            types={opts}
            onType={(id) => {
              // ประเภทรถเปลี่ยน → น้ำหนักบรรทุกตั้งต้นจากประเภท (ถ้ายังไม่ได้พิมพ์เอง)
              const vt = opts.find((x) => x.id === id);
              setF((x) => ({
                ...x,
                typeId: id,
                cap:
                  !x.cap || opts.some((o) => String(o.payloadKg ?? '') === x.cap)
                    ? String(vt?.payloadKg ?? '')
                    : x.cap,
              }));
            }}
          />
        </div>
      </section>
      <section className="tms-fsec">
        <h3 className="tms-fsec__h">{t('veh.sec.extra')}</h3>
        <div className="tms-fgrid tms-fgrid--create">
          <VehicleFields
            t={t}
            f={f}
            set={set}
            errs={errs}
            section="extra"
            tenantName={tenantName}
            types={opts}
          />
        </div>
      </section>
      {finance && (
        <section className="tms-fsec">
          <h3 className="tms-fsec__h">{t('veh.sec.fin')}</h3>
          <div className="tms-fgrid tms-fgrid--create">
            <VehicleFields
              t={t}
              f={f}
              set={set}
              errs={errs}
              section="fin"
              tenantName={tenantName}
              types={opts}
            />
          </div>
        </section>
      )}
    </FormDrawer>
  );
}
