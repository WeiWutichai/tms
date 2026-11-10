-- review T18: ข้อมูลแพ็กเกจ/override ต้องถูกต้องที่ระดับฐาน
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_plan_code_fkey" FOREIGN KEY ("plan_code") REFERENCES "plan"("code") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "plan_entitlement" ADD CONSTRAINT "plan_entitlement_plan_code_fkey" FOREIGN KEY ("plan_code") REFERENCES "plan"("code") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "plan_entitlement" ADD CONSTRAINT "plan_entitlement_mode_check" CHECK ("mode" IN ('included', 'addon', 'not_available'));
ALTER TABLE "tenant_entitlement_override" ADD CONSTRAINT "tenant_entitlement_override_mode_check" CHECK ("mode" IN ('grant', 'revoke', 'set_limit'));
ALTER TABLE "tenant_entitlement_override" ADD CONSTRAINT "tenant_entitlement_override_reason_check" CHECK (char_length(btrim("reason")) >= 10);
ALTER TABLE "tenant_entitlement_override" ADD CONSTRAINT "tenant_entitlement_override_limit_check" CHECK ("mode" <> 'set_limit' OR "limit" IS NOT NULL);
