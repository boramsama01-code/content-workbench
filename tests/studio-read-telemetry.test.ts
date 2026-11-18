import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStudioReadTelemetry, STUDIO_READ_ROUTES, recordStudioBlobRead } from '../server/services/studioReadTelemetry';
import { readStudioMedia } from '../server/services/studioMediaRead';
import { studioMedia } from '../shared/schema';
import type { DB } from '../server/db';
import { PgDialect } from 'drizzle-orm/pg-core';

afterEach(() => { vi.clearAllTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe('bounded blob-read telemetry', () => {
  it('logs only aggregate fixed labels/counts/bytes, resets, and skips idle windows', () => {
    const output: string[] = []; const t = createStudioReadTelemetry(s => output.push(s));
    t.flush(); expect(output).toEqual([]);
    t.record('media-preview', Buffer.from('SECRET_PAYLOAD'));
    t.record('media-preview', null); t.record('image', Buffer.alloc(2));
    t.record('/studio/media/123?token=secret' as any, Buffer.alloc(100));
    t.flush(); t.flush(); expect(output).toHaveLength(1);
    expect(JSON.parse(output[0])).toEqual({event: 'studio_db_blob_reads', windowSeconds: 300,
      routes: {'media-preview': {reads: 2, blobs: 1, bytes: 14}, image: {reads: 1, blobs: 1, bytes: 2}}});
    expect(output[0]).not.toMatch(/SECRET|123|token/);
    t.record('image', Buffer.alloc(1)); t.flush();
    expect(JSON.parse(output[1]).routes.image).toEqual({reads: 1, blobs: 1, bytes: 1});
  });
  it('bounds label cardinality and cannot fail requests when the log sink fails', () => {
    const output: string[] = []; const t = createStudioReadTelemetry(s => output.push(s));
    for(let i=0;i<10000;i++) t.record(`user-${i}` as any, Buffer.alloc(0));
    for(const route of STUDIO_READ_ROUTES) t.record(route, Buffer.alloc(0));
    t.flush(); expect(Object.keys(JSON.parse(output[0]).routes)).toHaveLength(STUDIO_READ_ROUTES.length);
    const broken = createStudioReadTelemetry(() => {throw Error('sink');});
    broken.record('image', Buffer.alloc(1)); expect(() => broken.flush()).not.toThrow();
  });
  it('batches production reads on one timer, with no per-request or idle logs', () => {
    vi.useFakeTimers(); vi.stubEnv('NODE_ENV', 'production');
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    recordStudioBlobRead('image', Buffer.alloc(3)); recordStudioBlobRead('image', Buffer.alloc(5));
    expect(vi.getTimerCount()).toBe(1); expect(log).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300_000); expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0]).routes.image).toEqual({reads:2,blobs:2,bytes:8});
    vi.advanceTimersByTime(300_000); expect(log).toHaveBeenCalledTimes(1);
  });
  it('does not create timers or logs outside production', () => {
    vi.stubEnv('NODE_ENV', 'test'); const timer = vi.spyOn(globalThis, 'setInterval');
    recordStudioBlobRead('image', Buffer.from('private')); expect(timer).not.toHaveBeenCalled();
  });
});
describe('media read column projection', () => {
  it.each([true, false])('reads only requested blob, preserves metadata and predicate (preview=%s)', async preview => {
    const image = Buffer.from('preview bytes'); const video = Buffer.alloc(1024 * 1024);
    let selected: any; let predicate: any;
    const db = {select(fields: any) {selected=fields; return {from(table: any) {
      expect(table).toBe(studioMedia); return {where(where: any) {predicate=where;
        return Promise.resolve([{id: 7, kind: 'video', mimeType: 'video/mp4', bytes: fields.bytes === studioMedia.preview ? image : video}]);
      }};
    }}}} as unknown as DB;
    const result = await readStudioMedia(db, 7, preview);
    expect(Object.keys(selected)).toEqual(['id','kind','mimeType','bytes']);
    expect(selected.bytes).toBe(preview ? studioMedia.preview : studioMedia.bytes);
    expect(new PgDialect().sqlToQuery(predicate).params).toEqual([7]);
    expect(result).toEqual({id: 7,kind:'video',mimeType:'video/mp4',bytes:preview ? image : video});
    expect(result.bytes).toBe(preview ? image : video);
  });
  it('preserves missing media and missing preview behavior without fetching fallback bytes', async () => {
    for(const rows of [[],[{id:1,kind:'video',mimeType:'video/mp4',bytes:null}]]) {
      const db={select(fields: any){expect(fields.bytes).toBe(studioMedia.preview);return {from(){return {where(){return Promise.resolve(rows);}};}};}} as unknown as DB;
      expect(await readStudioMedia(db,1,true)).toEqual(rows[0]);
    }
  });
});
