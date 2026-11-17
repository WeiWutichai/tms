import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { isLocalEnv } from '../../auth/tokens';

/**
 * กัน SSRF ของ webhook ขาออก (ST7-T04; spec/07 §10 ฟิลด์ url + ข้อ 8 `ssrf_blocked`; NFR-147)
 * - ปลายทางต้องเป็น IP สาธารณะ: ปิด private/loopback/link-local (รวม metadata 169.254.169.254, fd00:ec2::254)/CGNAT/
 *   multicast/สงวน/เอกสาร และ IPv6 ที่ฝัง IPv4 (mapped/compat/NAT64/6to4/Teredo) ทั้งก้อน
 * - ชื่อโฮสต์ resolve DNS แล้วตรวจ "ทุก" address (มีตัวเดียวเป็นภายใน = ปฏิเสธ — กัน round-robin rebinding)
 *   และเชื่อมต่อด้วย address ที่ตรวจแล้วนั้นเลย (lookup ของ socket) — DNS เปลี่ยนระหว่างตรวจกับต่อ (rebinding) ไม่มีผล
 * - ไม่ follow redirect (ผู้เรียกถือ 3xx เป็นล้มเหลว)
 * dev/test: `WEBHOOK_ALLOW_PRIVATE_TARGETS=1` ยอมปลายทางภายใน (test/E2E ใช้ server ในเครื่อง) — production ไม่สนค่านี้
 */
// v4/v6 แยกรายการ: BlockList ของ Node เทียบ IPv4 กับกฎ ::ffff:0:0/96 ด้วย — รวมกันแล้ว IPv4 ทุกตัวจะถูกปิด
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  BLOCKED_V4.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback ::1, IPv4-compatible
  ['::ffff:0:0', 96], // IPv4-mapped
  ['::ffff:0:0:0', 96], // IPv4-translated (SIIT)
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // เอกสาร
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local (รวม fd00:ec2::254 metadata ของ AWS)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (เลิกใช้)
  ['ff00::', 8], // multicast
] as const)
  BLOCKED_V6.addSubnet(net, prefix, 'ipv6');

/** ชื่อโฮสต์ที่ไม่ใช่อินเทอร์เน็ตสาธารณะแน่นอน */
const INTERNAL_HOST = /(^|\.)(localhost|local|internal|localdomain|home\.arpa|intranet|lan)$/i;

export class SsrfBlockedError extends Error {
  readonly code = 'ssrf_blocked';
  constructor(message: string) {
    super(message);
  }
}

/** ยอมปลายทางภายในไหม (dev/test + env เท่านั้น) */
export function allowPrivateTargets(): boolean {
  return isLocalEnv() && process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS === '1';
}

/** ยอม http:// ไหม — นอก dev/test ต้อง https (spec/07 §10) */
export function allowHttp(): boolean {
  return isLocalEnv();
}

/** IP นี้ห้ามเป็นปลายทางไหม */
export function isBlockedAddress(address: string): boolean {
  const fam = isIP(address);
  if (fam === 4) return BLOCKED_V4.check(address, 'ipv4');
  if (fam === 6) return BLOCKED_V6.check(address.replace(/%.*$/, ''), 'ipv6');
  return true; // ไม่ใช่ IP ที่อ่านได้ = ไม่ไว้ใจ
}

/** ชื่อโฮสต์ใน URL (ตัด [] ของ IPv6) */
export function urlHost(u: URL): string {
  return u.hostname.replace(/^\[(.*)\]$/, '$1');
}

/**
 * พอร์ตปลายทาง: ปิด well-known port < 1024 ยกเว้น 80/443 (กันยิงบริการภายใน เช่น SMTP 25, SSH 22, Redis ฯลฯ ผ่าน host สาธารณะ)
 * [DECISION spec/12 §3] — 1024–65535 ใช้ได้ (ผู้รับหลายรายใช้ 8443/8080)
 */
export function portAllowed(u: URL): boolean {
  if (!u.port) return true;
  const p = Number(u.port);
  return p === 80 || p === 443 || (p >= 1024 && p <= 65535);
}

/** มีช่องว่าง/อักขระควบคุมใน URL ดิบ (new URL จะตัด/encode เงียบ ๆ) */
const BAD_CHARS = /[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/;

export interface UrlProblem {
  code:
    | 'invalid_url'
    | 'https_required'
    | 'credentials_in_url'
    | 'url_not_allowed'
    | 'port_not_allowed';
  message: string;
}

/** ตรวจรูปแบบ URL (ไม่ resolve DNS) — คืน null = ผ่าน */
export function checkUrlShape(
  raw: string,
  opts = { allowPrivate: allowPrivateTargets() },
): UrlProblem | null {
  if (BAD_CHARS.test(raw))
    return { code: 'invalid_url', message: 'URL must not contain spaces or control characters' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { code: 'invalid_url', message: 'invalid URL' };
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowHttp()))
    return { code: 'https_required', message: 'endpoint URL must use https://' };
  if (u.username || u.password)
    return { code: 'credentials_in_url', message: 'URL must not contain user:password' };
  const host = urlHost(u);
  if (!host) return { code: 'invalid_url', message: 'invalid URL' };
  if (!portAllowed(u))
    return {
      code: 'port_not_allowed',
      message: 'ports below 1024 other than 80/443 are not allowed',
    };
  if (opts.allowPrivate) return null;
  if (isIP(host)) {
    if (isBlockedAddress(host))
      return { code: 'url_not_allowed', message: 'internal/private addresses are not allowed' };
  } else if (INTERNAL_HOST.test(host) || !host.includes('.'))
    return { code: 'url_not_allowed', message: 'internal host names are not allowed' };
  return null;
}

export type Resolver = (host: string) => Promise<LookupAddress[]>;

/** DNS ของระบบ (ทุก address) */
export const systemResolver: Resolver = (host) =>
  new Promise((resolve, reject) =>
    dnsLookup(host, { all: true, verbatim: true }, (err, addrs) =>
      err ? reject(err) : resolve(addrs),
    ),
  );

/**
 * resolve แล้วตรวจทุก address — คืน address ที่ใช้ต่อได้ (ไม่มีตัวที่ถูกปิด)
 * literal IP ไม่ resolve · โยน SsrfBlockedError เมื่อมี address ภายใน
 */
export async function resolvePublic(
  host: string,
  resolver: Resolver = systemResolver,
  allowPrivate = allowPrivateTargets(),
): Promise<LookupAddress[]> {
  const fam = isIP(host);
  const addrs = fam ? [{ address: host, family: fam }] : await resolver(host);
  if (!addrs.length) throw new Error(`no address for ${host}`);
  if (!allowPrivate) {
    const bad = addrs.find((a) => isBlockedAddress(a.address));
    if (bad)
      throw new SsrfBlockedError(`destination resolves to a blocked address (${bad.address})`);
  }
  return addrs;
}
