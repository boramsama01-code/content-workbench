import fs from 'node:fs/promises';
import {strFromU8,unzipSync} from 'fflate';
import sharp from 'sharp';
import {describe,expect,it} from 'vitest';
import {buildNotionCanvaPptx,type NotionCanvaDocument} from '../server/services/notionCanva';
import {editorialBrandForChannel} from '../shared/editorialTemplates';
import {HIGHSCOOP_CLOSING_COPY as copy,HIGHSCOOP_CLOSING_LAYOUT as layout,highScoopClosingAccent} from '../shared/highscoopClosing';

const input=(color='#FF493B'):NotionCanvaDocument=>({title:'공통 마지막 장 검증',coverStyle:'B',categoryColor:color,pages:[{title:'첫 원고'},{title:'삭제되면 안 되는 마지막 본문',body:'원고의 마지막 문장과 공식 조건을 보존합니다.'}]});
const nativeText=(xml:string)=>[...xml.matchAll(/<a:t[^>]*>(.*?)<\/a:t>/g)].map(match=>match[1]).join('');
function shape(xml:string,name:string){
  const part=[...xml.matchAll(/<p:(?:sp|pic)>([\s\S]*?)<\/p:(?:sp|pic)>/g)].find(match=>match[1].includes(`name="${name}"`))?.[1];
  expect(part).toBeTruthy();
  const bounds=part!.match(/<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"/)!;
  return {xml:part!,box:bounds.slice(1).map(value=>Number(value)/9525)};
}

describe('approved HighScoop closing in editable Canva output',()=>{
  it('keeps the actual last body, approved wording and emoji as extractable editable text with separate original artwork',async()=>{
    const built=await buildNotionCanvaPptx(input(),[],{previewPage:2}),files=unzipSync(built.bytes);
    const source=strFromU8(files['ppt/slides/slide2.xml']),closing=strFromU8(files['ppt/slides/slide3.xml']);
    expect(source).toContain('삭제되면 안 되는 마지막 본문');expect(source).toContain('공식 조건을 보존합니다.');
    const text=nativeText(closing);
    for(const value of [copy.follow,copy.introductionText,'🍨',copy.handle,'💡',copy.actionText])expect(text).toContain(value);
    expect(shape(closing,'outro-introduction').xml).toContain('<p:txBody>');expect(shape(closing,'outro-action').xml).toContain('<p:txBody>');
    expect(shape(closing,'outro-introduction-emoji-text').xml).toContain('<a:alpha val="0"/>');
    expect(shape(closing,'outro-action-emoji-text').xml).toContain('💡');
    expect(Buffer.from(files['ppt/media/logo-color.png'])).toEqual(await fs.readFile(layout.logoPath));
    expect(Buffer.from(files['ppt/media/closing-icecream.png'])).toEqual(await fs.readFile(layout.icecreamPath));
    expect(Buffer.from(files['ppt/media/closing-lightbulb.png'])).toEqual(await fs.readFile(layout.lightbulbPath));
    expect(closing).not.toContain('아이의 관심에서 다음 도전까지');expect(closing).not.toContain('다음 이야기도 궁금하다면');
    expect(built.previewSvg).not.toContain('🍨</text>');expect(built.previewSvg).toContain('data-name="closing-icecream"');
  });

  it('matches the reference placement and colors in native shapes and the SVG preview',async()=>{
    const built=await buildNotionCanvaPptx(input(),[],{previewPage:2}),xml=strFromU8(unzipSync(built.bytes)['ppt/slides/slide3.xml']);
    shape(xml,'outro-follow').box.forEach((actual,index)=>expect(actual).toBeCloseTo([80,558,920,43.407][index],3));
    for(const [name,expected]of [
      ['outro-search',[228.9,895.4,624.4,86.5]],
      ['outro-red-pill',[64,1151,952,94]],
      ['outro-handle',[312.636,918.569,493.976,36.692]],
    ] as const)shape(xml,name).box.forEach((actual,index)=>expect(actual).toBeCloseTo(expected[index],3));
    expect(shape(xml,'outro-action').xml).toContain('val="FFFFFF"');
    expect(shape(xml,'outro-search-icon-ring').xml).toContain('prst="ellipse"');
    expect(shape(xml,'outro-search-icon-ring').xml).toContain('val="FF493B"');
    expect(shape(xml,'outro-search-icon-handle').xml).toContain('prst="line"');
    expect(built.previewSvg).toContain('x="64" y="1151" width="952" height="94" rx="47" fill="#FF493B"');
    expect(built.previewSvg).toContain('cx="270.7" cy="933" r="11.5"');
    const {data,info}=await sharp(Buffer.from(built.previewSvg!)).removeAlpha().raw().toBuffer({resolveWithObject:true});
    const pixel=(x:number,y:number)=>[...data.subarray((y*info.width+x)*info.channels,(y*info.width+x)*info.channels+3)];
    expect(pixel(50,50)).toEqual([255,249,242]);expect(pixel(500,910)).toEqual([255,255,255]);expect(pixel(100,1200)).toEqual([255,73,59]);
    const fast=await buildNotionCanvaPptx(input(),[],{previewPage:2,previewOnly:true});expect(fast.previewSvg).toBe(built.previewSvg);
  });

  it('changes only the bottom fill across category colors and keeps white copy readable',async()=>{
    let baseline:string|undefined;
    for(const color of ['#FF493B','#5ED7B5','#BAA0FF','#72A7FF','#FFD166','#57C7E3']){
      const built=await buildNotionCanvaPptx(input(color),[],{previewPage:2,previewOnly:true});
      const fill=highScoopClosingAccent(color),normalized=built.previewSvg!.replace(`rx="47" fill="${fill}"`,'rx="47" fill="#BOTTOM"');
      baseline??=normalized;expect(normalized).toBe(baseline);
      const rgb=[1,3,5].map(at=>parseInt(fill.slice(at,at+2),16)/255),luminance=rgb.reduce((sum,value,i)=>sum+(value<=.04045?value/12.92:((value+.055)/1.055)**2.4)*[.2126,.7152,.0722][i],0);
      expect(1.05/(luminance+.05)).toBeGreaterThanOrEqual(3);
    }
    expect(highScoopClosingAccent('invalid')).toBe('#FF493B');
  });

  it('applies the approved HighScoop identity to channel aliases while keeping other brands separate',async()=>{
    for(const slug of ['highscoop','opportunities','highway']){
      const brand=editorialBrandForChannel({slug}),built=await buildNotionCanvaPptx(input(),[],{brand,previewPage:2,previewOnly:true});
      expect(brand.follow).toBe(copy.follow);expect(built.previewSvg).toContain(copy.follow);expect(built.previewSvg).toContain('closing-lightbulb');
    }
    const brand=editorialBrandForChannel({slug:'news'}),built=await buildNotionCanvaPptx(input(),[],{brand,previewPage:2});
    const xml=strFromU8(unzipSync(built.bytes)['ppt/slides/slide3.xml']);expect(nativeText(xml)).toContain(brand.follow);expect(xml).not.toContain(copy.follow);expect(xml).not.toContain('outro-search-icon-ring');
  });
});
