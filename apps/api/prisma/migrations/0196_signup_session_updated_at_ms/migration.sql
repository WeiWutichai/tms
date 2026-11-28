-- cursor ความละเอียด ms (ST7-T11 conformance): signup_session.updated_at → TIMESTAMPTZ(3)
ALTER TABLE "signup_session" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);
