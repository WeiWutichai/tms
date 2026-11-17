import type { OpenAPIObject } from '@nestjs/swagger';
import {
  API_RELEASES,
  FIRST_API_VERSION,
  LATEST_API_VERSION,
  VERSION_CHANGES,
  versionChange,
  type DeprecationInfo,
} from './versions';

/**
 * ST7-T07: บรรยาย versioning ใน OpenAPI
 * - parameter `X-Api-Version` (header, ไม่บังคับ) ทุก operation + response header `X-Api-Version` บน 2xx
 * - `info.x-api-version-latest` + `info.x-api-versions` (รายการเวอร์ชันและการเปลี่ยน) — client ที่ generate อ่านค่าล่าสุดจากที่นี่
 * - operation ที่ติด @VersionGate: `x-api-version-gates` → หมายเหตุต่อเวอร์ชันในคำอธิบาย
 * - operation ที่ติด @DeprecatedRoute: `deprecated: true` + header Deprecation/Sunset/Link ใน 2xx
 */
type Op = {
  description?: string;
  deprecated?: boolean;
  parameters?: unknown[];
  responses?: Record<string, { $ref?: string; headers?: Record<string, unknown> }>;
  'x-api-version-gates'?: string[];
  'x-deprecation'?: DeprecationInfo;
};

const METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);

export function describeApiVersioning(doc: OpenAPIObject): OpenAPIObject {
  const info = doc.info as unknown as Record<string, unknown>;
  info['x-api-version-latest'] = LATEST_API_VERSION;
  info['x-api-versions'] = API_RELEASES.map((r) => ({
    ...r,
    changes: VERSION_CHANGES.filter((c) => c.version === r.version).map((c) => ({
      id: c.id,
      description: c.description,
    })),
  }));
  const components = (doc.components ??= {});
  const parameters = (components.parameters ??= {}) as Record<string, unknown>;
  parameters.ApiVersion = {
    name: 'X-Api-Version',
    in: 'header',
    required: false,
    description:
      `เวอร์ชันพฤติกรรมของ API (วันที่ YYYY-MM-DD ตั้งแต่ ${FIRST_API_VERSION} ถึงวันนี้ — ได้ทุกการเปลี่ยนที่ออกในหรือก่อนวันนั้น; ล่าสุด ${LATEST_API_VERSION}). ` +
      'ไม่ส่ง = เวอร์ชันที่ pin ไว้บน API key → วันที่สร้างบริษัท. ผิดรูปแบบ/ก่อนเวอร์ชันแรก/อนาคต → 400 `invalid_api_version`. ' +
      'เพิ่ม field/enum ใหม่ไม่ถือว่า breaking — client ต้องรับค่า enum ที่ไม่รู้จักได้',
    schema: { type: 'string', format: 'date', example: LATEST_API_VERSION },
  };
  const headers = (components.headers ??= {}) as Record<string, unknown>;
  headers['X-Api-Version'] = {
    description: 'วันที่เวอร์ชันที่ใช้ตอบคำขอนี้',
    schema: { type: 'string', format: 'date' },
  };
  headers.Deprecation = {
    description: 'RFC 9745 — route/เวอร์ชันนี้ถูกประกาศเลิกใช้ตั้งแต่ (`@<epoch seconds>`)',
    schema: { type: 'string' },
  };
  headers.Sunset = {
    description: 'RFC 8594 — วันที่หยุดรองรับ (HTTP-date)',
    schema: { type: 'string' },
  };
  headers.Link = {
    description: '`<url>; rel="deprecation"` — เอกสารทางย้าย',
    schema: { type: 'string' },
  };
  const ref = { $ref: '#/components/parameters/ApiVersion' };
  for (const item of Object.values(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item as Record<string, Op>)) {
      if (!METHODS.has(method) || !op?.responses) continue;
      op.parameters = [...(op.parameters ?? []), ref];
      const dep = op['x-deprecation'];
      if (dep) op.deprecated = true;
      for (const [code, r] of Object.entries(op.responses)) {
        if (!/^2\d\d$/.test(code) || r.$ref) continue;
        r.headers = {
          ...(r.headers ?? {}),
          'X-Api-Version': { $ref: '#/components/headers/X-Api-Version' },
          ...(dep
            ? {
                Deprecation: { $ref: '#/components/headers/Deprecation' },
                Sunset: { $ref: '#/components/headers/Sunset' },
                Link: { $ref: '#/components/headers/Link' },
              }
            : {}),
        };
      }
      const notes = (op['x-api-version-gates'] ?? [])
        .map((id) => versionChange(id))
        .filter((c) => !!c)
        .map((c) => `- ${c.version}: ${c.description}`);
      if (notes.length)
        op.description = [
          op.description,
          `**หมายเหตุต่อเวอร์ชัน (X-Api-Version)**\n${notes.join('\n')}`,
        ]
          .filter(Boolean)
          .join('\n\n');
      if (dep)
        op.description = [
          op.description,
          `**เลิกใช้** ตั้งแต่ ${dep.deprecatedAt}` +
            (dep.sunset ? ` · หยุดรองรับ ${dep.sunset}` : ''),
        ]
          .filter(Boolean)
          .join('\n\n');
    }
  }
  return doc;
}
