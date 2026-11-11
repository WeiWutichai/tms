import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { from, Observable, of } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';
import { DbService } from '../db/db.service';

const TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_MS = 60 * 1000;
const KEY_RE = /^[\x21-\x7e]{1,255}$/;

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

/**
 * Idempotency-Key สำหรับทุก POST (ST0-T07, docs/01 §5.1)
 * - key + body เดิม → response เดิม + `Idempotent-Replayed: true`
 * - key เดิม body ต่าง → 422 idempotency_mismatch
 * - key เดิมกำลังประมวลผล → 409 idempotency_in_progress
 * scope = (tenant, key, path) เก็บ 24 ชม.; คำขอที่ error ไม่ถูกจำ (ลองใหม่ได้)
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly db: DbService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const key = req.header('idempotency-key');
    const tenantId = requestContext.get()?.tenantId;
    if (req.method !== 'POST' || !key || !tenantId) return next.handle();
    if (!KEY_RE.test(key)) {
      throw new ProblemException(
        'bad_request',
        'Idempotency-Key must be 1-255 visible ASCII chars',
      );
    }

    const path = req.baseUrl + req.path;
    const requestHash = createHash('sha256')
      .update(`${req.method} ${path}\n${stableStringify(req.body ?? null)}`)
      .digest('hex');
    const status = this.reflector.get<number>(HTTP_CODE_METADATA, context.getHandler()) ?? 201;

    return from(this.reserve(tenantId, key, path, requestHash)).pipe(
      mergeMap((replay) => {
        if (replay) {
          res.setHeader('Idempotent-Replayed', 'true');
          return of(replay.body);
        }
        return next.handle().pipe(
          mergeMap((body) =>
            from(this.complete(tenantId, key, path, status, body)).pipe(mergeMap(() => of(body))),
          ),
          catchError((err) =>
            from(this.release(tenantId, key, path)).pipe(
              mergeMap(() => {
                throw err;
              }),
            ),
          ),
        );
      }),
    );
  }

  private async reserve(tenantId: string, key: string, path: string, requestHash: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      // claim แบบ atomic: คำขอพร้อมกันที่ key เดียวกันรอกันที่ lock นี้ — คนแรกจองแถว (locked_until)
      // คนถัดไปเห็นแถวที่จองแล้ว → 409 idempotency_in_progress หรือ replay (SELECT … FOR UPDATE ของแถวที่ยังไม่มีล็อกอะไรไม่ได้)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(11, hashtext(${`${tenantId}:${path}:${key}`}))`;
      const now = new Date();
      const rows = await tx.$queryRaw<
        {
          request_hash: string;
          response_status: number | null;
          response_body: unknown;
          locked_until: Date | null;
          expires_at: Date;
        }[]
      >`SELECT request_hash, response_status, response_body, locked_until, expires_at
          FROM idempotency_key WHERE tenant_id = ${tenantId}::uuid AND key = ${key} AND path = ${path} FOR UPDATE`;
      const row = rows[0];
      if (row && row.expires_at > now) {
        if (row.request_hash !== requestHash) throw new ProblemException('idempotency_mismatch');
        if (row.response_status !== null)
          return { status: row.response_status, body: row.response_body };
        if (row.locked_until && row.locked_until > now)
          throw new ProblemException('idempotency_in_progress');
      }
      await tx.idempotencyKey.upsert({
        where: { tenantId_key_path: { tenantId, key, path } },
        create: {
          tenantId,
          key,
          path,
          requestHash,
          lockedUntil: new Date(now.getTime() + LOCK_MS),
          expiresAt: new Date(now.getTime() + TTL_MS),
        },
        update: {
          requestHash,
          responseStatus: null,
          responseBody: undefined,
          lockedUntil: new Date(now.getTime() + LOCK_MS),
          createdAt: now,
          expiresAt: new Date(now.getTime() + TTL_MS),
        },
      });
      return null;
    });
  }

  private complete(tenantId: string, key: string, path: string, status: number, body: unknown) {
    return this.db.withTenant(tenantId, (tx) =>
      tx.idempotencyKey.update({
        where: { tenantId_key_path: { tenantId, key, path } },
        data: { responseStatus: status, responseBody: (body ?? null) as any, lockedUntil: null },
      }),
    );
  }

  private release(tenantId: string, key: string, path: string) {
    return this.db
      .withTenant(tenantId, (tx) =>
        tx.idempotencyKey.deleteMany({ where: { tenantId, key, path } }),
      )
      .catch(() => undefined);
  }
}
