import type { Request, Response } from 'express';
import { ProblemException } from './problem';

/** ETag = version ของแถว (docs/01 §5.1 Concurrency) */
export function setEtag(res: Response, version: number): void {
  res.setHeader('ETag', `"${version}"`);
}

/** อ่าน If-Match → version ที่คาดหวัง (undefined = ไม่ส่งมา → ไม่บังคับ ยกเว้น connector strict mode ภายหลัง) */
export function expectedVersion(req: Request): number | undefined {
  const h = req.header('if-match');
  if (!h) return undefined;
  const m = /^(?:W\/)?"(\d+)"$/.exec(h.trim());
  if (!m) throw new ProblemException('precondition_failed', 'If-Match must be an ETag like "3"');
  return Number(m[1]);
}
