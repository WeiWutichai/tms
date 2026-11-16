/** ค่าที่บันทึก (ไม่รวม version) */
export interface PrefBody {
  view: string;
  cardFields: string[];
}
export interface PrefValue extends PrefBody {
  version: number;
}

export interface PrefSaverDeps {
  /** PUT — `version` undefined = ไม่ส่ง If-Match (สร้างหรือแทนค่า) */
  put(body: PrefBody, version: number | undefined): Promise<PrefValue>;
  /** GET ค่าล่าสุดจาก server */
  get(): Promise<PrefValue>;
  /** ค่าที่ UI แสดงอยู่ (cache) — undefined = ยังไม่มี/โหลดไม่สำเร็จ */
  read(): PrefValue | undefined;
  write(v: PrefValue): void;
  /** บันทึกไม่สำเร็จหลังลองซ้ำแล้ว — `conflict` = ถูกเปลี่ยนจากหน้าจอ/เครื่องอื่น (412) */
  fail(conflict: boolean): void;
  fallback: PrefValue;
}

const is412 = (e: unknown) =>
  !!e && typeof e === 'object' && (e as { problem?: { status?: number } }).problem?.status === 412;

/**
 * บันทึกมุมมองกระดานทีละคำขอ (ST3-T13 review/QA): แสดงผลทันที · ระหว่างรอ server เก็บเฉพาะค่าล่าสุดที่ผู้ใช้เลือก
 * (รวมการกดรัว ๆ เป็นคำขอเดียว) · ใช้ version จากคำตอบก่อนหน้าเสมอ · 412 → อ่านค่าใหม่แล้วลองซ้ำ 1 ครั้งด้วยค่าล่าสุด
 * ของผู้ใช้ (ค่าส่วนตัว — ผู้ใช้กดทีหลังชนะ) · ยังไม่สำเร็จ → ย้อน UI เป็นค่าที่ server ยืนยันล่าสุด + แจ้ง
 */
export function createPrefSaver(d: PrefSaverDeps) {
  let busy = false;
  let pending: PrefBody | null = null;
  /** ค่าที่ server ยืนยันล่าสุด (ใช้ย้อน UI) */
  let confirmed: PrefValue | undefined;
  /** version ล่าสุดที่รู้จาก server — undefined = ยังไม่รู้ (GET ไม่สำเร็จ) → ไม่ส่ง If-Match */
  let version: number | undefined;

  async function pump() {
    busy = true;
    while (pending) {
      const body = pending;
      pending = null;
      try {
        const r = await d.put(body, version);
        version = r.version;
        confirmed = r;
        if (!pending) d.write(r);
      } catch (e) {
        let conflict = is412(e);
        let ok = false;
        if (conflict) {
          try {
            const fresh = await d.get();
            version = fresh.version;
            confirmed = fresh;
            const latest = pending ?? body;
            pending = null;
            const r = await d.put(latest, version);
            version = r.version;
            confirmed = r;
            if (!pending) d.write(r);
            ok = true;
          } catch (e2) {
            conflict = is412(e2);
          }
        }
        if (!ok) {
          pending = null;
          d.write(confirmed ?? d.fallback);
          d.fail(conflict);
        }
      }
    }
    busy = false;
  }

  return {
    save(body: PrefBody) {
      const cur = d.read();
      if (!busy) {
        confirmed = cur;
        version = cur?.version;
      }
      d.write({ ...body, version: cur?.version ?? 0 });
      pending = body;
      if (!busy) return pump();
      return undefined;
    },
  };
}
