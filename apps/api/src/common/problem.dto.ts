import { applyDecorators } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';

/** ช่องที่ผิดใน problem (`errors[]`) */
export class ProblemFieldErrorDto {
  @ApiProperty({ example: 'stops[1].siteId' }) field!: string;
  @ApiProperty({ example: 'locked' }) code!: string;
  @ApiProperty({ example: 'cannot change stops when order is IN_TRANSIT' }) message!: string;
}

/**
 * RFC 9457 `application/problem+json` (docs/04 G1 Error) — รูปเดียวทุก 4xx/5xx
 * ช่องเสริม (extension) ขึ้นกับ `code` เช่น `orderStatus`/`editableFields` ของ `order_locked_for_update`
 * (ห้ามใช้ชื่อ extension ที่ชนกับช่องมาตรฐาน เช่น `status`)
 */
export class ProblemDto {
  @ApiProperty({ example: 'https://docs.tms.example/problems/order_locked_for_update' })
  type!: string;
  @ApiProperty({ example: 'แก้ข้อมูลนี้ของใบสั่งขนส่งไม่ได้ในสถานะปัจจุบัน' }) title!: string;
  @ApiProperty({
    example: 409,
    description: 'HTTP status',
  })
  status!: number;
  @ApiPropertyOptional() detail?: string;
  @ApiPropertyOptional({ example: '/v1/orders/ord_3f2a…' }) instance?: string;
  @ApiProperty({ example: 'order_locked_for_update', description: 'รหัสคงที่ (catalog)' })
  code!: string;
  @ApiProperty({ example: 'b6a1…' }) requestId!: string;
  @ApiPropertyOptional({ type: [ProblemFieldErrorDto] }) errors?: ProblemFieldErrorDto[];
  @ApiPropertyOptional({
    example: 2,
    description: '429/503: วินาทีที่ควรรอก่อนส่งใหม่ (ตรงกับ header Retry-After)',
  })
  retryAfter?: number;
  @ApiPropertyOptional({
    example: 'tenant',
    description:
      '429 rate_limited: เพดานที่เต็ม — tenant · key · user · endpoint (คำขอหนัก) · ip · link · lookup · recipient (ผู้รับ OTP)',
  })
  scope?: string;
  @ApiPropertyOptional({
    example: 'orders',
    description: '403 permission_denied: โมดูลของสิทธิ์ที่ขาด',
  })
  module?: string;
  @ApiPropertyOptional({
    example: 'write',
    description: '403 permission_denied: การกระทำของสิทธิ์ที่ขาด',
  })
  action?: string;
  @ApiPropertyOptional({
    type: [String],
    example: ['orders:write'],
    description: '403 permission_denied: scope ที่ต้องมี (ตัวใดตัวหนึ่ง)',
  })
  required?: string[];
}

/** เอกสาร problem response ของ route พร้อมตัวอย่างต่อ code (`examples` ชื่อ = code) */
export function ApiProblems(
  ...items: { status: number; description: string; examples: Record<string, unknown> }[]
) {
  return applyDecorators(
    ApiExtraModels(ProblemDto, ProblemFieldErrorDto),
    ...items.map((i) =>
      ApiResponse({
        status: i.status,
        description: i.description,
        content: {
          'application/problem+json': {
            schema: { $ref: getSchemaPath(ProblemDto) },
            examples: Object.fromEntries(
              Object.entries(i.examples).map(([k, v]) => [k, { value: v }]),
            ),
          },
        },
      }),
    ),
  );
}
