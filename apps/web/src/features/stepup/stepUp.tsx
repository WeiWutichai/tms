import { useEscapeLayer, useModalFocus } from '@tms/ui';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError, unwrap } from '../../api';
import { useI18n } from '../../i18n';
import { problemText } from '../master/problems';
import { StepUpBox } from '../settings/OrgSections';

/**
 * D-67 (PO 22 พ.ย. 2569; ST9-T13 M-02) — step-up 2FA ก่อนรายการเสี่ยง: สร้าง/หมุน API key, credential connector,
 * secret webhook, บัญชีธนาคารรถร่วม, ส่งออกทั้งบริษัท, ยกเลิกใบแจ้งหนี้/ใบวางบิลที่ออกแล้ว
 * กลไกเดิมของ API: `POST /v1/auth/step-up` → `stepUpToken` (อายุ 5 นาที) → header `X-Step-Up` · ไม่ผ่าน = 403 `step_up_required`
 *
 * `withStepUp(send)` — ส่งคำขอ (แนบ token ที่ยังไม่หมดอายุถ้ามี) → API ตอบ `step_up_required` → เปิดกล่องยืนยัน 2FA
 * (`StepUpBox` เดิมของหน้าตั้งค่า ใน dialog ซ้อน — ต้นแบบไม่มีกล่องในจุดเหล่านี้ [DECISION D-67, spec/12 §3]) → ส่งซ้ำพร้อม token
 * ผู้ใช้กดยกเลิก → โยน `StepUpCancelled` (หน้าไม่ต้องแสดงข้อผิดพลาด) · token จำไว้ในหน่วยความจำจนหมดอายุ (ไม่เก็บลง storage)
 */

export const isStepUpRequired = (err: unknown) =>
  err instanceof ApiError && err.problem.code === 'step_up_required';

/** ผู้ใช้ยกเลิกกล่องยืนยัน 2FA — ไม่ใช่ข้อผิดพลาดที่ต้องแสดง */
export class StepUpCancelled extends Error {
  constructor() {
    super('step_up_cancelled');
  }
}

let cached: { token: string; until: number } | null = null;
/** ล้าง token ที่จำไว้ (ออกจากระบบ / test) */
export function clearStepUp(): void {
  cached = null;
}

type Pending = { resolve: (token: string) => void; reject: (e: unknown) => void };
let pending: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** เปิดกล่องยืนยัน 2FA แล้วรอ token (ต้องมี `<StepUpHost />` ในหน้า) */
export function requestStepUp(): Promise<string> {
  pending?.reject(new StepUpCancelled());
  return new Promise<string>((resolve, reject) => {
    pending = { resolve, reject };
    emit();
  });
}

async function confirmOtp(otp: string): Promise<string> {
  const r = await unwrap(api.POST('/v1/auth/step-up', { body: { otp } }));
  // เผื่อเวลาเดินทาง 30 วินาที — หมดก่อน server เสมอ
  cached = { token: r.stepUpToken, until: Date.now() + Math.max(0, r.expiresIn - 30) * 1000 };
  return r.stepUpToken;
}

/**
 * ส่งคำขอที่อาจต้อง step-up — `send(token?)` ต้องแนบ `X-Step-Up: token` เมื่อได้ token
 * (ใช้ `stepUpHeaders(token)`) · error อื่นโยนต่อตามเดิม
 */
export async function withStepUp<R>(send: (token?: string) => Promise<R>): Promise<R> {
  const have = cached && cached.until > Date.now() ? cached.token : undefined;
  try {
    return await send(have);
  } catch (e) {
    if (!isStepUpRequired(e)) throw e;
    cached = null;
    return send(await requestStepUp());
  }
}

/**
 * token ที่ยังใช้ได้ หรือเปิดกล่องยืนยันทันที — ใช้เมื่อรู้แน่ว่ารายการต้อง step-up และจะส่งหลายคำขอพร้อมกัน
 * (เช่น ส่งออกให้นักบัญชีหลายไฟล์ — ถามครั้งเดียว ไม่ใช่ทีละไฟล์)
 */
