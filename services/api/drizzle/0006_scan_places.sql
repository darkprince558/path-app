CREATE TYPE "public"."scan_place_category" AS ENUM('room', 'entrance', 'exit', 'washroom', 'stairs', 'elevator', 'office', 'food', 'info', 'other');--> statement-breakpoint
CREATE TABLE "scan_places" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" "scan_place_category" DEFAULT 'room' NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"z" double precision NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scan_places_name_check" CHECK (length(trim("scan_places"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "scan_places_finite_check" CHECK ("scan_places"."x" > '-Infinity'::float8 AND "scan_places"."x" < 'Infinity'::float8 AND "scan_places"."y" > '-Infinity'::float8 AND "scan_places"."y" < 'Infinity'::float8 AND "scan_places"."z" > '-Infinity'::float8 AND "scan_places"."z" < 'Infinity'::float8)
);
--> statement-breakpoint
ALTER TABLE "scan_places" ADD CONSTRAINT "scan_places_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_places" ADD CONSTRAINT "scan_places_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scan_places_scan_idx" ON "scan_places" USING btree ("scan_id");