CREATE TABLE "complaint_technicians" (
	"id" text PRIMARY KEY NOT NULL,
	"complaint_id" text NOT NULL,
	"technician_id" text NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_visit_technicians" (
	"id" text PRIMARY KEY NOT NULL,
	"site_visit_id" text NOT NULL,
	"technician_id" text NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "complaint_technicians" ADD CONSTRAINT "complaint_technicians_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "public"."complaints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_technicians" ADD CONSTRAINT "complaint_technicians_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_visit_technicians" ADD CONSTRAINT "site_visit_technicians_site_visit_id_site_visits_id_fk" FOREIGN KEY ("site_visit_id") REFERENCES "public"."site_visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_visit_technicians" ADD CONSTRAINT "site_visit_technicians_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;