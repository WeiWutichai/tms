import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireScope } from '../../common/decorators';
import { PROBLEMS, type ProblemCode } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { SearchQuery, SearchResultDto } from './search.dto';
import { SEARCH_SCOPE, SearchService } from './search.service';

const P = (code: ProblemCode, extra: Record<string, unknown> = {}) => ({
  type: `https://docs.tms.example/problems/${code}`,
  title: PROBLEMS[code].th,
  status: PROBLEMS[code].status,
  code,
  instance: '/v1/search',
  requestId: 'b6a1c2d3-…',
  ...extra,
});
const SCOPES = [...new Set(Object.values(SEARCH_SCOPE))] as [string, ...string[]];

/**
 * ค้นหา global ⌘K (ST9-T09; docs/04 I "ค้นหา global (⌘K)": เลข order/trip/invoice/ทะเบียน/ลูกค้า/เลข PO → กระโดดไปเอกสาร)
 * UI เรียก endpoint เดียวกับลูกค้า (API-first) · ไม่มีราคา/ยอดเงินในผล
 */
@ApiTags('search')
@ApiBearerAuth()
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @RequireScope(...SCOPES)
  @ApiOperation({
    summary: 'ค้นหาเอกสาร ลูกค้า รถ (⌘K)',
    description:
      'ค้นพร้อมกันหลายชนิด: SO (`orders:read`), DO (`orders:read`), เที่ยวรถ (`trips:read`), ใบแจ้งหนี้และใบวางบิล (`invoices:read`), ' +
      'ลูกค้าและรถ (`master:read`) — ค้นเฉพาะชนิดที่ผู้เรียกมี scope (`searched`) · ' +
      'ผลต่อชนิดไม่เกิน `limit` เรียง ตรงทั้งคำ → ขึ้นต้นด้วย → มีอยู่ → แก้ล่าสุด · เห็นเฉพาะข้อมูลของบริษัท (หรือ sandbox) ของ credential นี้ · ' +
      'ไม่ส่งราคา/ยอดเงิน · นับ rate limit แบบอ่าน (GET)',
  })
  @ApiOkResponse({ type: SearchResultDto })
  @ApiProblems(
    {
      status: 403,
      description:
        'ไม่มี scope อ่านชนิดใดเลย (`orders:read` / `trips:read` / `invoices:read` / `master:read`)',
      examples: {
        permission_denied: P('permission_denied', { required: SCOPES }),
      },
    },
    {
      status: 422,
      description:
        'คำค้นสั้นกว่า 2 หรือยาวกว่า 64 ตัวอักษร (หลังตัดช่องว่าง) / `limit` นอกช่วง 1–10',
      examples: {
        validation_failed: P('validation_failed', {
          errors: [
            {
              field: 'q',
              code: 'too_short',
              message: 'q must be longer than or equal to 2 characters',
            },
          ],
        }),
      },
    },
  )
  find(@Query() q: SearchQuery): Promise<SearchResultDto> {
    return this.search.search(q.q, q.limit ?? 5);
  }
}
