import { Icon } from '@tms/ui';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, unwrap } from '../../api';
import { useI18n } from '../../i18n';
import { th } from '../../i18n/th';
import type { MessageKey } from '../../i18n/th';
import type { components } from '@tms/contracts';

type ImportDto = components['schemas']['ImportDto'];
type KindDto = components['schemas']['ImportKindDto'];

const has = (k: string) => k in th;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_BYTES = 10 * 1024 * 1024;
const BLUE = '#2257C4';

/**
 * Wizard นำเข้าจาก Excel (ST1-T19) — ต้นแบบ TMS v4 `vWiz`: modal 760, 3 ขั้น อัปโหลดไฟล์ → จับคู่คอลัมน์ → ผลลัพธ์
 * ขั้น 1 อัปโหลดแล้วตรวจ (dry-run) ทันที · ขั้น 2 เปลี่ยนการจับคู่ = ตรวจใหม่, แถวพื้นแดง = ตรวจไม่ผ่าน ·
 * ปุ่ม "นำเข้า N แถว" = ยืนยัน (นำเข้าเฉพาะแถวที่ผ่าน — ต้นแบบแสดงแถวผิดในผลลัพธ์) · ขั้น 3 สรุป + ดาวน์โหลดแถวที่ผิด
 * ข้อความ error ของไฟล์/ระหว่างรอ job ไม่มีในต้นแบบ — [OPEN] spec/12 §3
 */
