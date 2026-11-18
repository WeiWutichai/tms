import type { Job } from '@prisma/client';
import { encodeId } from '../common/ids';

/** รูปของงาน async — `GET /v1/jobs/{id}` และ `data.object` ของ webhook `job.completed` (ST7-T06) */
export function toJobDto(j: Job) {
  return {
    id: encodeId('job', j.id),
    type: j.type,
    status: j.status.toLowerCase(),
    progress: j.progress,
    result: j.result,
    error: j.error,
    attempts: j.attempts,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null,
  };
}
