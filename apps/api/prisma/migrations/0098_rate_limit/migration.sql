-- ST7-T08 Rate limit (docs/04 G1 "Rate limit", J "Rate limiting"; docs/01 §5.1; spec/07 INT-081/082; spec/11 §12)
-- (1) โปรไฟล์ rate limit ต่อแพ็กเกจ (`rateLimitProfile`) + ทับรายบริษัท (null = ตามแพ็กเกจ) — ค่าของแต่ละโปรไฟล์อยู่ในโค้ด
--     (apps/api/src/http/rate-limit/profiles.ts) · แก้ได้เฉพาะ role platform (Console) เหมือน plan_code
ALTER TABLE "plan" ADD COLUMN "rate_limit_profile" VARCHAR(20) NOT NULL DEFAULT 'standard';
ALTER TABLE "tenant" ADD COLUMN "rate_limit_profile" VARCHAR(20);
ALTER TABLE "plan" ADD CONSTRAINT "plan_rate_limit_profile_check" CHECK ("rate_limit_profile" IN ('standard', 'high'));
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_rate_limit_profile_check" CHECK ("rate_limit_profile" IN ('standard', 'high'));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE UPDATE (rate_limit_profile) ON tenant FROM tms_app';
  END IF;
END $$;

-- (2) ที่เก็บ bucket กลาง ใช้ร่วมทุก instance ของ API — UNLOGGED (ไม่เขียน WAL: เร็ว, ข้อมูลหายตอน crash = bucket เต็มใหม่ ยอมรับได้)
--     key = "<ขอบเขต>:<id>" (เช่น t:<tenant>, k:<api key>, u:<tenant>:<user>, ip:<ip>, lw:<link>) — ไม่มี tenant_id จึงไม่มี RLS
--     (ไม่มีข้อมูลธุรกิจ; แอป role tms_app อ่าน/เขียนได้ตาม default privileges)
--     tat  = GCRA theoretical arrival time (token bucket แบบ rate + burst)
--     hits = เวลาของคำขอในหน้าต่างเลื่อน (sliding window log: N ครั้ง ต่อ W มิลลิวินาที — ตัวจำกัดเดิมที่ย้ายมา)
CREATE UNLOGGED TABLE "rate_limit_bucket" (
    "key" TEXT NOT NULL,
    "tat" TIMESTAMPTZ(6),
    "hits" TIMESTAMPTZ(6)[],
    CONSTRAINT "rate_limit_bucket_pkey" PRIMARY KEY ("key")
) WITH (fillfactor = 70);