export function ImportWizard({
  kind,
  onClose,
}: {
  kind: KindDto;
  /** done = นำเข้าแล้วกี่แถว (null = ยกเลิก) */
  /** done = แถวที่นำเข้า (null = ยังไม่นำเข้า) · entities = จำนวนรายการเมื่อ 1 รายการมีหลายแถว (order: ใบ) */
  onClose: (done: number | null, entities?: number | null) => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState(1);
  const [imp, setImp] = useState<ImportDto | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => dialog.current?.focus(), []);

  // ข้อความไทยจาก code (message ของ API เป็นภาษาอังกฤษ)
  const problem = (e: unknown) => {
    if (!(e instanceof ApiError)) return t('problem.internal_error');
    const f = e.problem.errors?.[0]?.code;
    return f && has(`field.${f}`)
      ? t(`field.${f}` as MessageKey)
      : t(`problem.${e.problem.code}` as MessageKey);
  };

  // งานใหญ่วิ่งเป็น job — ถามสถานะทุก 1.5 วินาทีจนเสร็จ
  useEffect(() => {
    if (!imp || (imp.status !== 'validating' && imp.status !== 'importing')) return;
    const h = setTimeout(async () => {
      const r = await api
        .GET('/v1/imports/{id}', { params: { path: { id: imp.id } } })
        .catch(() => null);
      // เรียกไม่สำเร็จ → ลองใหม่รอบหน้า (object ใหม่ให้ effect ตั้งเวลาอีกครั้ง)
      setImp(r?.data ?? { ...imp });
    }, 1500);
    return () => clearTimeout(h);
  }, [imp]);

  async function pick(f: File | undefined) {
    if (!f) return;
    setError(null);
    const mime = /\.csv$/i.test(f.name) ? 'text/csv' : /\.xlsx$/i.test(f.name) ? XLSX : null;
    if (!mime) return setError(t('imp.badType'));
    if (f.size > MAX_BYTES) return setError(t('imp.tooLarge'));
    setFile(f);
    setImp(null);
    setBusy(true);
    try {
      const doc = await unwrap(
        api.POST('/v1/documents', {
          body: { kind: 'IMPORT', mime, bytes: f.size, filename: f.name },
        }),
      );
      const u = new URL(doc.uploadUrl!, location.origin);
      const up = await fetch(u.pathname + u.search, { method: 'PUT', body: f });
      if (!up.ok) throw new ApiError((await up.json()) as never);
      const r = await unwrap(
        api.POST('/v1/imports', {
          body: { kind: kind.kind, documentId: doc.id, errorPolicy: 'skip_invalid_rows' },
        }),
      );
      setImp(r);
    } catch (e) {
      setError(problem(e));
      setFile(null);
    } finally {
      setBusy(false);
    }
  }

  async function remap(key: string, header: string) {
    if (!imp) return;
    setBusy(true);
    setError(null);
    try {
      const mapping = { ...imp.mapping, [key]: header };
      if (!header) delete mapping[key];
      setImp(
        await unwrap(
          api.PATCH('/v1/imports/{id}', { params: { path: { id: imp.id } }, body: { mapping } }),
        ),
      );
    } catch (e) {
      setError(problem(e));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!imp) return;
    setBusy(true);
    setError(null);
    try {
      const r = await unwrap(
        api.POST('/v1/imports/{id}/commit', { params: { path: { id: imp.id } } }),
      );
      setImp(r);
      // ตรวจซ้ำแล้วพบแถวผิด (ข้อมูลเปลี่ยนระหว่างรอ) → ไม่ได้นำเข้า อยู่ขั้น 2 ต่อ
      if (r.status === 'validated') setError(t('problem.import_has_errors'));
      else setStep(3);
    } catch (e) {
      setError(problem(e));
    } finally {
      setBusy(false);
    }
  }

  async function download(path: 'template' | 'errors') {
    const r =
      path === 'template'
        ? await api.GET('/v1/imports/kinds/{kind}/template', {
            params: { path: { kind: kind.kind } },
            parseAs: 'blob',
          })
        : await api.GET('/v1/imports/{id}/errors', {
            params: { path: { id: imp!.id } },
            parseAs: 'blob',
          });
    if (!r.data) return setError(t('problem.internal_error'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(r.data as Blob);
    a.download =
      path === 'template'
        ? `${t('imp.template')}-${kind.label}.xlsx`
        : `${t('imp.downloadErrors')}-${kind.label}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  }

  const ready = !!imp && imp.status === 'validated';
  const done = !!imp && (imp.status === 'completed' || imp.status === 'completed_with_errors');
  // ปิดระหว่างทำงานไม่ได้ · ปิดก่อนนำเข้า = ทิ้งผลตรวจไว้ (หมดอายุเองใน 24 ชม.; ยกเลิกต้องมีเหตุผล)
  const close = () => {
    if (busy) return;
    // นำเข้าเสร็จแล้วเท่านั้นจึงบอกจำนวน (ปิดระหว่าง job ยังวิ่ง = งานทำต่อ + แจ้งเตือนเมื่อเสร็จ)
    onClose(done ? imp!.importedRows : null, done ? imp!.importedEntities : null);
  };

  const canNext =
    step === 1 ? ready && !busy : step === 2 ? ready && !busy && imp!.okRows > 0 : done;
  const next = () => {
    if (!canNext) return;
    if (step === 1) setStep(2);
    else if (step === 2) void commit();
    else onClose(imp!.importedRows, imp!.importedEntities);
  };
  const steps = [t('imp.step1'), t('imp.step2'), t('imp.step3')];
  const priL =
    step === 1
      ? t('imp.next')
      : step === 2
        ? t('imp.importN', { n: imp?.okRows ?? 0 })
        : t('imp.finish');
  const errRows = imp ? groupErrors(imp) : [];
  const fileErr =
    imp?.status === 'failed'
      ? (imp.fileError ?? t('problem.internal_error'))
      : imp?.status === 'expired'
        ? t('problem.import_expired')
        : null;

  return (
    <div
      onClick={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(10,23,52,.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="imp-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 760,
          maxWidth: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: '#FFFFFF',
          border: '1px solid #D9DCD4',
          borderRadius: 20,
          boxShadow: '0 18px 44px rgba(10,23,52,.10)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            padding: '20px 24px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            borderBottom: '1px solid #E4E6E0',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <h2 id="imp-title" style={{ margin: 0, fontSize: 15, fontWeight: 600, flex: 1 }}>
              {t('imp.title', { kind: kind.label })}
            </h2>
            <button
              type="button"
              aria-label={t('notify.close')}
              onClick={close}
              style={{
                width: 32,
                height: 32,
                border: 0,
                borderRadius: 999,
                background: 'transparent',
                color: '#3B424C',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon n="x" s={18} />
            </button>
          </div>
          <ol
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              margin: 0,
              padding: 0,
              listStyle: 'none',
            }}
          >
            {steps.map((l, i) => {
              const n = i + 1;
              const isDone = n < step;
              const cur = n === step;
              return (
                <li
                  key={l}
                  aria-current={cur ? 'step' : undefined}
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <span
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      border: `1.5px solid ${isDone || cur ? BLUE : '#C9CDC3'}`,
                      background: isDone ? BLUE : '#FFFFFF',
                      color: isDone ? '#FFFFFF' : cur ? BLUE : '#3B424C',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {isDone ? <Icon n="check" s={14} /> : n}
                  </span>
                  <span
                    style={{
                      color: isDone || cur ? '#101418' : '#3B424C',
                      fontWeight: cur ? 600 : 500,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {l}
                  </span>
                  {n < 3 && (
                    <span
                      style={{ width: 32, height: 2, background: n < step ? BLUE : '#D9DCD4' }}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </div>

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {step === 1 && (
            <>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDrag(false);
                  void pick(e.dataTransfer.files[0]);
                }}
                style={{
                  border: `1.5px dashed ${drag ? BLUE : '#C9CDC3'}`,
                  borderRadius: 14,
                  padding: 32,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8,
                  textAlign: 'center',
                }}
              >
                <Icon n="file-spreadsheet" s={40} style={{ color: '#C9CDC3' }} />
                <span style={{ fontWeight: 600 }}>{t('imp.drop')}</span>
                <span style={{ color: '#3B424C' }}>{t('imp.dropHint')}</span>
                <input
                  ref={input}
                  type="file"
                  accept=".xlsx,.csv"
                  hidden
                  data-testid="imp-file"
                  onChange={(e) => {
                    void pick(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => input.current?.click()}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 32,
                    padding: '0 12px',
                    border: '1px solid #9DB6E3',
                    borderRadius: 999,
                    background: '#FFFFFF',
                    color: BLUE,
                    fontWeight: 500,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    marginTop: 6,
                  }}
                >
                  <Icon n="folder-open" s={16} />
                  {t('imp.pick')}
                </button>
              </div>
              {file && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    border: '1px solid #D9DCD4',
                    borderRadius: 8,
                  }}
                >
                  <Icon n="file-spreadsheet" s={18} style={{ color: '#17733F' }} />
                  <span style={{ flex: 1 }}>{file.name}</span>
                  <span style={{ color: '#3B424C' }}>
                    {ready
                      ? t('imp.fileMeta', {
                          n: imp!.totalRows.toLocaleString('th-TH'),
                          kb: Math.max(1, Math.round(file.size / 1024)),
                        })
                      : busy || imp?.status === 'validating'
                        ? t('imp.checking')
                        : ''}
                  </span>
                  {ready && <Icon n="check" s={16} style={{ color: '#17733F' }} />}
                </div>
              )}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  void download('template');
                }}
                style={{ fontWeight: 500, alignSelf: 'flex-start' }}
              >
                {t('imp.template')}
              </a>
            </>
          )}

          {step === 2 && imp && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t('imp.mapTitle')}</h3>
                <div style={{ border: '1px solid #D9DCD4', borderRadius: 8, overflow: 'hidden' }}>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      background: '#EBEDE8',
                      fontSize: 12.5,
                      fontWeight: 500,
                      color: '#3B424C',
                    }}
                  >
                    <span style={{ padding: '8px 12px' }}>{t('imp.mapField')}</span>
                    <span style={{ padding: '8px 12px' }}>{t('imp.mapColumn')}</span>
                  </div>
                  {kind.columns.map((c) => (
                    <div
                      key={c.key}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        alignItems: 'center',
                        borderTop: '1px solid #D9DCD4',
                      }}
                    >
                      <span style={{ padding: '8px 12px' }}>{c.header}</span>
                      <span style={{ padding: '6px 8px' }}>
                        <select
                          aria-label={c.header}
                          value={imp.mapping[c.key] ?? ''}
                          disabled={busy}
                          onChange={(e) => void remap(c.key, e.target.value)}
                          style={{
                            width: '100%',
                            height: 32,
                            padding: '0 6px',
                            border: '1px solid #C9CDC3',
                            borderRadius: 6,
                            background: '#FFFFFF',
                          }}
                        >
                          <option value="">{t('imp.noMap')}</option>
                          {imp.headers.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t('imp.sample')}</h3>
                <div style={{ border: '1px solid #D9DCD4', borderRadius: 8, overflow: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
                    <thead>
                      <tr>
                        {kind.columns.map((c) => (
                          <th
                            key={c.key}
                            style={{
                              background: '#F4F5F2',
                              height: 40,
                              padding: '0 12px',
                              borderBottom: '1px solid #E4E6E0',
                              textAlign: 'left',
                              fontSize: 12.5,
                              fontWeight: 500,
                              color: '#3B424C',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {c.header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {imp.sample.map((r) => (
                        <tr
                          key={r.row}
                          data-error={r.error || undefined}
                          style={{ background: r.error ? '#FBE9E7' : '#FFFFFF' }}
                        >
                          {kind.columns.map((c) => (
                            <td
                              key={c.key}
                              style={{
                                height: 44,
                                padding: '0 12px',
                                borderBottom: '1px solid #E4E6E0',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {r.values[c.key]}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <span style={{ fontSize: 13, color: '#3B424C' }}>{t('imp.sampleNote')}</span>
              </div>
            </>
          )}

          {step === 3 && imp && (
            <>
              {done ? (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <Stat n={imp.importedRows} color="#17733F" label={t('imp.ok')} />
                    <Stat n={imp.errorRows} color="#B3322A" label={t('imp.bad')} />
                  </div>
                  {errRows.length > 0 && (
                    <>
                      <div
                        style={{ border: '1px solid #D9DCD4', borderRadius: 8, overflow: 'hidden' }}
                      >
                        {errRows.map((e) => (
                          <div
                            key={e.row}
                            style={{
                              display: 'flex',
                              gap: 12,
                              padding: '10px 12px',
                              borderBottom: '1px solid #E4E6E0',
                              background: '#FBE9E7',
                            }}
                          >
                            <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                              {t('imp.row', { n: e.row })}
                            </span>
                            <span>{e.msg}</span>
                          </div>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => void download('errors')}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          height: 32,
                          padding: '0 12px',
                          border: '1px solid #9DB6E3',
                          borderRadius: 999,
                          background: '#FFFFFF',
                          color: BLUE,
                          fontWeight: 500,
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                          alignSelf: 'flex-start',
                        }}
                      >
                        <Icon n="download" s={16} />
                        {t('imp.downloadErrors')}
                      </button>
                    </>
                  )}
                </>
              ) : (
                <span style={{ color: '#3B424C' }}>{t('imp.importing')}</span>
              )}
            </>
          )}

          {(error || fileErr) && (
            <span role="alert" style={{ color: '#B3322A', fontSize: 13 }}>
              {error ?? fileErr}
            </span>
          )}
        </div>

        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid #D9DCD4',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          {step < 3 && (
            <button
              type="button"
              onClick={() => (step > 1 ? setStep(step - 1) : close())}
              style={{
                height: 36,
                padding: '0 14px',
                border: '1px solid transparent',
                borderRadius: 999,
                background: 'transparent',
                color: '#3B424C',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              {step > 1 ? t('imp.back') : t('imp.cancel')}
            </button>
          )}
          <button
            type="button"
            onClick={next}
            aria-disabled={!canNext}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              height: 36,
              padding: '0 16px',
              border: `1px solid ${BLUE}`,
              borderRadius: 999,
              background: BLUE,
              color: '#FFFFFF',
              fontWeight: 500,
              cursor: canNext ? 'pointer' : 'not-allowed',
              whiteSpace: 'nowrap',
              opacity: canNext ? 1 : 0.5,
            }}
          >
            {priL}
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ n, color, label }: { n: number; color: string; label: string }) {
  return (
    <div style={{ border: '1px solid #D9DCD4', borderRadius: 8, padding: '14px 16px' }}>
      <div style={{ fontSize: 28, fontWeight: 600, color, fontVariantNumeric: 'tabular-nums' }}>
        {n.toLocaleString('th-TH')}
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 500, color: '#3B424C' }}>{label}</div>
    </div>
  );
}

/** ปัญหาระดับ error รวมต่อแถว (แสดงไม่เกิน 50 แถว — ที่เหลืออยู่ในไฟล์ดาวน์โหลด) */
function groupErrors(imp: ImportDto) {
  const m = new Map<number, string[]>();
  for (const x of imp.issues)
    if (x.severity === 'error')
      m.set(x.row, [...(m.get(x.row) ?? []), x.column ? `${x.column}: ${x.message}` : x.message]);
  return [...m.entries()].slice(0, 50).map(([row, msgs]) => ({ row, msg: msgs.join(' · ') }));
}
