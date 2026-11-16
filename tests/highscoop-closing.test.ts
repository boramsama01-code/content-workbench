import {describe,expect,it} from 'vitest';
import sharp from 'sharp';
import {Resvg} from '@resvg/resvg-js';
import {HIGHSCOOP_CLOSING_COPY as copy} from '../shared/highscoopClosing';
import {studioContentSchema,studioPageCount} from '../shared/studio';
import {studioAltTexts,studioAltTextDrafts,altTextError} from '../shared/altText';
import {layoutHighscoopClosing,renderHighscoopClosing} from '../server/services/highscoopClosing';
import {createStudioRenderer,checkStudioExport} from '../server/services/studioExport';

const content=()=>studioContentSchema.parse({title:'원문 보존 확인',channel:'highscoop',format:'카드뉴스',sourceLabel:'직접 작성',panels:Array.from({length:4},(_,i)=>({scene:'',dialogue:`${i+1}번째 본문과 마지막 중요 사실을 보존합니다.`}))});
describe('승인된 HighScoop 공통 마지막 장',()=>{
 it('고정 영역은 카테고리색과 무관하고 하단색만 달라진다',async()=>{
  const red=layoutHighscoopClosing(),mint=layoutHighscoopClosing('#5ED7B5');
  expect(red.textRuns).toEqual(mint.textRuns);
  expect(red.textRuns.map(r=>r.text)).toEqual([copy.follow,copy.introductionText,copy.handle,copy.actionText]);
  const pixels=async(svg:string)=>sharp(new Resvg(svg).render().asPng()).removeAlpha().raw().toBuffer();
  const a=await pixels(red.svg),b=await pixels(mint.svg);
  // Inspect pixels independently of the shared layout generator: every pixel
  // before the bottom pill must be identical, including logo and search icon.
  const offset=1080*3*1150;expect(a.subarray(0,offset).equals(b.subarray(0,offset))).toBe(true);
  expect(a.subarray(offset).equals(b.subarray(offset))).toBe(false);
  expect(altTextError(copy.altText)).toBeNull();
  expect(red.textRuns.every(run=>run.x>=0&&run.x+run.width<=1080&&run.y+run.height<=1350)).toBe(true);
 });
 it('legacy 세 디자인과 컬렉션 모두 본문을 유지한 뒤 같은 마지막 장을 출력한다',async()=>{
  const expected=await sharp(await renderHighscoopClosing('#FF493B')).png().toBuffer();
  for(const exportDesign of ['editorial','spotlight','minimal','set:r01'] as const){
   const c={...content(),exportDesign};
   const r=createStudioRenderer(c,1,'HighScoop','#FF493B');
   expect(r.pageCount).toBe(6);expect(await r.page(5)).toEqual(expected);
   expect((await sharp(await r.page(4)).metadata()).width).toBe(1080);
   expect(studioAltTexts(c)).toHaveLength(r.pageCount);
   expect(studioAltTexts(c).at(-1)).toBe(copy.altText);
  }
  const base=content();expect(studioPageCount({...base,exportDesign:'set:any'})).toBe(6);
  expect(studioPageCount({...base,channel:'news',exportDesign:'set:any'})).toBe(5);
 });
 it('사진 후기의 마지막 본문을 덮지 않고 새 마지막 장과 수정 가능한 대체텍스트를 추가한다',async()=>{
  const c=studioContentSchema.parse({...content(),experience:{coverId:1,pages:[{mediaId:null,title:'첫 기록',body:'직접 관찰했습니다.'},{mediaId:null,title:'마지막 사실',body:'마지막 원문을 그대로 둡니다.'}]}});
  const photo=await sharp({create:{width:80,height:80,channels:3,background:'#557766'}}).png().toBuffer();
  const r=createStudioRenderer(c,1,'HighScoop','#FF493B',new Map([[1,photo]]));
  expect(r.pageCount).toBe(4);expect(checkStudioExport(c).errors).toEqual([]);
  expect((await r.page(2)).equals(await r.page(3))).toBe(false);
  expect(studioAltTexts(c)).toHaveLength(4);expect(studioAltTextDrafts(c)).toHaveLength(4);
  const altTexts=Array(4).fill('');altTexts[3]='직접 수정한 채널 소개.';
  expect(studioAltTexts({...c,altTexts}).at(-1)).toBe(altTexts[3]);
  expect(studioAltTextDrafts({...c,altTexts}).at(-1)).toBe(altTexts[3]);
  expect(studioPageCount({...c,channel:'news'})).toBe(3);
 });
 it('Canva에서 저장해 가져온 완성본은 실제 장수와 설명을 그대로 따른다',()=>{
  const c=studioContentSchema.parse({...content(),finishedDeck:{pages:[{imageId:1,name:'원본',altText:'원본 마지막 페이지.'}]}});
  expect(studioPageCount(c)).toBe(1);expect(studioAltTexts(c)).toEqual(['원본 마지막 페이지.']);
 });
});
