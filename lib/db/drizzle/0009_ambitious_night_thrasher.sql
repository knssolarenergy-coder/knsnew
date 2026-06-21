CREATE TABLE "technician_location_history" (
	"id" text PRIMARY KEY NOT NULL,
	"technician_id" text NOT NULL,
	"latitude" text NOT NULL,
	"longitude" text NOT NULL,
	"recorded_at" timestamp NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "technician_locations" ALTER COLUMN "attendance_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "technician_location_history" ADD CONSTRAINT "technician_location_history_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;