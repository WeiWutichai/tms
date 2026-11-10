-- review T06: เพิกถอนแล้วคืนสถานะไม่ได้ และแก้ token/สิทธิ์ของลิงก์ที่ออกแล้วไม่ได้
CREATE OR REPLACE FUNCTION tms_magic_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'magic link revocation is permanent' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.actions IS DISTINCT FROM OLD.actions OR NEW.scopes IS DISTINCT FROM OLD.scopes
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.entity_id IS DISTINCT FROM OLD.entity_id THEN
    RAISE EXCEPTION 'magic link terms are immutable — issue a new link' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER magic_link_guard BEFORE UPDATE ON "magic_link" FOR EACH ROW EXECUTE FUNCTION tms_magic_link_guard();
