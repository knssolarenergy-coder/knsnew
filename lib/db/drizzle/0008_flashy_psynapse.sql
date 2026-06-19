CREATE TABLE IF NOT EXISTS "complaint_technicians" (
"id" text PRIMARY KEY NOT NULL,
"complaint_id" text NOT NULL,
"technician_id" text NOT NULL,
"assigned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_visit_technicians" (
"id" text PRIMARY KEY NOT NULL,
"site_visit_id" text NOT NULL,
"technician_id" text NOT NULL,
"assigned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "complaint_technicians" ADD CONSTRAINT "complaint_technicians_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "public"."complaints"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "complaint_technicians" ADD CONSTRAINT "complaint_technicians_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "site_visit_technicians" ADD CONSTRAINT "site_visit_technicians_site_visit_id_site_visits_id_fk" FOREIGN KEY ("site_visit_id") REFERENCES "public"."site_visits"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "site_visit_technicians" ADD CONSTRAINT "site_visit_technicians_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- Backfill complaint_technicians from legacy complaints.technician_id
INSERT INTO complaint_technicians (id, complaint_id, technician_id, assigned_at)
SELECT
  to_hex(floor(extract(epoch from now()) * 1000)::bigint) || to_hex(floor(random() * 2147483647)::int),
  c.id,
  c.technician_id,
  c.created_at
FROM complaints c
WHERE c.technician_id IS NOT NULL
  AND c.technician_id != ''
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.technician_id)
  AND NOT EXISTS (
    SELECT 1 FROM complaint_technicians ct
    WHERE ct.complaint_id = c.id AND ct.technician_id = c.technician_id
  );
--> statement-breakpoint

-- Backfill site_visit_technicians from legacy site_visits.assigned_to
INSERT INTO site_visit_technicians (id, site_visit_id, technician_id, assigned_at)
SELECT
  to_hex(floor(extract(epoch from now()) * 1000)::bigint) || to_hex(floor(random() * 2147483647)::int),
  sv.id,
  sv.assigned_to,
  sv.created_at
FROM site_visits sv
WHERE sv.assigned_to IS NOT NULL
  AND sv.assigned_to != ''
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = sv.assigned_to)
  AND NOT EXISTS (
    SELECT 1 FROM site_visit_technicians svt
    WHERE svt.site_visit_id = sv.id AND svt.technician_id = sv.assigned_to
  );
