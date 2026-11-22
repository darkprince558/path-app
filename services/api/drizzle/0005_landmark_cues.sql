CREATE TYPE "public"."landmark_cue_confidence" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."landmark_cue_status" AS ENUM('draft', 'approved', 'rejected', 'abstained');--> statement-breakpoint
CREATE TABLE "landmark_cues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"route_segment_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"landmark" text,
	"instruction" text NOT NULL,
	"draft_instruction" text,
	"confidence" "landmark_cue_confidence",
	"status" "landmark_cue_status" DEFAULT 'draft' NOT NULL,
	"source_frame_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"prompt_version" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landmark_cues_revision_segment_unique" UNIQUE("revision_id","route_segment_id"),
	CONSTRAINT "landmark_cues_sequence_check" CHECK ("landmark_cues"."sequence" >= 0),
	CONSTRAINT "landmark_cues_segment_check" CHECK (length(trim("landmark_cues"."route_segment_id")) BETWEEN 1 AND 200),
	CONSTRAINT "landmark_cues_instruction_check" CHECK (length("landmark_cues"."instruction") <= 200 AND ("landmark_cues"."status" IN ('abstained', 'rejected') OR length(trim("landmark_cues"."instruction")) >= 1)),
	CONSTRAINT "landmark_cues_frames_check" CHECK (jsonb_typeof("landmark_cues"."source_frame_ids") = 'array'),
	CONSTRAINT "landmark_cues_decision_pair_check" CHECK (("landmark_cues"."decided_by" IS NULL) = ("landmark_cues"."decided_at" IS NULL)),
	CONSTRAINT "landmark_cues_decision_state_check" CHECK (("landmark_cues"."status" IN ('approved', 'rejected')) = ("landmark_cues"."decided_by" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "landmark_cues" ADD CONSTRAINT "landmark_cues_revision_id_scan_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."scan_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landmark_cues" ADD CONSTRAINT "landmark_cues_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "landmark_cues_revision_sequence_idx" ON "landmark_cues" USING btree ("revision_id","sequence");