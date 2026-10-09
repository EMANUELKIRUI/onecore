ALTER TABLE "business_settings"
  ADD COLUMN "contact_email" varchar(320),
  ADD COLUMN "contact_phone" varchar(50),
  ADD COLUMN "website" varchar(2048),
  ADD COLUMN "address_country_code" varchar(2),
  ADD COLUMN "address_region" varchar(100),
  ADD COLUMN "address_city" varchar(100),
  ADD COLUMN "address" varchar(300);

INSERT INTO "business_settings" (
  "organization_id",
  "contact_email",
  "contact_phone",
  "website",
  "address_country_code",
  "address_region",
  "address_city",
  "address"
)
SELECT
  "organizations"."id",
  lower("organizations"."profile"->'application'->>'contactEmail'),
  "organizations"."profile"->'application'->>'contactPhone',
  "organizations"."profile"->'application'->>'website',
  "organizations"."profile"->'application'->>'countryCode',
  "organizations"."profile"->'application'->>'region',
  "organizations"."profile"->'application'->>'city',
  "organizations"."profile"->'application'->>'address'
FROM "organizations"
WHERE "organizations"."status" = 'ACTIVE'
  AND jsonb_typeof("organizations"."profile"->'application') = 'object'
ON CONFLICT ("organization_id") DO UPDATE
SET
  "contact_email" = coalesce("business_settings"."contact_email", EXCLUDED."contact_email"),
  "contact_phone" = coalesce("business_settings"."contact_phone", EXCLUDED."contact_phone"),
  "website" = coalesce("business_settings"."website", EXCLUDED."website"),
  "address_country_code" = coalesce("business_settings"."address_country_code", EXCLUDED."address_country_code"),
  "address_region" = coalesce("business_settings"."address_region", EXCLUDED."address_region"),
  "address_city" = coalesce("business_settings"."address_city", EXCLUDED."address_city"),
  "address" = coalesce("business_settings"."address", EXCLUDED."address");
