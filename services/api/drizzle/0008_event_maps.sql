CREATE TABLE "event_maps" (
	"event_id" uuid NOT NULL,
	"scan_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_maps_event_id_scan_id_pk" PRIMARY KEY("event_id","scan_id")
);
--> statement-breakpoint
ALTER TABLE "event_maps" ADD CONSTRAINT "event_maps_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_maps" ADD CONSTRAINT "event_maps_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_maps_scan_idx" ON "event_maps" USING btree ("scan_id");