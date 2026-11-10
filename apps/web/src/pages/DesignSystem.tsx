import {
  Badge,
  Button,
  Card,
  EmptyState,
  FilterChip,
  KpiCard,
  RouteChip,
  StatusTabs,
  Tag,
  TextInput,
  statusOf,
} from '@tms/ui';
import { th } from '../i18n/th';
import { useState } from 'react';
import { CompanySample } from '../features/companies/CompanySample';
import { useI18n } from '../i18n';
import { PageHeader } from '../shell/Header';

const PAL = [
  [
    'ds.pal.bg',
    [
      ['ds.pal.bg.0', '#F4F5F2'],
      ['ds.pal.bg.1', '#FFFFFF'],
      ['ds.pal.bg.2', '#EBEDE8'],
      ['ds.pal.bg.3', '#D9DCD4'],
      ['ds.pal.bg.4', '#C9CDC3'],
    ],
  ],
  [
    'ds.pal.navy',
    [
      ['ds.pal.navy.0', '#2257C4'],
      ['ds.pal.navy.1', '#2257C4'],
      ['ds.pal.navy.2', '#E9F0FA'],
      ['ds.pal.navy.3', '#EEF0EC'],
      ['ds.pal.navy.4', '#13213F'],
    ],
  ],
  [
    'ds.pal.amber',
    [
      ['ds.pal.amber.0', '#2257C4'],
      ['ds.pal.amber.1', '#8F5500'],
      ['ds.pal.amber.2', '#FCF0DC'],
    ],
  ],
  [
    'ds.pal.text',
    [
      ['ds.pal.text.0', '#101418'],
      ['ds.pal.text.1', '#3B424C'],
      ['ds.pal.text.2', '#3B424C'],
    ],
  ],
  [
    'ds.pal.st',
    [
      ['ds.pal.st.0', '#17733F'],
      ['ds.pal.st.1', '#8F5500'],
      ['ds.pal.st.2', '#B3322A'],
      ['ds.pal.st.3', '#2257C4'],
      ['ds.pal.st.4', '#3B424C'],
      ['ds.pal.st.5', '#FBE9E7'],
    ],
  ],
] as const;
const TYPE = [
  ['ds.type.0', '22px / 600', '22px', 600, 'ds.type.0.ex', '#101418'],
  ['ds.type.1', '15px / 600', '15px', 600, 'ds.type.1.ex', '#101418'],
  ['ds.type.2', '14px / 1.6', '14px', 400, 'ds.type.2.ex', '#101418'],
  ['ds.type.3', '13px / 500 · #3B424C', '13px', 500, 'ds.type.3.ex', '#3B424C'],
  ['ds.type.4', '32px / 600 tabular', '32px', 600, 'ds.type.4.ex', '#101418'],
  ['ds.type.5', '12px', '12px', 400, 'ds.type.5.ex', '#3B424C'],
  ['ds.type.6', 'IBM Plex Mono 13px', '13px', 500, 'ds.type.6.ex', '#101418'],
] as const;
const SO_STATUSES = [
  'status.so.received',
  'status.so.needRoute',
  'status.so.assigned',
  'status.so.inTransit',
  'status.so.delivered',
] as const;

/* สีของป้ายผูกกับข้อความไทยในต้นแบบ — หาโทนจาก th[k] เพื่อให้สีคงเดิมเมื่อสลับภาษา */

