import { EmptyState, FormDrawer, Icon, ReasonDialog, useEscapeLayer } from '@tms/ui';
import { useId, useRef, useState } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import { problemText } from '../master/problems';
import { useDebounced } from '../master/useCursorList';
import type { TemplatePayload } from './orderForm';
import { useCreateTemplate, useDeleteTemplate, useTemplates, type OrderTemplate } from './useOrders';

/**
 * เทมเพลตงานประจำ (ST3-T02) — ต้นแบบไม่มีหน้าจอเทมเพลต [OPEN spec/12 §3] จึงประกอบจากชิ้นของต้นแบบ:
 * แผงรายการ = drawer ฟอร์ม (cfOpen) + การ์ดรายการ (ต้นแบบ "คู่กรณี") · ตั้งชื่อ = กล่องยืนยัน (CN) แบบช่องข้อความ
 * ลบ = ReasonDialog (เหตุผล ≥ 10 ตัวอักษร + audit) · ตั้งเวลาสร้างล่วงหน้า = P1 (ไม่ทำ)
 */
export function TemplatesDrawer({
  canWrite,
  onClose,
  onUse,
  onDeleted,
}: {
  canWrite: boolean;
  onClose: () => void;
  onUse: (tpl: OrderTemplate) => void;
  onDeleted: (name: string) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const q = useDebounced(text.trim().slice(0, 100), 250);
  const list = useTemplates(q, true);
  const del = useDeleteTemplate();
  const [delOf, setDelOf] = useState<OrderTemplate | null>(null);
  const rows = list.data?.data ?? [];
  const route = (p: TemplatePayload) =>
    p.stops
      .map((s) => s.siteText ?? '—')
      .filter(Boolean)
      .join(' → ');

  return (
    <>
      <FormDrawer
        open
        title={t('tpl.title')}
        subtitle={t('tpl.sub')}
        onClose={onClose}
        closeLabel={t('drawer.close')}
        footer={
          <button type="button" className="tms-fdrawer__cancel" onClick={onClose}>
            {t('drawer.close')}
          </button>
        }
      >
        <input
          className="tms-input"
          type="search"
          value={text}
          maxLength={100}
          placeholder={t('tpl.search')}
          aria-label={t('tpl.search')}
          onChange={(e) => setText(e.target.value)}
          style={{ height: 40, padding: '0 12px', width: '100%', boxSizing: 'border-box' }}
        />
        {list.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('tpl.loadError')}
            description={problemText(list.error, t) ?? ''}
          />
        ) : list.isLoading ? (
          <span style={{ color: '#59606B' }}>{t('table.loading')}</span>
        ) : !rows.length ? (
          <EmptyState
            icon={q ? 'search-x' : 'bookmark'}
            title={q ? t('table.emptyTitle') : t('tpl.emptyTitle')}
            description={q ? t('table.noMatch') : t('tpl.emptyDesc')}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map((r) => (
              <div
                key={r.id}
                data-testid="tpl-row"
                style={{
                  background: '#F7F8F5',
                  border: '1px solid #E4E6E0',
                  borderRadius: 12,
                  padding: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{r.name}</span>
                  <span style={{ color: '#3B424C', overflowWrap: 'anywhere' }}>
                    {r.customer?.legalName ?? t('tpl.noCustomer')}
                  </span>
                  <span style={{ fontSize: 12.5, color: '#59606B', overflowWrap: 'anywhere' }}>
                    {route(r.payload)}
                  </span>
                </div>
                {canWrite && (
                  <button
                    type="button"
                    className="tms-linkbtn"
                    style={{ color: '#B3322A' }}
                    onClick={() => setDelOf(r)}
                  >
                    {t('ord.remove')}
                  </button>
                )}
                {canWrite && (
                  <button
                    type="button"
                    className="tms-drawer__sec"
                    style={{ height: 32, padding: '0 12px' }}
                    onClick={() => onUse(r)}
                  >
                    {t('tpl.use')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </FormDrawer>
      <ReasonDialog
        open={!!delOf}
        title={delOf ? t('tpl.delT', { n: delOf.name }) : ''}
        description={t('tpl.delD')}
        label={t('cust.dlg.reason')}
        placeholder={t('cust.dlg.reasonPh')}
        okLabel={t('ord.remove')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={del.isPending}
        error={problemText(del.error, t)}
        onClose={() => {
          setDelOf(null);
          del.reset();
        }}
        onOk={(reason) => {
          if (!delOf) return;
          const x = delOf;
          del.mutate(
            { id: x.id, version: x.version, reason },
            {
              onSuccess: () => {
                setDelOf(null);
                onDeleted(x.name);
              },
            },
          );
        }}
      />
    </>
  );
}

/** ตั้งชื่อแล้วบันทึกใบนี้เป็นเทมเพลต (payload = ข้อมูลฟอร์มของใบ ไม่รวมราคา/สถานะ/externalId) */
export function SaveTemplateDialog({
  payload,
  defaultName,
  onClose,
  onSaved,
}: {
  payload: TemplatePayload;
  defaultName: string;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const create = useCreateTemplate();
  const [name, setName] = useState(defaultName);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const sent = useRef(false);
  useEscapeLayer(true, onClose);
  const dup =
    create.error instanceof ApiError && create.error.problem.code === 'duplicate'
      ? t('tpl.dup')
      : null;
  const errText = dup ?? (create.error ? problemText(create.error, t) : null);
  const ok = name.trim().length > 0 && name.trim().length <= 100 && !create.isPending;
  const submit = () => {
    if (!ok || sent.current) return;
    sent.current = true;
    create.mutate(
      { idempotencyKey: idemKey, body: { name: name.trim(), payload } },
      {
        onSuccess: () => onSaved(name.trim()),
        onError: () => setIdemKey(crypto.randomUUID()),
        onSettled: () => {
          sent.current = false;
        },
      },
    );
  };
  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <form
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 id={`${id}-t`} className="tms-dialog__title">
              {t('tpl.saveT')}
            </h2>
            <p className="tms-dialog__desc">{t('tpl.saveD')}</p>
          </div>
          <button
            type="button"
            className="tms-drawer__iconbtn"
            aria-label={t('drawer.close')}
            title={t('drawer.close')}
            onClick={onClose}
          >
            <Icon n="x" s={18} />
          </button>
        </div>
        <div className="tms-dialog__body">
          <label className="tms-field" htmlFor={id}>
            <span className="tms-label">
              {t('tpl.name')} <span style={{ color: '#B3322A' }}>*</span>
            </span>
            <input
              id={id}
              className="tms-input"
              value={name}
              maxLength={100}
              autoFocus
              aria-invalid={!!errText}
              onChange={(e) => {
                setName(e.target.value);
                if (create.error) create.reset();
              }}
              style={{ height: 40, padding: '0 12px' }}
            />
          </label>
          {errText && <span className="tms-field-error">{errText}</span>}
        </div>
        <div className="tms-dialog__foot">
          <button type="button" className="tms-dialog__cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="tms-drawer__pri"
            style={{ height: 36, padding: '0 16px' }}
            disabled={!ok}
          >
            <Icon n="bookmark-plus" s={16} />
            {t('tpl.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