export async function ensureStepUp(): Promise<string> {
  if (cached && cached.until > Date.now()) return cached.token;
  return requestStepUp();
}

/** token ที่จำไว้และยังไม่หมดอายุ (ไม่มี = undefined) — ส่งไปกับคำขอแรกได้เลย ไม่ต้องถามซ้ำภายใน 5 นาที */
export function cachedStepUp(): string | undefined {
  return cached && cached.until > Date.now() ? cached.token : undefined;
}

/**
 * แบบเดียวกับ ApproveDialog (/settle): กล่อง `StepUpBox` อยู่ใน dialog เหตุผลเดิม (ช่อง `extra` ของ ReasonDialog)
 * - `onError(e)` ใน onError ของ mutation: step_up_required → แสดงกล่อง (คืน true)
 * - `box(resend)` — กล่องยืนยัน; ยืนยันรหัสสำเร็จ → `resend(token)` ส่งคำขอเดิมซ้ำพร้อม token
 * - `hide(err)` — error ของ mutation ที่ควรซ่อน (กำลังแสดงกล่องอยู่) · `error` = ข้อความเมื่อยืนยันรหัสไม่ผ่าน
 */
export function useInlineStepUp() {
  const { t } = useI18n();
  const [need, setNeed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return {
    need,
    error,
    onError: (e: unknown) => {
      if (!isStepUpRequired(e)) return false;
      cached = null;
      setNeed(true);
      return true;
    },
    hide: (e: unknown) => need && isStepUpRequired(e),
    reset: () => {
      setNeed(false);
      setError(null);
    },
    box: (resend: (token: string) => void) =>
      need ? (
        <StepUpBox
          desc={t('stepUp.descAction')}
          busy={busy}
          onConfirm={(otp) => {
            setError(null);
            setBusy(true);
            confirmOtp(otp)
              .then((tok) => {
                setNeed(false);
                resend(tok);
              })
              .catch((e: unknown) => setError(problemText(e, t) ?? t('stepUp.failed')))
              .finally(() => setBusy(false));
          }}
          onCancel={() => setNeed(false)}
        />
      ) : null,
  };
}

/** header ของคำขอ — ไม่มี token = ไม่แนบ */
export const stepUpHeaders = (token?: string): Record<string, string> =>
  token ? { 'X-Step-Up': token } : {};

function usePending(): Pending | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
  );
}

/** dialog กล่องยืนยัน 2FA กลาง — วางครั้งเดียวใน AppShell */
export function StepUpHost() {
  const { t } = useI18n();
  const p = usePending();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const open = !!p;
  useModalFocus(open, box);
  useEffect(() => {
    if (open) setErr(null);
  }, [open]);
  const close = (fn: (x: Pending) => void) => {
    const cur = pending;
    pending = null;
    emit();
    if (cur) fn(cur);
  };
  const cancel = () => close((x) => x.reject(new StepUpCancelled()));
  useEscapeLayer(open, cancel); // ชั้นบนสุด: Esc ปิดเฉพาะกล่องนี้ ไม่ปิด dialog/drawer ข้างหลัง
  if (!p) return null;
  return (
    <div className="tms-dialog__scrim" onClick={cancel}>
      <div
        ref={box}
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('stepUp.title')}
        tabIndex={-1}
        data-modal-focus=""
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tms-dialog__body">
          <StepUpBox
            desc={t('stepUp.descAction')}
            busy={busy}
            onConfirm={(otp) => {
              setErr(null);
              setBusy(true);
              confirmOtp(otp)
                .then((tok) => close((x) => x.resolve(tok)))
                .catch((e: unknown) => setErr(problemText(e, t) ?? t('stepUp.failed')))
                .finally(() => setBusy(false));
            }}
            onCancel={cancel}
          />
          {err && <span className="tms-field-error">{err}</span>}
        </div>
      </div>
    </div>
  );
}
