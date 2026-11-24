import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, PinoNestLogger } from './logger';

/** ST9-T13 R2 (L-02) — Logger ของ Nest ออกทาง pino: JSON + context + redact ของ object */
describe('PinoNestLogger', () => {
  it('ข้อความ / object / error(message, stack, context) → JSON บรรทัดเดียว · field ลับถูก redact', () => {
    const lines: Record<string, unknown>[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        cb();
      },
    });
    const l = new PinoNestLogger(createLogger(dest as never));
    l.log('started', 'Worker');
    l.warn({ credentials: { apiKey: 'k-secret' }, password: 'p-secret', n: 1 }, 'Sink');
    l.error('boom', 'Error: boom\n    at x', 'ProblemFilter');
    expect(lines[0]).toMatchObject({ level: 30, msg: 'started', context: 'Worker' });
    expect(JSON.stringify(lines[1])).not.toContain('secret');
    expect(lines[1]).toMatchObject({ level: 40, n: 1, context: 'Sink' });
    expect(lines[2]).toMatchObject({ level: 50, msg: 'boom', context: 'ProblemFilter' });
    expect(String(lines[2]!.stack)).toContain('at x');
  });
});