-- (3) ตัดหลาย bucket พร้อมกันแบบ all-or-nothing ใน round trip เดียว (ล็อกแถวตามลำดับ key กัน deadlock)
--     p_kinds: 'g' = GCRA (p_period_ms = ช่วงห่างต่อ 1 token, p_limit = burst) · 'w' = sliding window (p_period_ms = หน้าต่าง, p_limit = N)
--     คืนต่อ bucket: allowed (ทุกตัวต้องผ่านจึงตัด), remaining, retry_ms (รอเท่าไรจึงผ่าน), reset_ms (อีกนานเท่าไรจึงเต็ม)
CREATE OR REPLACE FUNCTION tms_rate_limit_take(
  p_keys TEXT[], p_kinds TEXT[], p_period_ms DOUBLE PRECISION[], p_limit INT[], p_cost INT[]
) RETURNS TABLE (idx INT, allowed BOOLEAN, remaining INT, retry_ms BIGINT, reset_ms BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  n INT := coalesce(array_length(p_keys, 1), 0);
  now_ms DOUBLE PRECISION := extract(epoch FROM clock_timestamp()) * 1000;
  i INT;
  r RECORD;
  per DOUBLE PRECISION; lim INT; cost INT;
  base DOUBLE PRECISION; nt DOUBLE PRECISION;
  live DOUBLE PRECISION[];
  c INT;
  ok BOOLEAN[] := '{}'; rem INT[] := '{}'; retry BIGINT[] := '{}'; rst BIGINT[] := '{}';
  new_tat DOUBLE PRECISION[] := '{}'; new_hits TEXT[] := '{}';
  all_ok BOOLEAN := true;
BEGIN
  IF n = 0 THEN RETURN; END IF;
  INSERT INTO rate_limit_bucket ("key") SELECT k FROM unnest(p_keys) AS k ORDER BY k ON CONFLICT DO NOTHING;
  PERFORM 1 FROM rate_limit_bucket WHERE "key" = ANY (p_keys) ORDER BY "key" FOR UPDATE;
  FOR i IN 1..n LOOP
    per := p_period_ms[i]; lim := p_limit[i]; cost := p_cost[i];
    SELECT b.tat, b.hits INTO r FROM rate_limit_bucket b WHERE b."key" = p_keys[i];
    IF p_kinds[i] = 'g' THEN
      base := greatest(coalesce(extract(epoch FROM r.tat) * 1000, now_ms), now_ms);
      nt := base + cost * per;
      IF nt - now_ms <= lim * per + 0.001 THEN
        ok := ok || true;
        rem := rem || greatest(floor((lim * per - (nt - now_ms)) / per + 0.000001), 0)::INT;
        retry := retry || 0::BIGINT;
        rst := rst || ceil(nt - now_ms)::BIGINT;
      ELSE
        ok := ok || false; all_ok := false;
        rem := rem || greatest(floor((lim * per - (base - now_ms)) / per + 0.000001), 0)::INT;
        retry := retry || ceil(nt - now_ms - lim * per)::BIGINT;
        rst := rst || ceil(base - now_ms)::BIGINT;
      END IF;
      new_tat := new_tat || nt;
      new_hits := new_hits || NULL::TEXT;
    ELSE
      SELECT coalesce(array_agg(t ORDER BY t), '{}') INTO live
        FROM (SELECT extract(epoch FROM h) * 1000 AS t FROM unnest(coalesce(r.hits, '{}')) AS h) x
        WHERE t > now_ms - per;
      c := coalesce(array_length(live, 1), 0);
      IF c + cost <= lim THEN
        ok := ok || true;
        rem := rem || (lim - c - cost);
        retry := retry || 0::BIGINT;
        rst := rst || ceil(per)::BIGINT;
        FOR j IN 1..cost LOOP live := live || now_ms; END LOOP;
      ELSE
        ok := ok || false; all_ok := false;
        rem := rem || greatest(lim - c, 0);
        retry := retry || CASE WHEN cost > lim OR c + cost - lim > c THEN ceil(per)::BIGINT
                               ELSE greatest(ceil(live[c + cost - lim] + per - now_ms), 1)::BIGINT END;
        rst := rst || CASE WHEN c = 0 THEN 0::BIGINT ELSE ceil(live[c] + per - now_ms)::BIGINT END;
      END IF;
      new_tat := new_tat || NULL::DOUBLE PRECISION;
      new_hits := new_hits || array_to_string(live, ',');
    END IF;
  END LOOP;
  IF all_ok THEN
    FOR i IN 1..n LOOP
      IF p_kinds[i] = 'g' THEN
        UPDATE rate_limit_bucket SET tat = to_timestamp(new_tat[i] / 1000) WHERE "key" = p_keys[i];
      ELSE
        UPDATE rate_limit_bucket
           SET hits = (SELECT coalesce(array_agg(to_timestamp(v::DOUBLE PRECISION / 1000) ORDER BY v::DOUBLE PRECISION), '{}')
                         FROM unnest(string_to_array(new_hits[i], ',')) AS v)
         WHERE "key" = p_keys[i];
      END IF;
    END LOOP;
  END IF;
  FOR i IN 1..n LOOP
    idx := i - 1; allowed := all_ok AND ok[i]; remaining := rem[i]; retry_ms := retry[i]; reset_ms := rst[i];
    -- bucket ที่ผ่านแต่ตัวอื่นไม่ผ่าน = ไม่ถูกตัด → คงค่าก่อนตัด (remaining + cost)
    IF NOT all_ok AND ok[i] THEN remaining := rem[i] + p_cost[i]; END IF;
    RETURN NEXT;
  END LOOP;
END $$;
