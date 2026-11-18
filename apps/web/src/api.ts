import { createTmsClient, type Problem } from '@tms/contracts';
import { QueryClient } from '@tanstack/react-query';
import { dropAccessToken, getAccessToken } from './auth/session';
import { getApiMode, isSandboxPath } from './features/api-keys/mode';

/**
 * client เดียวที่ UI ใช้ — generate จาก OpenAPI ของ /v1 (API-first, ST0-T09)
 * token มาจาก session (login → Auth Code + PKCE — ST1-T01/T04)
 */
export const api = createTmsClient({
  baseUrl: '',
  // หน้าลิงก์สาธารณะ (/link/*) ไม่ใช้ session ของผู้ใช้ — ไม่ต่ออายุ token (QA ST4-T08 L5)
  getToken: () =>
    typeof location !== 'undefined' &&
    (location.pathname.startsWith('/link/') || location.pathname.startsWith('/t/'))
      ? null
      : getAccessToken(),
  locale: () => (document.documentElement.lang === 'en' ? 'en' : 'th'),
});

// ST7-T09: หน้า นักพัฒนา / Open API ในโหมด Sandbox → ส่ง `X-Tms-Mode: test` เฉพาะ path ของหน้านั้น
// (คำขอที่ระบุ header เองแล้ว เช่น สร้าง key ของอีกโหมด ไม่ถูกทับ)
api.use({
  onRequest({ request }) {
    if (getApiMode() !== 'test' || request.headers.has('X-Tms-Mode')) return request;
    let path = '';
    try {
      path = new URL(request.url, 'http://x').pathname;
    } catch {
      return request;
    }
    if (isSandboxPath(path)) request.headers.set('X-Tms-Mode', 'test');
    return request;
  },
});

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.code);
  }
}

/** แปลงผลจาก openapi-fetch → data หรือโยน ApiError (problem+json) */
export async function unwrap<T>(
  p: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const r = await p;
  if (r.error !== undefined || !r.response.ok) {
    const problem = (r.error ?? {
      code: 'internal_error',
      status: r.response.status,
      title: '',
      type: '',
    }) as Problem;
    // 401 = session หมด/ถูกเพิกถอน → ทิ้ง token · ยกเว้นรหัส 2FA ผิด (`invalid_otp` เช่น step-up) — ผู้ใช้ยังเข้าระบบอยู่
    // ให้กรอกใหม่ ไม่เด้งออกจากระบบ (ST9-T12 QA Q1)
    if (r.response.status === 401 && problem.code !== 'invalid_otp') dropAccessToken();
    throw new ApiError(problem);
  }
  return r.data as T;
}

/**
 * คำขอเขียนที่ส่ง Idempotency-Key (review ST2-T17): ถ้า server ตอบ 409 `idempotency_in_progress`
 * (คำขอเดิมด้วย key เดียวกันยังทำไม่เสร็จ — เช่นกดซ้ำ/เน็ตช้า) → รอแล้วส่งซ้ำด้วย key เดิม จนได้ผลของคำขอแรก
 * ผู้เรียกต้องไม่เปลี่ยน key ระหว่างนี้ (ส่งซ้ำ = ได้ผลเดิม ไม่สร้างซ้ำ)
 */
export async function idempotent<T>(
  call: () => Promise<{ data?: T; error?: unknown; response: Response }>,
  waitMs = [300, 600, 1000, 1500, 2000, 3000, 4000, 5000],
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await unwrap(call());
    } catch (e) {
      const ms = waitMs[i];
      if (
        !(e instanceof ApiError) ||
        e.problem.code !== 'idempotency_in_progress' ||
        ms === undefined
      )
        throw e;
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false } },
});
