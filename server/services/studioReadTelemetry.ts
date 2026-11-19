/** Decoded blob bytes, NOT PostgreSQL wire bytes or billable provider egress.
 * Fixed labels only. No IDs, URLs, SQL, user data, or payloads are retained.
 * Process-local, five-minute aggregates; a restart can lose the current window.
 */
export const STUDIO_READ_ROUTES = ['image', 'media', 'media-preview', 'canva-proof', 'export-png', 'export-zip', 'publication-prepare', 'comic-export', 'export-other'] as const;
export type StudioReadRoute = typeof STUDIO_READ_ROUTES[number];
export function createStudioReadTelemetry(emit: (line: string) => void) {
  const buckets = new Map<StudioReadRoute, { reads: number; blobs: number; bytes: number }>();
  const add = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
  return {
    record(route: StudioReadRoute, blob: Buffer | null | undefined) {
      // Runtime guard also bounds cardinality when called from plain JS.
      if (!STUDIO_READ_ROUTES.includes(route)) return;
      const row = buckets.get(route) ?? { reads: 0, blobs: 0, bytes: 0 };
      row.reads = add(row.reads, 1);
      if (Buffer.isBuffer(blob)) { row.blobs = add(row.blobs, 1); row.bytes = add(row.bytes, blob.length); }
      buckets.set(route, row);
    },
    flush() {
      if (!buckets.size) return;
      const routes = Object.fromEntries(buckets);
      buckets.clear();
      // Observability must never break serving content, even if the sink fails.
      try { emit(JSON.stringify({ event: 'studio_db_blob_reads', windowSeconds: 300, routes })); } catch { /* best effort */ }
    },
  };
}
const telemetry = createStudioReadTelemetry(line => console.info(line));
let timer: ReturnType<typeof setInterval> | undefined;
export function recordStudioBlobRead(route: StudioReadRoute, blob: Buffer | null | undefined) {
  if (process.env.NODE_ENV !== 'production') return;
  telemetry.record(route, blob);
  timer ??= setInterval(() => telemetry.flush(), 300_000).unref();
}
