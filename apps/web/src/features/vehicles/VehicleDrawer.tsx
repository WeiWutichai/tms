import { Badge, Drawer, DrawerFooterButtons, EmptyState } from '@tms/ui';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import { useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { HistoryTab } from '../master/HistoryTab';
import { fieldErrors, isStale, problemText } from '../master/problems';
import { VehicleFields, toDiff, toForm, validate, type VehicleForm } from './VehicleFields';
import {
  useUpdateVehicle,
  useVehicleTypeOptions,
  vehPlate,
  type Vehicle,
  type VehicleStatus,
} from './useVehicles';

export type VehTab = 'info' | 'docs' | 'act';

const BADGE: Record<VehicleStatus, MessageKey> = {
  ready: 'veh.st.ready',
  maintenance: 'veh.st.maintenance',
  parked: 'veh.st.parked',
  retired: 'veh.st.retired',
};
export function VehBadge({ v, t }: { v: Pick<Vehicle, 'status'>; t: T }) {
  return <Badge label={t(BADGE[v.status])} />;
}

/**
 * Drawer รถ (แก้ไข) — ต้นแบบ TMS v4 vPanel veh: หัว "รถ · {ประเภท}" + ทะเบียน + ป้ายสถานะ, แท็บ ข้อมูลรถ / เอกสารแนบ / กิจกรรม,
 * ฟอร์ม ทะเบียน · ประเภทรถ · เจ้าของ · ชื่อเจ้าของ · น้ำหนักบรรทุก · GPS · สถานะ + ปุ่มบันทึก
 * ช่องวันหมดอายุประกัน/ภาษี/พ.ร.บ. ของต้นแบบ = เอกสารรถ ST2-T17 (ยังไม่แสดง) [OPEN spec/12 §3]
 * เปลี่ยนสถานะผ่านช่อง "สถานะ" → dialog เหตุผล (POST /status — state machine)
 */
export function VehicleDrawer({
  v,
  canWrite,
  finance,
  tenantName,
  initialTab = 'info',
  onStatusChange,
  onDelete,
  onSaved,
  onClose,
}: {
  v: Vehicle;
  canWrite: boolean;
  finance: boolean;
  tenantName: string;
  initialTab?: VehTab;
  onStatusChange: (v: Vehicle, to: VehicleStatus) => void;
  onDelete: () => void;
  onSaved: (v: Vehicle) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const update = useUpdateVehicle();
  const types = useVehicleTypeOptions();
  const [tab, setTab] = useState<VehTab>(initialTab);
  const [base, setBase] = useState<VehicleForm>(() => toForm(v, t));
  const [f, setF] = useState<VehicleForm>(base);
  const [baseVersion, setBaseVersion] = useState(v.version);
  const [tried, setTried] = useState(false);
  const submitting = useRef(false);
  const ro = !canWrite || v.status === 'retired';

  const set = <K extends keyof VehicleForm>(k: K, val: VehicleForm[K]) =>
    setF((x) => ({ ...x, [k]: val }));
  const local = validate(f, t);
  const server = fieldErrors(update.error, t);
  if (
    update.error instanceof ApiError &&
    update.error.problem.errors?.some((e) => e.field === 'plate' && e.code === 'duplicate')
  )
    server.plate = t('veh.v.dup');
  const errs = { ...(tried ? local : {}), ...server };
  const stale = isStale(update.error);
  const top =
    update.error && !Object.keys(server).length && !stale ? problemText(update.error, t) : null;
  const opts = (types.data ?? []).map((x) => ({ id: x.id, name: x.name, payloadKg: x.payloadKg }));
  // ประเภทรถเดิมที่ถูกปิดใช้ภายหลัง — ยังแสดงในตัวเลือก
  if (!opts.some((o) => o.id === v.vehicleType.id))
    opts.unshift({ id: v.vehicleType.id, name: v.vehicleType.name, payloadKg: null });

  const reload = () => {
    const nf = toForm(v, t);
    setBase(nf);
    setF(nf);
    setBaseVersion(v.version);
    update.reset();
  };
  const d = toDiff(base, f, finance);
  const dirty = Object.keys(d).length > 0;
  // ถูกแก้จากที่อื่น (เปลี่ยนสถานะ/จับคู่จากอีกคัน) ระหว่างที่ฟอร์มยังไม่ได้แก้ → โหลดค่าใหม่เงียบ ๆ
  useEffect(() => {
    if (v.version !== baseVersion && !dirty) reload();
  }, [v.version]);

  const submit = () => {
    setTried(true);
    if (Object.keys(local).length || submitting.current || stale) return;
    const statusChanged = f.status !== v.status;
    if (!dirty) {
      if (statusChanged) onStatusChange(v, f.status);
      return;
    }
    submitting.current = true;
    update.mutate(
      { id: v.id, version: baseVersion, body: d },
      {
        onSuccess: (u) => {
          const nf = { ...toForm(u, t), status: f.status };
          setBase({ ...nf, status: u.status });
          setF(nf);
          setBaseVersion(u.version);
          onSaved(u);
          if (statusChanged) onStatusChange(u, f.status);
        },
        onSettled: () => {
          submitting.current = false;
        },
      },
    );
  };

  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('veh.kind', { t: v.vehicleType.name })}
      title={vehPlate(t, v)}
      badge={<VehBadge v={v} t={t} />}
      labels={{ close: t('drawer.close'), more: t('drawer.more') }}
      {...(canWrite
        ? {
            menu: [
              { label: t('veh.menu.delete'), icon: 'trash-2', danger: true, onClick: onDelete },
            ],
          }
        : {})}
      tabs={[
        { key: 'info', label: t('veh.tab.info') },
        { key: 'docs', label: t('veh.tab.docs') },
        { key: 'act', label: t('veh.tab.act') },
      ]}
      tab={tab}
      onTab={(k) => setTab(k as VehTab)}
      footer={
        canWrite && tab === 'info' && v.status !== 'retired' ? (
          <DrawerFooterButtons
            primary={{
              label: t('common.save'),
              icon: 'save',
              onClick: submit,
              disabled: update.isPending,
            }}
          />
        ) : undefined
      }
    >
      {stale && (
        <div className="tms-alert" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1 }}>{t('veh.stale')}</span>
          <button type="button" className="tms-textlink" onClick={reload}>
            {t('veh.reload')}
          </button>
        </div>
      )}
      {tried && Object.keys(local).length > 0 && (
        <div className="tms-alert">{t('form.incomplete', { n: Object.keys(local).length })}</div>
      )}
      {top && <div className="tms-alert">{top}</div>}
      {tab === 'info' && (
        <>
          {/* ต้นแบบ vPanel veh: สรุป "ข้อมูลเพิ่มเติม" (ฟิลด์เพิ่มเติม) + ลิงก์ "แก้ไข" ไปที่ช่องในฟอร์ม */}
          <section className="tms-kv">
            <span
              className="tms-kv__title"
              style={{ display: 'flex', justifyContent: 'space-between' }}
            >
              {t('veh.sec.extra')}
              {!ro && (
                <button
                  type="button"
                  className="tms-textlink"
                  onClick={() =>
                    document.querySelector<HTMLInputElement>('input[name="gpsId"]')?.focus()
                  }
                >
                  {t('common.edit')}
                </button>
              )}
            </span>
            <div className="tms-kv__grid">
              <div className="tms-kv__item">
                <span className="tms-kv__k">{t('veh.f.gpsId')}</span>
                <span className="tms-kv__v tms-num">{v.gpsDeviceId ?? '—'}</span>
              </div>
            </div>
          </section>
          <div className="tms-fgrid">
            <VehicleFields
              t={t}
              f={f}
              set={set}
              errs={errs}
              section="main"
              edit
              readOnly={ro}
              tenantName={tenantName}
              types={opts}
            />
          </div>
          <section className="tms-kv" style={{ borderBottom: 0, paddingBottom: 0 }}>
            <span className="tms-kv__title">{t('veh.sec.extra')}</span>
          </section>
          <div className="tms-fgrid">
            <VehicleFields
              t={t}
              f={f}
              set={set}
              errs={errs}
              section="extra"
              edit
              readOnly={ro}
              tenantName={tenantName}
              types={opts}
              selfId={v.id}
            />
          </div>
          {finance && (
            <>
              <section className="tms-kv" style={{ borderBottom: 0, paddingBottom: 0 }}>
                <span className="tms-kv__title">{t('veh.sec.fin')}</span>
              </section>
              <div className="tms-fgrid">
                <VehicleFields
                  t={t}
                  f={f}
                  set={set}
                  errs={errs}
                  section="fin"
                  edit
                  readOnly={ro}
                  tenantName={tenantName}
                  types={opts}
                />
              </div>
            </>
          )}
        </>
      )}
      {tab === 'docs' && (
        <EmptyState
          icon="file-text"
          title={t('veh.docs.empty')}
          description={t('veh.docs.emptyD')}
        />
      )}
      {tab === 'act' && (
        <HistoryTab
          path="/v1/vehicles/{id}/history"
          id={v.id}
          fieldLabel={(k) => fieldLabel(t, k)}
          fieldValue={(k, val) => fieldValue(t, k, val)}
        />
      )}
    </Drawer>
  );
}

