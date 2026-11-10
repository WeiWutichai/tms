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

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false } },
});
