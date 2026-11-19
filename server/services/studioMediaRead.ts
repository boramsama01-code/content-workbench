import { eq } from 'drizzle-orm';
import { studioMedia } from '../../shared/schema';
import type { DB } from '../db';
import { recordStudioBlobRead } from './studioReadTelemetry';

/** Never fetch a full uploaded video to serve its small preview (or vice versa). */
export async function readStudioMedia(db: DB, id: number, preview: boolean) {
  const [media] = await db.select({ id: studioMedia.id, kind: studioMedia.kind, mimeType: studioMedia.mimeType,
    bytes: preview ? studioMedia.preview : studioMedia.bytes,
  }).from(studioMedia).where(eq(studioMedia.id, id));
  recordStudioBlobRead(preview ? 'media-preview' : 'media', media?.bytes);
  return media;
}
