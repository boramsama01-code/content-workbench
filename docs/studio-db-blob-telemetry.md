# Studio DB blob-read diagnostics

Production emits at most one `studio_db_blob_reads` JSON line per process per five-minute window, and nothing for idle windows. Fixed keys identify image, original media, media preview, Canva proof, PNG export, ZIP export, publication preparation, comic export, and other export reads. Each has `reads` (successful SELECT calls including misses), `blobs` (returned non-null buffers), and `bytes` (decoded buffer lengths). Cached reuse within one export is not counted twice.

No IDs, paths, query strings, SQL, account data, or payload contents are stored or emitted. Counters have nine fixed buckets, saturate at MAX_SAFE_INTEGER, reset after each flush, and keep no blobs. This uses ordinary service logs only, no new database writes, API endpoint, external telemetry service, or paid component. Sink failures cannot fail requests. Tests do not emit telemetry.

Limitations: these are decoded blob bytes, not PostgreSQL wire transfer or Neon billable egress; bytea encoding/protocol overhead may differ. Coverage is the explicitly instrumented Studio asset-serving and export paths, not every database read. Errors before a SELECT completes are uncounted. Process restart can lose the current window; each instance has independent windows. Do not equate the totals with Neon billing or claim a whole-service reduction from these alone.

The accompanying projection fix selects only the requested media blob: preview requests no longer pull original video bytes, and original requests omit preview bytes. HTTP status/range handling, response content, ownership/session checks, and cache headers are unchanged. Video range requests still read the full original video; changing that requires separate parity tests and review.
