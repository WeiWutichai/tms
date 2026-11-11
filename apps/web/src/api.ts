import { createTmsClient, type Problem } from '@tms/contracts';
import { QueryClient } from '@tanstack/react-query';
import { dropAccessToken, getAccessToken } from './auth/session';

/**
 * client เดียวที่ UI ใช้ — generate จาก OpenAPI ของ /v1 (API-first, ST0-T09)
 * token มาจาก session (login → Auth Code + PKCE — ST1-T01/T04)
 */
export const api = createTmsClient({
  baseUrl: '',
  getToken: getAccessToken,
  locale: () => (document.documentElement.lang === 'en' ? 'en' : 'th'),
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
    if (r.response.status === 401) dropAccessToken();
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