/** หน้า "ระบบดีไซน์" (เมนู ds ของต้นแบบ) — ใช้ตรวจ component และเป็นตัวอย่าง list → drawer → form (ST0-T14) */
export function DesignSystem() {
  const { t } = useI18n();
  const [tab, setTab] = useState('all');
  return (
    <>
      <PageHeader title={t('page.ds.title')} sub={t('page.ds.sub')} />
      <section
        className="tms-card"
        style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <h2 className="tms-card__h">{t('ds.colors')}</h2>
        {PAL.map(([g, items]) => (
          <div key={g} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="tms-label">{t(g)}</span>
            <div
              style={{ display: 'grid', gridTemplateColumns: 'repeat(6,minmax(0,1fr))', gap: 12 }}
            >
              {items.map(([n, h]) => (
                <div key={n} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div
                    style={{
                      height: 56,
                      borderRadius: 8,
                      border: '1px solid #D9DCD4',
                      background: h,
                    }}
                  />
                  <span style={{ fontSize: 13, color: '#101418', lineHeight: 1.35 }}>{t(n)}</span>
                  <span
                    style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12, color: '#3B424C' }}
                  >
                    {h}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>
      <section
        className="tms-card"
        style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        <h2 className="tms-card__h" style={{ margin: '0 0 8px' }}>
          {t('ds.type')}
        </h2>
        {TYPE.map(([n, spec, fs, fw, ex, c]) => (
          <div
            key={n}
            style={{
              display: 'grid',
              gridTemplateColumns: '200px 180px minmax(0,1fr)',
              gap: 16,
              alignItems: 'baseline',
              padding: '10px 0',
              borderBottom: '1px solid #EBEDE8',
            }}
          >
            <span style={{ fontWeight: 500 }}>{t(n)}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12, color: '#3B424C' }}>
              {spec}
            </span>
            <span
              style={{
                fontSize: fs,
                fontWeight: fw,
                color: c,
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1.35,
              }}
            >
              {t(ex)}
            </span>
          </div>
        ))}
      </section>
      <Card title={t('ds.buttons')}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button variant="primary" icon="truck">
            SO
          </Button>
          <Button variant="secondary" icon="upload">
            CSV
          </Button>
          <Button variant="ghost" icon="printer">
            PDF
          </Button>
          <Button variant="danger" icon="ban">
            SO
          </Button>
          <Button variant="primary" icon="truck" disabled>
            SO
          </Button>
        </div>
      </Card>
      <Card title={t('ds.input')}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 16 }}>
          <TextInput placeholder="SO-2611" />
          <TextInput defaultValue="SO-2611" autoFocus />
          <TextInput defaultValue="2,05" aria-invalid="true" />
          <TextInput defaultValue="C0001" disabled />
        </div>
      </Card>
      <Card title={t('ds.badges')}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '140px minmax(0,1fr)',
            gap: 12,
            alignItems: 'center',
          }}
        >
          <span className="tms-label">SO</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {SO_STATUSES.map((k) => (
              <Badge
                key={k}
                label={t(k)}
                {...(({ tone, icon }) => ({ tone, icon }))(statusOf(th[k]))}
              />
            ))}
          </div>
        </div>
      </Card>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 className="tms-card__h">{t('ds.kpi')}</h2>
        <div className="tms-kpis">
          <KpiCard label={t('table.all')} value="128" sub="—" />
          <KpiCard label="SO" value="24" tone="info" sub="—" onClick={() => {}} />
          <KpiCard
            label="SO"
            value="7"
            tone="warn"
            sub="—"
            onClick={() => {}}
            active
            activeLabel={t('table.all')}
          />
          <KpiCard label="DO" value="96" tone="ok" sub="—" />
          <KpiCard label="INV" value="3" tone="err" sub="—" />
        </div>
      </section>
      <Card title={t('ds.tabs')}>
        <StatusTabs
          items={[
            { key: 'all', label: t('table.all'), count: 12 },
            { key: 'a', label: 'SO', count: 5 },
            { key: 'b', label: 'DO', count: 2 },
          ]}
          value={tab}
          onChange={setTab}
        />
        <h2 className="tms-card__h" style={{ marginTop: 12 }}>
          {t('ds.chips')}
        </h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <RouteChip from="A" to="B" />
          <Tag>INV</Tag>
          <FilterChip label="ERP" onRemove={() => {}} removeLabel={t('drawer.close')} />
        </div>
        <h2 className="tms-card__h" style={{ marginTop: 12 }}>
          {t('ds.empty')}
        </h2>
        <EmptyState
          title={t('table.emptyTitle')}
          description={t('table.emptyDesc')}
          action={<Button variant="secondary">{t('table.clearFilters')}</Button>}
        />
      </Card>
      <Card title={t('ds.sample')}>
        <CompanySample />
      </Card>
    </>
  );
}
