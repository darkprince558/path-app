CREATE TYPE "public"."event_role" AS ENUM('member', 'organizer');--> statement-breakpoint
CREATE TYPE "public"."scan_format" AS ENUM('ply', 'glb');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('private', 'unlisted', 'public');--> statement-breakpoint
CREATE TABLE "destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	CONSTRAINT "destinations_id_space_unique" UNIQUE("id","space_id")
);
--> statement-breakpoint
CREATE TABLE "event_destinations" (
	"event_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	CONSTRAINT "event_destinations_event_id_destination_id_pk" PRIMARY KEY("event_id","destination_id")
);
--> statement-breakpoint
CREATE TABLE "event_members" (
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "event_role" DEFAULT 'member' NOT NULL,
	CONSTRAINT "event_members_event_id_user_id_pk" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "event_paths" (
	"event_id" uuid NOT NULL,
	"path_id" uuid NOT NULL,
	CONSTRAINT "event_paths_event_id_path_id_pk" PRIMARY KEY("event_id","path_id")
);
--> statement-breakpoint
CREATE TABLE "event_spaces" (
	"event_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	CONSTRAINT "event_spaces_event_id_space_id_pk" PRIMARY KEY("event_id","space_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"invite_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_invite_code_unique" UNIQUE("invite_code")
);
--> statement-breakpoint
CREATE TABLE "nav_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"from_node_id" uuid NOT NULL,
	"to_node_id" uuid NOT NULL,
	"distance" double precision NOT NULL,
	"accessible" boolean DEFAULT true NOT NULL,
	"bidirectional" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "nav_edges_distance_check" CHECK ("nav_edges"."distance" > 0 AND "nav_edges"."distance" < 'Infinity'::float8),
	CONSTRAINT "nav_edges_distinct_nodes_check" CHECK ("nav_edges"."from_node_id" <> "nav_edges"."to_node_id")
);
--> statement-breakpoint
CREATE TABLE "nav_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"z" double precision NOT NULL,
	"floor" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "nav_nodes_id_space_unique" UNIQUE("id","space_id"),
	CONSTRAINT "nav_nodes_finite_check" CHECK ("nav_nodes"."x" > '-Infinity'::float8 AND "nav_nodes"."x" < 'Infinity'::float8 AND "nav_nodes"."y" > '-Infinity'::float8 AND "nav_nodes"."y" < 'Infinity'::float8 AND "nav_nodes"."z" > '-Infinity'::float8 AND "nav_nodes"."z" < 'Infinity'::float8)
);
--> statement-breakpoint
CREATE TABLE "path_waypoints" (
	"path_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	CONSTRAINT "path_waypoints_path_id_sequence_pk" PRIMARY KEY("path_id","sequence"),
	CONSTRAINT "path_waypoints_sequence_check" CHECK ("path_waypoints"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "paths" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paths_id_space_unique" UNIQUE("id","space_id")
);
--> statement-breakpoint
CREATE TABLE "scan_viewers" (
	"scan_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "scan_viewers_scan_id_user_id_pk" PRIMARY KEY("scan_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"object_key" text NOT NULL,
	"share_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"format" "scan_format" NOT NULL,
	"status" "scan_status" DEFAULT 'pending' NOT NULL,
	"byte_size" integer,
	"transform" jsonb NOT NULL,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scans_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "scans_share_id_unique" UNIQUE("share_id"),
	CONSTRAINT "scans_byte_size_check" CHECK ("scans"."byte_size" IS NULL OR "scans"."byte_size" >= 0),
	CONSTRAINT "scans_transform_length_check" CHECK (jsonb_typeof("scans"."transform") = 'array' AND jsonb_array_length("scans"."transform") = 16)
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"boundary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth0_sub" text NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_auth0_sub_unique" UNIQUE("auth0_sub")
);
--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_node_id_space_id_nav_nodes_id_space_id_fk" FOREIGN KEY ("node_id","space_id") REFERENCES "public"."nav_nodes"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_destinations" ADD CONSTRAINT "event_destinations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_destinations" ADD CONSTRAINT "event_destinations_destination_id_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_members" ADD CONSTRAINT "event_members_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_members" ADD CONSTRAINT "event_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_paths" ADD CONSTRAINT "event_paths_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_paths" ADD CONSTRAINT "event_paths_path_id_paths_id_fk" FOREIGN KEY ("path_id") REFERENCES "public"."paths"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_spaces" ADD CONSTRAINT "event_spaces_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_spaces" ADD CONSTRAINT "event_spaces_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nav_edges" ADD CONSTRAINT "nav_edges_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nav_edges" ADD CONSTRAINT "nav_edges_from_node_id_space_id_nav_nodes_id_space_id_fk" FOREIGN KEY ("from_node_id","space_id") REFERENCES "public"."nav_nodes"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nav_edges" ADD CONSTRAINT "nav_edges_to_node_id_space_id_nav_nodes_id_space_id_fk" FOREIGN KEY ("to_node_id","space_id") REFERENCES "public"."nav_nodes"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nav_nodes" ADD CONSTRAINT "nav_nodes_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_waypoints" ADD CONSTRAINT "path_waypoints_path_fk" FOREIGN KEY ("path_id","space_id") REFERENCES "public"."paths"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_waypoints" ADD CONSTRAINT "path_waypoints_node_fk" FOREIGN KEY ("node_id","space_id") REFERENCES "public"."nav_nodes"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paths" ADD CONSTRAINT "paths_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paths" ADD CONSTRAINT "paths_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_viewers" ADD CONSTRAINT "scan_viewers_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_viewers" ADD CONSTRAINT "scan_viewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "destinations_space_idx" ON "destinations" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "event_destinations_destination_idx" ON "event_destinations" USING btree ("destination_id");--> statement-breakpoint
CREATE INDEX "event_members_user_idx" ON "event_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "event_paths_path_idx" ON "event_paths" USING btree ("path_id");--> statement-breakpoint
CREATE INDEX "event_spaces_space_idx" ON "event_spaces" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "events_owner_idx" ON "events" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "events_visibility_idx" ON "events" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "nav_edges_space_idx" ON "nav_edges" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "nav_edges_from_idx" ON "nav_edges" USING btree ("from_node_id");--> statement-breakpoint
CREATE INDEX "nav_edges_to_idx" ON "nav_edges" USING btree ("to_node_id");--> statement-breakpoint
CREATE INDEX "nav_nodes_space_idx" ON "nav_nodes" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "path_waypoints_node_idx" ON "path_waypoints" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "paths_space_idx" ON "paths" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "paths_owner_idx" ON "paths" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "paths_visibility_idx" ON "paths" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "scan_viewers_user_idx" ON "scan_viewers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scans_space_idx" ON "scans" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "scans_owner_idx" ON "scans" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "scans_visibility_status_idx" ON "scans" USING btree ("visibility","status");--> statement-breakpoint
CREATE INDEX "spaces_owner_idx" ON "spaces" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "spaces_visibility_idx" ON "spaces" USING btree ("visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_unique" ON "users" USING btree ("username");