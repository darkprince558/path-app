CREATE UNIQUE INDEX "processing_jobs_one_running" ON "processing_jobs" USING btree ((1)) WHERE "processing_jobs"."status" = 'running';--> statement-breakpoint
ALTER TABLE "scan_revisions" ADD CONSTRAINT "scan_revisions_job_unique" UNIQUE("processing_job_id");
--> statement-breakpoint
-- Output/provenance fields are immutable. Approval fields may change independently.
CREATE FUNCTION protect_scan_revision_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.capture_id, NEW.space_id, NEW.processing_job_id, NEW.scan_id,
         NEW.revision, NEW.object_key, NEW.graph_object_key, NEW.output_sha256,
         NEW.transform, NEW.metadata, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.capture_id, OLD.space_id, OLD.processing_job_id, OLD.scan_id,
         OLD.revision, OLD.object_key, OLD.graph_object_key, OLD.output_sha256,
         OLD.transform, OLD.metadata, OLD.created_at) THEN
    RAISE EXCEPTION 'Scan revision content is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER scan_revisions_immutable_content BEFORE UPDATE ON scan_revisions
FOR EACH ROW EXECUTE FUNCTION protect_scan_revision_content();
