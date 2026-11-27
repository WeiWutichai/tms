import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * P1-ST5-T01 mock server harness ของชุด conformance — reverse proxy ที่วางหน้า mock ของ ERP (`@tms/mock-krs`,
 * `@tms/mock-accountsystem` หรือ mock ของ connector ใหม่ที่สร้างจาก fixture) แล้วฉีดความผิดพลาดแบบ HTTP ทั่วไป
 * โดยไม่ต้องรู้สัญญาของ ERP ตัวนั้น · เก็บทุกคำขอที่ผ่าน (method/path/body) ให้ชุดตรวจเทียบกับ sync log ของ adapter
 *
 * ไม่ติดต่อภายนอก (ฟังที่ 127.0.0.1 พอร์ตสุ่ม · upstream ต้องเป็น mock ในเครื่อง)
 */
export type HttpFault =
  /** ตอบ status นี้ (body JSON ตาม fixture ของ ERP หรือค่ากลาง) */
  | { kind: 'status'; status: number; body?: unknown; on: FaultTarget }
  /** อ่าน body ครบแล้วตัดการเชื่อมต่อ (ERP อาจได้รับแล้ว — docs/01 §6.3 AMBIGUOUS) */
  | { kind: 'reset'; on: FaultTarget };

/**
 * คำขอที่โดน fault: `any` = ทุกคำขอ (เช่น key ผิด/ปลายทางล่มทั้งระบบ) · `write` = คำขอเขียน (ไม่ใช่ GET) ที่ path ตรง `writePath`
 * (ไม่ระบุ = คำขอเขียนทุกตัว) — คำขอที่ไม่โดน fault ส่งต่อให้ mock ตามปกติ
 */
export type FaultTarget = 'any' | 'write';

export interface CapturedRequest {
  method: string;
  path: string;
  body: string;
  faulted: boolean;
}

export class FaultProxy {
  private server: Server | null = null;
  private fault: HttpFault | null = null;
  private upstream = '';
  readonly captured: CapturedRequest[] = [];
  /** origin ของ proxy (เช่น http://127.0.0.1:54321) */
  origin = '';

  constructor(private readonly writePath?: RegExp) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  /** URL ที่ adapter ใช้แทน `upstreamUrl` (เก็บ path เดิม เช่น `/api`) */
  via(upstreamUrl: string): string {
    const u = new URL(upstreamUrl);
    this.upstream = u.origin;
    return `${this.origin}${u.pathname.replace(/\/+$/, '')}`;
  }

  arm(f: HttpFault | null): void {
    this.fault = f;
  }

  clear(): void {
    this.fault = null;
    this.captured.length = 0;
  }

  private hits(method: string, path: string): boolean {
    const f = this.fault;
    if (!f) return false;
    if (f.on === 'any') return true;
    return method !== 'GET' && (!this.writePath || this.writePath.test(path));
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';
    const faulted = this.hits(method, path.split('?')[0]!);
    this.captured.push({ method, path, body: body.toString('utf8'), faulted });
    const f = this.fault;
    if (faulted && f?.kind === 'reset') {
      req.socket.destroy();
      return;
    }
    if (faulted && f?.kind === 'status') {
      res.writeHead(f.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(f.body ?? { error: `conformance fault HTTP ${f.status}` }));
      return;
    }
    if (!this.upstream) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"error":"no upstream"}');
      return;
    }
    const up = new URL(path, this.upstream);
    const headers = { ...req.headers, host: up.host };
    delete headers['content-length'];
    const p = httpRequest(
      up,
      { method, headers: { ...headers, 'content-length': String(body.length) } },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    p.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"error":"upstream unreachable"}');
    });
    p.end(body);
  }
}

/** พอร์ตที่ไม่มีใครฟัง (connection refused — docs/01 §6.3 TRANSIENT) */
export async function refusedUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}
