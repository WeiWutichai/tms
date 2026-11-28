import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  fixtureTinExists,
  fixtureVat,
  RD_FIXTURE_DOWN,
  tinResponseXml,
  vatResponseXml,
} from '../src/modules/signup/company-lookup/fixtures';
import { soapField } from '../src/modules/signup/company-lookup/rd-soap';

/**
 * mock SOAP server ของ RD (VAT `/vat` + TIN `/tin`) สำหรับ test — ตอบรูปเดียวกับที่ adapter `rd` คาด (fixtures.ts)
 * ควบคุมได้: `fail` (ตอบ 500 ทุกคำขอ) · `delayMs` (หน่วงคำตอบ) · บันทึกคำขอ + จำนวนที่ค้างพร้อมกันสูงสุด
 */
export interface MockRd {
  url: string;
  fail: boolean;
  /** ตอบ 200 แต่ body ใหญ่เกินเพดาน (300 KB) */
  huge: boolean;
  delayMs: number;
  /** คำขอที่ผิดรูป (operation/credentials ไม่ตรง) — test ต้องเป็น 0 */
  invalid: string[];
  requests: Array<{
    service: 'vat' | 'tin';
    tin: string | null;
    branch: string | null;
    contentType: string;
  }>;
  maxInFlight: number;
  reset(): void;
  close(): Promise<void>;
}

export async function startMockRd(): Promise<MockRd> {
  let inFlight = 0;
  const state = {
    fail: false,
    huge: false,
    invalid: [] as string[],
    delayMs: 0,
    requests: [] as MockRd['requests'],
    maxInFlight: 0,
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const service = req.url?.startsWith('/tin') ? 'tin' : 'vat';
      const tin = soapField(body, 'TIN');
      const branch = soapField(body, 'BranchNumber');
      state.requests.push({
        service,
        tin,
        branch,
        contentType: String(req.headers['content-type']),
      });
      // ตรวจรูปคำขอตาม research §2.2: operation `Service` (VAT, มี Name ว่าง) / `ServiceTIN` + anonymous/anonymous
      const op =
        service === 'tin'
          ? /<ServiceTIN\b/.test(body)
          : /<Service\b/.test(body) && /<Name><\/Name>/.test(body);
      if (
        !op ||
        soapField(body, 'username') !== 'anonymous' ||
        soapField(body, 'password') !== 'anonymous' ||
        !/soap-envelope/.test(body)
      ) {
        state.invalid.push(body);
        res.writeHead(400).end('bad request');
        return;
      }
      inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, inFlight);
      setTimeout(() => {
        inFlight--;
        if (state.fail || (tin && RD_FIXTURE_DOWN.has(tin))) {
          res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Server Error');
          return;
        }
        if (state.huge) {
          res
            .writeHead(200, { 'Content-Type': 'application/soap+xml; charset=utf-8' })
            .end(`<x>${'a'.repeat(300 * 1024)}</x>`);
          return;
        }
        const xml =
          service === 'tin'
            ? tinResponseXml(tin ?? '', fixtureTinExists(tin ?? ''))
            : vatResponseXml(tin ?? '', fixtureVat(tin ?? '', Number(branch ?? '0')));
        res.writeHead(200, { 'Content-Type': 'application/soap+xml; charset=utf-8' }).end(xml);
      }, state.delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const mock: MockRd = {
    url: `http://127.0.0.1:${port}`,
    get fail() {
      return state.fail;
    },
    set fail(v) {
      state.fail = v;
    },
    get huge() {
      return state.huge;
    },
    set huge(v) {
      state.huge = v;
    },
    get invalid() {
      return state.invalid;
    },
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(v) {
      state.delayMs = v;
    },
    get requests() {
      return state.requests;
    },
    get maxInFlight() {
      return state.maxInFlight;
    },
    reset() {
      state.fail = false;
      state.huge = false;
      state.invalid = [];
      state.delayMs = 0;
      state.requests = [];
      state.maxInFlight = 0;
      inFlight = 0;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  return mock;
}
