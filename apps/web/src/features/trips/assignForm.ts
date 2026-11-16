/** รถในตัวเลือก "รถ (เรียงตามความเหมาะสม)" ของการจัดรถ (ST3-T17) — เฉพาะช่องที่ใช้เรียง */
export interface AssignVehicle {
  id: string;
  plate: string;
  payloadKg: number | null;
  status: string;
}

/**
 * เรียงรถตามความเหมาะสม (ต้นแบบ "รถ (เรียงตามความเหมาะสม)"): รถของเที่ยวนี้ก่อน → พร้อมใช้ (ready) → รับน้ำหนักเที่ยวได้
 * (ความจุน้อยสุดที่พอ — ไม่เปลืองรถใหญ่) → ไม่ทราบความจุ → รับไม่พอ (มากไปน้อย) → ทะเบียน
 * กฎจริงตรวจที่ server ตอนจัด (ST3-T14) — ลำดับนี้ช่วยเลือกเท่านั้น
 */
export function sortVehicles<V extends AssignVehicle>(
  vs: readonly V[],
  currentId: string | null,
  weightKg: number,
): V[] {
  const rank = (v: V) => {
    if (v.id === currentId) return [0, 0];
    const ready = v.status === 'ready' ? 0 : 1;
    if (v.payloadKg === null) return [1 + ready * 3, 1, 0];
    if (v.payloadKg >= weightKg) return [1 + ready * 3, 0, v.payloadKg];
    return [1 + ready * 3, 2, -v.payloadKg];
  };
  return [...vs].sort((a, b) => {
    const x = rank(a);
    const y = rank(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] ?? 0) - (y[i] ?? 0);
      if (d) return d;
    }
    return a.plate.localeCompare(b.plate, 'th');
  });
}