const FIELD_KEYS: Record<string, MessageKey> = {
  plate: 'veh.f.plate',
  plateProvince: 'veh.f.prov',
  vehicleTypeId: 'veh.f.type',
  payloadKg: 'veh.f.cap',
  ownership: 'veh.f.own',
  carrierId: 'veh.f.ownN',
  gpsProvider: 'veh.f.gps',
  gpsDeviceId: 'veh.f.gpsId',
  status: 'veh.f.status',
  statusReason: 'veh.dlg.reason',
  unitRole: 'veh.f.role',
  pairedVehicleId: 'veh.f.pair',
  brand: 'veh.f.brand',
  model: 'veh.f.model',
  year: 'veh.f.year',
  color: 'veh.f.color',
  chassisNo: 'veh.f.vin',
  engineNo: 'veh.f.eng',
  tareWeightKg: 'veh.f.tare',
  grossWeightKg: 'veh.f.gross',
  volumeCbm: 'veh.f.vol',
  fuelType: 'veh.f.fuel',
  tankCapacityL: 'veh.f.tank',
  odometerKm: 'veh.f.odo',
  odometerSource: 'veh.f.odo',
  purchasedOn: 'veh.f.buyOn',
  purchaseCost: 'veh.f.cost',
  depreciationYears: 'veh.f.life',
  depreciationMethod: 'veh.f.life',
  salvageValue: 'veh.f.salvage',
  externalId: 'veh.f.ext',
  photoDocumentIds: 'veh.f.photos',
};
function fieldLabel(t: T, k: string): string {
  const key = FIELD_KEYS[k];
  return key ? t(key) : k;
}
function fieldValue(t: T, k: string, v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (k === 'status') return t(BADGE[v as VehicleStatus] ?? 'veh.st.ready');
  if (k === 'ownership') return t(v === 'OWN' ? 'veh.own.OWN' : 'veh.own.SUBCONTRACT');
  if (k === 'unitRole') return t(`veh.role.${v as 'SINGLE'}`);
  if (k === 'fuelType') return t(`veh.fuel.${v as 'DIESEL'}`);
  if (k === 'plateProvince') return t(`prov.${String(v)}` as MessageKey);
  return undefined;
}
