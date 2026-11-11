import { Button, EmptyState, Icon, statusOf, Toast, tone } from '@tms/ui';
import { useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api';
import { formatDate, formatMoney, useI18n } from '../../i18n';
import { can } from '../../nav';
import { NotFound } from '../../pages/Simple';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { problemText } from '../master/problems';
import { VehicleActionDialog, type VehicleDialog } from './VehicleActionDialog';
import { VehicleDocsTab } from './VehicleDocsTab';
import { VehicleDrawer } from './VehicleDrawer';
import { useVehicle, vehPlate, type Vehicle } from './useVehicles';

type ProfTab = 'info' | 'docs';
const num = (n: number) => n.toLocaleString('th-TH');

/** เงิน (สตางค์, จำนวนเต็ม) — คำนวณค่าเสื่อมไม่ใช้ทศนิยม float */
const satang = (s: string) => {
  const [w = '0', f = ''] = s.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0').slice(0, 2));
};
const baht = (n: number) =>
  formatMoney(`${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`);

/**
 * ค่าเสื่อมเส้นตรง (วิธีเดียวที่รถมี — `depreciationMethod` STRAIGHT_LINE ของ ST2-T06):
 * ต่อปี = (ราคาซื้อ − มูลค่าซาก) ÷ อายุ (ปี) · มูลค่าตามบัญชี = ราคาซื้อ − ต่อปี × ปีที่ผ่านไป (ไม่ต่ำกว่ามูลค่าซาก)
 * ใช้แสดงผลในโปรไฟล์เท่านั้น — ไม่ใช่ตัวเลขทางบัญชี/ภาษี
 */
export function depreciation(
  v: Pick<Vehicle, 'purchaseCost' | 'salvageValue' | 'depreciationYears' | 'purchasedOn'>,
  today: string,
): { perYear: string; book: string } | null {
  if (!v.purchaseCost || !v.depreciationYears || !v.purchasedOn) return null;
  const cost = satang(v.purchaseCost);
  const salvage = v.salvageValue ? satang(v.salvageValue) : 0;
  const perYear = Math.round((cost - salvage) / v.depreciationYears);
  const days = Math.max(
    0,
    Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${v.purchasedOn}T00:00:00Z`)) / 864e5,
    ),
  );
  const book = Math.max(salvage, cost - Math.round((perYear * days) / 365));
  return { perYear: baht(perYear), book: baht(book) };
}

const todayTh = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

/**
 * รถ → โปรไฟล์รถ (ST2-T07) — ต้นแบบ TMS v4 `is.fprof` / vFProf():
 * ปุ่มกลับ "ทะเบียนรถ" · การ์ดหัว (รูปรถ · ทะเบียน + สถานะ · ยี่ห้อรุ่นปี · ประเภท/เจ้าของ/เลขไมล์ · แก้ไข/เปิดใบสั่งซ่อม)
 * · แท็บ ข้อมูล (4 กลุ่ม) / เอกสาร (ตาราง pr.docs + ต่ออายุ)
 * ไม่ทำในเฟสนี้ (P1 — docs/04 B2.1/B2.2): KPI กม./ลิตร ต้นทุน/กม. Utilization กำไร, แท็บ ซ่อมบำรุง/ยาง/น้ำมัน/เลขไมล์/เช่าซื้อ/ต้นทุน/ประวัติ (timeline)
 * [OPEN spec/12 §3] · "แก้ไข" เปิด drawer รถเดิม (vPanel veh) ทับหน้านี้ตามต้นแบบ pr.edit
 */
export function VehicleProfilePage() {
  const { t, lang } = useI18n();
  const { id = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canWrite = can(scopes, 'master:write');
  const finance = can(scopes, 'reports.finance:read');
  const tenantName = me.data?.tenant.name ?? '';
  const ys = (me.data?.tenant.yearStyle as 'BE' | 'CE') ?? 'BE';
  const q = useVehicle(id);
  const tab: ProfTab = sp.get('tab') === 'docs' ? 'docs' : 'info';
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<VehicleDialog | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const back = () => navigate('/fleet/vehicles');

  if (q.error instanceof ApiError && q.error.problem.status === 404) return <NotFound />;
  const v = q.data;

  const header = (
    <PageHeader
      title={t('page.fprof.title')}
      actions={
        <>
          {/* ใบสั่งซ่อม / อุบัติเหตุ = P1 — แสดงตามต้นแบบแต่ยังกดไม่ได้ [OPEN spec/12 §3] */}
          <Button variant="secondary" icon="wrench" disabled title={t('veh.woSoon')}>
            {t('veh.newWo')}
          </Button>
          <Button variant="secondary" icon="siren" disabled title={t('vprof.accSoon')}>
            {t('vprof.acc')}
          </Button>
        </>
      }
    />
  );
  const backBtn = (
    <button type="button" className="tms-vprof__back" onClick={back}>
      <Icon n="arrow-left" s={16} />
      {t('page.fveh.title')}
    </button>
  );

  if (!v)
    return (
      <>
        {header}
        {backBtn}
        {q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('veh.loadError')}
            description={problemText(q.error, t) ?? ''}
            action={
              <Button variant="secondary" icon="refresh-cw" onClick={() => q.refetch()}>
                {t('veh.retry')}
              </Button>
            }
          />
        ) : (
          <div className="tms-vprof__card tms-vprof__head" aria-busy="true">
            <div className="tms-vprof__photo" />
            <div className="tms-vprof__title">
              <div className="tms-vprof__skel" style={{ width: 200, height: 32 }} />
              <div className="tms-vprof__skel" style={{ width: 160 }} />
            </div>
          </div>
        )}
      </>
    );

  const dt = (iso: string | null | undefined) =>
    iso ? formatDate(new Date(`${iso.slice(0, 10)}T00:00:00`), lang, ys) : '—';
  const unit = (n: number | null, k: 'veh.unit.kg' | 'veh.unit.l' | 'veh.unit.km') =>
    n === null ? '—' : t(k, { n: num(n) });
  const brandModel = [v.brand, v.model].filter(Boolean).join(' ');
  const name = [brandModel || null, v.year !== null ? t('veh.year', { y: v.year }) : null]
    .filter(Boolean)
    .join(' · ');
  const ownLabel = t(v.ownership === 'OWN' ? 'veh.own.OWN' : 'veh.own.SUBCONTRACT');
  const ownName = v.ownership === 'OWN' ? tenantName : (v.carrier?.name ?? '');
  const pair =
    v.paired && v.unitRole !== 'SINGLE'
      ? t(v.unitRole === 'TRACTOR' ? 'veh.pair.TRACTOR' : 'veh.pair.TRAILER', {
          p: vehPlate(t, v.paired),
        })
      : null;
  const sub = [v.vehicleType.name, pair, `${ownLabel} ${ownName}`.trim()]
    .filter(Boolean)
    .join(' · ');
  const dep = finance ? depreciation(v, todayTh()) : null;
  const stLabel = t(`veh.st.${v.status}`);

  const groups: { t: string; rows: [string, ReactNode, boolean?][] }[] = [
    {
      t: t('vprof.g.body'),
      rows: [
        [t('vprof.k.brandModel'), brandModel || '—'],
        [t('vprof.k.year'), v.year ?? '—'],
        [t('veh.f.vin'), v.chassisNo ?? '—', true],
        [t('veh.f.eng'), v.engineNo ?? '—', true],
        [t('veh.col.type'), v.vehicleType.name],
        [
          t(v.unitRole === 'TRAILER' ? 'vprof.k.tractor' : 'vprof.k.trailer'),
          v.paired ? vehPlate(t, v.paired) : '—',
        ],
      ],
    },
    {
      t: t('vprof.g.weight'),
      rows: [
        [t('vprof.k.cap'), unit(v.payloadKg, 'veh.unit.kg')],
        [t('vprof.k.tare'), unit(v.tareWeightKg, 'veh.unit.kg')],
        [t('veh.f.fuel'), v.fuelType ? t(`veh.fuel.${v.fuelType}`) : '—'],
        [t('vprof.k.tank'), unit(v.tankCapacityL, 'veh.unit.l')],
        // ค่ามาตรฐาน กม./ลิตร = งานน้ำมัน (P1) [OPEN spec/12 §3]
        [t('vprof.k.kmpl'), '—'],
      ],
    },
    ...(finance
      ? [
          {
            t: t('veh.sec.fin'),
            rows: [
              [t('veh.f.buyOn'), dt(v.purchasedOn)],
              [t('vprof.k.cost'), v.purchaseCost ? formatMoney(v.purchaseCost) : '—', true],
              [t('vprof.k.depYear'), dep?.perYear ?? '—', true],
              [t('vprof.k.book'), dep?.book ?? '—', true],
            ] as [string, ReactNode, boolean?][],
          },
        ]
      : []),
    {
      t: t('vprof.g.gps'),
      rows: [
        [t('veh.f.gps'), v.gpsProvider ?? '—'],
        [t('vprof.k.dlt'), v.gpsDeviceId ?? '—', true],
        [t('veh.col.own'), ownName ? `${ownLabel} · ${ownName}` : ownLabel],
        // คนขับประจำ = ST2-T08 (คนขับ) [OPEN spec/12 §3]
        [t('vprof.k.driver'), '—'],
        [t('vprof.k.odo'), unit(v.odometerKm, 'veh.unit.km'), true],
      ],
    },
  ];

  return (
    <>
      {header}
      {backBtn}
      <div className="tms-vprof__card tms-vprof__head" data-testid="vprof-head">
        <div className="tms-vprof__photo">
          <Icon n="truck" s={40} style={{ color: '#C9CDC3' }} />
          <span>{t('vprof.photo')}</span>
        </div>
        <div className="tms-vprof__title">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span className="tms-vprof__plate">{vehPlate(t, v)}</span>
            {/* ต้นแบบ pr.b: ป้ายไม่มีไอคอน */}
            <span
              className="tms-vdoc__pill"
              data-testid="vprof-status"
              style={{
                background: tone[statusOf(stLabel).tone].bg,
                color: tone[statusOf(stLabel).tone].c,
              }}
            >
              {stLabel}
            </span>
          </div>
          <span style={{ fontSize: 16, fontWeight: 500 }}>{name || '—'}</span>
          <span style={{ color: '#3B424C' }}>
            {sub} · {t('vprof.odo')}{' '}
            <span className="tms-num" style={{ fontSize: 13, color: '#101418' }}>
              {v.odometerKm === null ? '—' : num(v.odometerKm)}
            </span>{' '}
            {t('vprof.km')}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignSelf: 'start' }}>
          {canWrite && (
            <Button variant="secondary" icon="pencil" onClick={() => setEditing(true)}>
              {t('common.edit')}
            </Button>
          )}
          <Button variant="primary" icon="wrench" disabled title={t('veh.woSoon')}>
            {t('veh.newWo')}
          </Button>
        </div>
      </div>
      <div className="tms-vprof__card tms-vprof__body">
        <div className="tms-vprof__tabs" role="tablist">
          {(['info', 'docs'] as ProfTab[]).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              className="tms-vprof__tab"
              onClick={() => setSp(k === 'info' ? {} : { tab: k }, { replace: true })}
            >
              {t(k === 'info' ? 'vprof.tab.info' : 'vprof.tab.docs')}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {tab === 'info' && (
            <div className="tms-vprof__info" data-testid="vprof-info">
              {groups.map((g) => (
                <div key={g.t} className="tms-vprof__grp">
                  <div className="tms-vprof__grpt">{g.t}</div>
                  {g.rows.map(([k, val, small]) => (
                    <div key={k} className="tms-vprof__kv">
                      <span>{k}</span>
                      <span
                        className={small ? 'tms-num' : undefined}
                        style={{ fontSize: small ? 13 : 14 }}
                      >
                        {val}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {tab === 'docs' && <VehicleDocsTab v={v} canWrite={canWrite} layout="table" />}
        </div>
      </div>
      {editing && (
        <VehicleDrawer
          key={v.id}
          v={v}
          canWrite={canWrite}
          finance={finance}
          tenantName={tenantName}
          onStatusChange={(x, to) => setDialog({ kind: 'status', v: x, to })}
          onDelete={() => setDialog({ kind: 'delete', v })}
          onSaved={(u) => setToast(t('veh.toast.saved', { n: vehPlate(t, u) }))}
          onClose={() => setEditing(false)}
        />
      )}
      <VehicleActionDialog
        dialog={dialog}
        onClose={() => setDialog(null)}
        onDone={(d) => {
          setDialog(null);
          if (d.kind === 'delete') back();
          else setToast(t('veh.toast.status', { n: vehPlate(t, d.v) }));
        }}
      />
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </>
  );
}
