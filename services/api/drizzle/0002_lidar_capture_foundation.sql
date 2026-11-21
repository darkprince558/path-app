CREATE TYPE "public"."capture_status" AS ENUM('uploading', 'uploaded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."processing_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."scan_revision_status" AS ENUM('draft', 'approved', 'rejected', 'superseded');--> statement-breakpoint
CREATE TABLE "capture_frames" (
	"capture_id" uuid NOT NULL,
	"frame_id" text NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"camera_pose" jsonb NOT NULL,
	"intrinsics" jsonb,
	"timestamp_seconds" double precision,
	"width" integer,
	"height" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_frames_capture_id_frame_id_pk" PRIMARY KEY("capture_id","frame_id"),
	CONSTRAINT "capture_frames_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "capture_frames_id_check" CHECK (length(trim("capture_frames"."frame_id")) > 0),
	CONSTRAINT "capture_frames_sha256_check" CHECK ("capture_frames"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "capture_frames_pose_check" CHECK (jsonb_typeof("capture_frames"."camera_pose") = 'array' AND jsonb_array_length("capture_frames"."camera_pose") = 16),
	CONSTRAINT "capture_frames_timestamp_check" CHECK ("capture_frames"."timestamp_seconds" IS NULL OR ("capture_frames"."timestamp_seconds" >= 0 AND "capture_frames"."timestamp_seconds" < 'Infinity'::float8)),
	CONSTRAINT "capture_frames_dimensions_check" CHECK (("capture_frames"."width" IS NULL AND "capture_frames"."height" IS NULL) OR ("capture_frames"."width" IS NOT NULL AND "capture_frames"."height" IS NOT NULL AND "capture_frames"."width" > 0 AND "capture_frames"."height" > 0))
);
--> statement-breakpoint
CREATE TABLE "captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"device_capture_id" text NOT NULL,
	"manifest_version" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_sha256" text NOT NULL,
	"bundle_object_prefix" text NOT NULL,
	"device" jsonb NOT NULL,
	"coordinate_system" jsonb NOT NULL,
	"entrance_pose" jsonb NOT NULL,
	"tracking_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "capture_status" DEFAULT 'uploading' NOT NULL,
	"captured_at" timestamp with time zone,
	"uploaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "captures_bundle_object_prefix_unique" UNIQUE("bundle_object_prefix"),
	CONSTRAINT "captures_owner_device_unique" UNIQUE("owner_id","device_capture_id"),
	CONSTRAINT "captures_id_space_unique" UNIQUE("id","space_id"),
	CONSTRAINT "captures_device_id_check" CHECK (length(trim("captures"."device_capture_id")) > 0),
	CONSTRAINT "captures_manifest_version_check" CHECK ("captures"."manifest_version" > 0),
	CONSTRAINT "captures_manifest_sha256_check" CHECK ("captures"."manifest_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "captures_manifest_object_check" CHECK (jsonb_typeof("captures"."manifest") = 'object'),
	CONSTRAINT "captures_device_object_check" CHECK (jsonb_typeof("captures"."device") = 'object'),
	CONSTRAINT "captures_coordinate_object_check" CHECK (jsonb_typeof("captures"."coordinate_system") = 'object'),
	CONSTRAINT "captures_entrance_pose_check" CHECK (jsonb_typeof("captures"."entrance_pose") = 'array' AND jsonb_array_length("captures"."entrance_pose") = 16),
	CONSTRAINT "captures_tracking_warnings_check" CHECK (jsonb_typeof("captures"."tracking_warnings") = 'array'),
	CONSTRAINT "captures_uploaded_at_check" CHECK ("captures"."status" <> 'uploaded' OR "captures"."uploaded_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "processing_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"capture_id" uuid NOT NULL,
	"job_type" text DEFAULT 'capture' NOT NULL,
	"idempotency_key" text NOT NULL,
	"input_sha256" text NOT NULL,
	"processor_version" text NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "processing_job_status" DEFAULT 'queued' NOT NULL,
	"stage" text,
	"progress" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processing_jobs_capture_key_unique" UNIQUE("capture_id","idempotency_key"),
	CONSTRAINT "processing_jobs_id_capture_unique" UNIQUE("id","capture_id"),
	CONSTRAINT "processing_jobs_key_check" CHECK (length(trim("processing_jobs"."idempotency_key")) > 0),
	CONSTRAINT "processing_jobs_type_check" CHECK (length(trim("processing_jobs"."job_type")) > 0),
	CONSTRAINT "processing_jobs_version_check" CHECK (length(trim("processing_jobs"."processor_version")) > 0),
	CONSTRAINT "processing_jobs_input_sha256_check" CHECK ("processing_jobs"."input_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "processing_jobs_progress_check" CHECK ("processing_jobs"."progress" BETWEEN 0 AND 100),
	CONSTRAINT "processing_jobs_attempts_check" CHECK ("processing_jobs"."attempt_count" >= 0),
	CONSTRAINT "processing_jobs_lease_check" CHECK (("processing_jobs"."lease_token" IS NULL) = ("processing_jobs"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "scan_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"capture_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"processing_job_id" uuid NOT NULL,
	"scan_id" uuid,
	"revision" integer NOT NULL,
	"status" "scan_revision_status" DEFAULT 'draft' NOT NULL,
	"object_key" text NOT NULL,
	"graph_object_key" text,
	"output_sha256" text NOT NULL,
	"transform" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scan_revisions_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "scan_revisions_capture_revision_unique" UNIQUE("capture_id","revision"),
	CONSTRAINT "scan_revisions_number_check" CHECK ("scan_revisions"."revision" > 0),
	CONSTRAINT "scan_revisions_output_sha256_check" CHECK ("scan_revisions"."output_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "scan_revisions_transform_check" CHECK (jsonb_typeof("scan_revisions"."transform") = 'array' AND jsonb_array_length("scan_revisions"."transform") = 16),
	CONSTRAINT "scan_revisions_approval_pair_check" CHECK (("scan_revisions"."approved_by" IS NULL) = ("scan_revisions"."approved_at" IS NULL)),
	CONSTRAINT "scan_revisions_approval_state_check" CHECK (("scan_revisions"."status" IN ('approved', 'superseded') AND "scan_revisions"."approved_by" IS NOT NULL) OR ("scan_revisions"."status" IN ('draft', 'rejected') AND "scan_revisions"."approved_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_id_space_unique" UNIQUE("id","space_id");--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_id_owner_unique" UNIQUE("id","owner_id");--> statement-breakpoint
ALTER TABLE "capture_frames" ADD CONSTRAINT "capture_frames_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_space_owner_fk" FOREIGN KEY ("space_id","owner_id") REFERENCES "public"."spaces"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_revisions" ADD CONSTRAINT "scan_revisions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_revisions" ADD CONSTRAINT "scan_revisions_capture_space_fk" FOREIGN KEY ("capture_id","space_id") REFERENCES "public"."captures"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_revisions" ADD CONSTRAINT "scan_revisions_job_capture_fk" FOREIGN KEY ("processing_job_id","capture_id") REFERENCES "public"."processing_jobs"("id","capture_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_revisions" ADD CONSTRAINT "scan_revisions_scan_space_fk" FOREIGN KEY ("scan_id","space_id") REFERENCES "public"."scans"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "captures_space_idx" ON "captures" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "captures_status_idx" ON "captures" USING btree ("status");--> statement-breakpoint
CREATE INDEX "processing_jobs_queue_idx" ON "processing_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "processing_jobs_lease_idx" ON "processing_jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "scan_revisions_scan_idx" ON "scan_revisions" USING btree ("scan_id");--> statement-breakpoint
CREATE INDEX "scan_revisions_space_status_idx" ON "scan_revisions" USING btree ("space_id","status");--> statement-breakpoint
CREATE INDEX "scan_revisions_job_idx" ON "scan_revisions" USING btree ("processing_job_id");--> statement-breakpoint
