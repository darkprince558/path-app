# LiDAR ingestion contract handoff

Date: 21 November 2026. Human owner: Sam. Producer: Anish. Frame consumer: Krishna.

The backend version-1 convention is recorded in [the API contract](../docs/capture-api.md)
and [synthetic manifest](../fixtures/lidar-capture/manifest.json). Registration accepts
`{spaceId,manifest}`; uploads accept one raw inventory file; finalization verifies the
bundle, records stable frame references and marks it uploaded. Finalization now also
queues one persistent job for the [separate processing worker](../docs/capture-processing.md).

Evidence: [ingestion tests](../services/api/src/lib/api/captures.test.ts) exercise
route handlers with signed synthetic JWTs through existing verification/user sync,
local PostgreSQL and private filesystem storage. The external JWKS response is
synthetic. They reject corrupt/missing files, foreign owners, unsafe paths,
duplicate/dangling frame IDs and post-finalization writes.

Next: Anish must adapt/confirm native exporter JSON, frame/entrance pose semantics
and measured file sizes against this example before real uploads. Krishna should
identify evidence by `(captureId,frameId)`, not filenames alone. This version uses
metric Y-up, right-handed column-major camera-to-capture poses; it does not prove
the physical export matches that declaration. No physical phone capture or live
Auth0 login was verified. Preserve existing relative-unit scans and private frames.
