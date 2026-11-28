import type { UsageMetricsDto } from './usage.dto';
import type { UsageMetricsView } from './usage-metrics';

/** แปลงผลอ่านเป็น DTO (ลูกค้า + Console ใช้ร่วม) */
export function toUsageMetricsDto(
  u: UsageMetricsView,
  connectorLimit: number | null,
): UsageMetricsDto {
  return {
    period: u.period,
    status: u.status,
    finalizedAt: u.finalizedAt,
    doCreated: u.doCreated,
    invoicesIssued: u.invoicesIssued,
    apiCalls: u.apiCalls,
    podStorageGb: u.podStorageGb,
    connectors: u.connectors,
    connectorLimit,
    users: u.users,
    eTaxDocuments: null, // R-17: ไม่มี e-Tax ในเฟส 1
    gaugeAsOf: u.gaugeAsOf,
    metricsSource: u.metricsSource,
  };
}
