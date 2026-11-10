import { describe, expect, it } from 'vitest';
import { diffOpenApi } from './openapi-diff';

const base = {
  paths: {
    '/v1/companies': {
      post: {
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Create' } } },
        },
      },
      get: { parameters: [{ in: 'query', name: 'limit', required: false }] },
    },
  },
  components: {
    schemas: {
      Create: {
        type: 'object',
        properties: { legalName: { type: 'string' } },
        required: ['legalName'],
      },
      Company: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['active', 'inactive'] },
        },
      },
    },
  },
};
const clone = () => JSON.parse(JSON.stringify(base));

describe('diffOpenApi', () => {
  it('ฉบับเดิม → ไม่มี breaking', () => expect(diffOpenApi(base, clone())).toEqual([]));

  it('ลบ field จาก response → breaking', () => {
    const h = clone();
    delete h.components.schemas.Company.properties.status;
    expect(diffOpenApi(base, h)).toEqual([
      { where: 'schema Company.status', change: 'property removed' },
    ]);
  });

  it('ลบ endpoint, ลบค่า enum, เพิ่ม required ใน request, parameter กลายเป็นบังคับ → breaking', () => {
    const h = clone();
    delete h.paths['/v1/companies'].get.parameters;
    h.paths['/v1/companies'].get.parameters = [{ in: 'query', name: 'limit', required: true }];
    h.components.schemas.Company.properties.status.enum = ['active'];
    h.components.schemas.Create.properties.taxId = { type: 'string' };
    h.components.schemas.Create.required = ['legalName', 'taxId'];
    const changes = diffOpenApi(base, h).map((c) => c.change);
    expect(changes).toEqual(
      expect.arrayContaining([
        'parameter limit became required',
        'enum values removed: inactive',
        'request fields became required: taxId',
      ]),
    );
    const h2 = clone();
    delete h2.paths['/v1/companies'].post;
    expect(diffOpenApi(base, h2)[0]!.change).toBe('operation removed');
  });

  it('เพิ่ม field/endpoint/ค่า enum → ไม่ breaking', () => {
    const h = clone();
    h.components.schemas.Company.properties.taxId = { type: 'string' };
    h.components.schemas.Company.properties.status.enum.push('archived');
    h.paths['/v1/jobs/{id}'] = { get: {} };
    expect(diffOpenApi(base, h)).toEqual([]);
  });
});
