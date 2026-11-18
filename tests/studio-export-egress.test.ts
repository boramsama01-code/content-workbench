import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DB } from '../server/db';
import { channels, studioCards, studioImages } from '../shared/schema';
import { studioContentSchema } from '../shared/studio';
import { createStudioRenderer, renderStudioOutput, studioPageImageIds } from '../server/services/studioExport';

const content = () => studioContentSchema.parse({title: '이미지 전송량 검사', channel: 'highscoop', format: '카드뉴스',
  sourceLabel: '직접 작성', altTexts: Array(6).fill('카드 설명'),
  panels: Array.from({length: 4}, (_, i) => ({scene: "", dialogue: `본문 ${i + 1}`, imageId: i + 1}))});

function fakeDb(value: unknown, bytes: Buffer, version = 1, missingId?: number) {
  const reads: Array<{id: number; cardId: number}> = [];
  let transferred = 0;
  const db = {select: () => ({from: (table: unknown) => ({where: async (where: any) => {
    if (table === studioCards) return [{content: value, version}];
    if (table === channels) return [];
    if (table === studioImages) {
      const [id, cardId] = new PgDialect().sqlToQuery(where).params as number[];
      reads.push({id, cardId});
      if(id === missingId) return [];
      transferred += bytes.length;
      return [{bytes}];
    }
    throw Error('Unexpected table');
  }})})} as unknown as DB;
  return {db, reads, transferred: () => transferred};
}

describe('page-scoped Studio image reads', () => {
  it('reads one finished-deck blob for one preview, rather than all eight', async () => {
    const bytes = await sharp({create: {width: 12,height: 12,channels: 3,background: '#ff0000'}}).png().toBuffer();
    const c = studioContentSchema.parse({...content(), finishedDeck: {pages: Array.from({length: 8}, (_, i) => ({imageId: i + 1,name: `${i}`,altText: '완성 카드'}))}});
    const source = fakeDb(c, bytes);
    const output = await renderStudioOutput(source.db, 91, 1);
    expect(source.reads).toEqual([]);
    const rendered = await output.page(3);
    expect(source.reads).toEqual([{id: 4,cardId: 91}]);
    expect(source.transferred()).toBe(bytes.length); // old path: 8 * bytes.length
    expect(rendered).toEqual(await sharp(bytes).rotate().resize(1080,1350,{fit:'contain',background:'#ffffff'}).flatten({background:'#ffffff'}).png().toBuffer());
    await output.page(3);
    expect(source.reads).toHaveLength(1);
    for(let i=0;i<8;i++)await output.page(i);
    expect(source.reads).toHaveLength(8); // ZIP still reads each asset once
  });
  it('does no image read for stale versions or invalid pages and keeps reads request-local', async () => {
    const bytes = await sharp({create:{width:2,height:2,channels:3,background:'#ffffff'}}).png().toBuffer();
    const c = studioContentSchema.parse({...content(),finishedDeck:{pages:[{imageId:1,name:'one',altText:'설명'}]}});
    const source = fakeDb(c,bytes,2);
    await expect(renderStudioOutput(source.db,91,1)).rejects.toThrow('변경');
    const output = await renderStudioOutput(source.db,91,2);
    await expect(output.page(-1)).rejects.toThrow('페이지');
    await expect(output.page(1)).rejects.toThrow('페이지');
    expect(source.reads).toEqual([]);
    await output.page(0);
    await (await renderStudioOutput(source.db,91,2)).page(0);
    expect(source.reads).toHaveLength(2); // no cross-request/global stale or private byte cache
  });
  it('rejects missing selected bytes and coalesces concurrent page reads', async () => {
    const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#ffffff'}}).png().toBuffer();
    const c=studioContentSchema.parse({...content(),finishedDeck:{pages:[{imageId:1,name:'one',altText:'설명'}]}});
    const missing=fakeDb(c,bytes,1,1);
    await expect((await renderStudioOutput(missing.db,91,1)).page(0)).rejects.toThrow('완성 이미지');
    const source=fakeDb(c,bytes);
    const output=await renderStudioOutput(source.db,91,1);
    await Promise.all([output.page(0),output.page(0)]);
    expect(source.reads).toHaveLength(1);
  });
  it('renders current-kit preview identically using one of four images and no images on closing', async () => {
    const bytes=await sharp({create:{width:32,height:40,channels:3,background:'#abcdef'}}).png().toBuffer();
    const c=studioContentSchema.parse({...content(),exportDesign:'highscoop:gifted'});
    const source=fakeDb(c,bytes);
    const output=await renderStudioOutput(source.db,91,1);
    const rendered=await output.page(2);
    expect(source.reads).toEqual([{id:2,cardId:91}]);
    const expected=await createStudioRenderer(c,1,'우주펭귄상회','#285f6a',new Map([1,2,3,4].map(id=>[id,bytes]))).page(2);
    expect(rendered).toEqual(expected);
    await output.page(5);
    expect(source.reads).toHaveLength(1);
  });
  it('selects only relevant panel bytes, no closing bytes, all comic panels', () => {
    const c=content();
    expect(studioPageImageIds({...c,exportDesign:'editorial'},0)).toEqual([]);
    expect(studioPageImageIds({...c,exportDesign:'set:n03'},0)).toEqual([1]);
    expect(studioPageImageIds(c,3)).toEqual([3]);
    expect(studioPageImageIds(c,5)).toEqual([]);
    expect(studioPageImageIds({...c,format:'웹툰'},0)).toEqual([1,2,3,4]);
  });
});
