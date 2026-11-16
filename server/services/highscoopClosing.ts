import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {Resvg} from '@resvg/resvg-js';
import {HIGHSCOOP_CLOSING_COPY as copy,HIGHSCOOP_CLOSING_LAYOUT as layout,highScoopClosingAccent} from '../../shared/highscoopClosing';
import {loadReadingFont} from './readingCardFonts';

export type HighscoopClosingTextRun={field:string;text:string;lines:string[];size:number;x:number;y:number;width:number;height:number;color:string;align:'left'|'center';lineHeight:number};
const assets=new Map<string,string>();
function imageAsset(filename:string):string {
  const cached=assets.get(filename);if(cached)return cached;
  const candidates=[path.resolve(process.cwd(),filename),path.resolve(import.meta.dirname??'.','../..',filename)];
  const resolved=candidates.find(candidate=>fs.existsSync(candidate));
  if(!resolved)throw new Error('HighScoop 공통 마지막 장의 원본 이미지를 찾을 수 없습니다.');
  const value=`data:image/png;base64,${fs.readFileSync(resolved).toString('base64')}`;
  assets.set(filename,value);return value;
}

/** One approved composition for PNG/JPEG previews, legacy cards and v2 cards.
 * Native Canva/PPTX uses the same shared boxes, copy and artwork. No factual
 * body page is accepted here: callers append this page or replace an explicit
 * semantic outro, never the operator's final body paragraph. */
export function layoutHighscoopClosing(accent?:string,options:{measureOnly?:boolean}={}) {
  const colors={background:layout.background,ink:layout.ink,accent:highScoopClosingAccent(accent)};
  const elements:string[]=[],textRuns:HighscoopClosingTextRun[]=[];
  const rect=(box:{x:number;y:number;width:number;height:number;radius?:number},fill:string,stroke?:string)=>elements.push(`<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="${box.radius??0}" fill="${fill}"${stroke?` stroke="${stroke}" stroke-width="1.5"`:''}/>`);
  const image=(filename:string,box:{x:number;y:number;width:number;height:number})=>{if(!options.measureOnly)elements.push(`<image x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" preserveAspectRatio="xMidYMid meet" href="${imageAsset(filename)}"/>`);};
  const text=(value:string,field:string,box:{x:number;y:number;width:number;height:number;fontSize:number;lineHeight:number},weight:number,color:string,align:'left'|'center')=>{
    const font=loadReadingFont('Noto Sans KR',weight),size=box.fontSize;
    const width=font.measure(value,size);
    if(width>box.width+.1)throw new Error(`HighScoop 공통 마지막 장의 ${field} 문구가 영역을 넘습니다.`);
    const x=align==='center'?box.x+(box.width-width)/2:box.x;
    if(!options.measureOnly)elements.push(`<path d="${font.path(value,x,box.y+font.baseline(size,box.lineHeight),size)}" fill="${color}"/>`);
    textRuns.push({field,text:value,lines:[value],size,x:box.x,y:box.y,width:box.width,height:box.height,color,align,lineHeight:box.lineHeight});
  };
  rect({x:0,y:0,width:layout.width,height:layout.height},colors.background);
  image(layout.logoPath,layout.logo);
  text(copy.follow,'highscoop.follow',layout.follow,400,colors.ink,'center');
  text(copy.introductionText,'highscoop.introduction',layout.introduction,400,colors.ink,'left');
  image('assets/branding/highscoop-closing-icecream.png',layout.icecream);
  rect(layout.search,'#FFFFFF',layout.search.stroke);
  const icon=layout.searchIcon,cx=icon.x+icon.radius,cy=icon.y+icon.radius;
  elements.push(`<g fill="none" stroke="${layout.searchAccent}" stroke-width="${icon.strokeWidth}" stroke-linecap="round"><circle cx="${cx}" cy="${cy}" r="${icon.radius}"/><path d="M${icon.x+2*icon.radius-3} ${icon.y+2*icon.radius-3}L${icon.x+2*icon.radius+11} ${icon.y+2*icon.radius+11}"/></g>`);
  text(copy.handle,'highscoop.handle',layout.handle,700,colors.ink,'center');
  rect(layout.action,colors.accent);
  image('assets/branding/highscoop-closing-lightbulb.png',layout.lightbulb);
  text(copy.actionText,'highscoop.action',layout.actionText,700,layout.action.color,'left');
  return {svg:`<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">${elements.join('')}</svg>`,textRuns,colors};
}

export async function renderHighscoopClosing(accent?:string):Promise<Buffer> {
  const {svg}=layoutHighscoopClosing(accent);
  return sharp(new Resvg(svg,{font:{loadSystemFonts:false}}).render().asPng()).flatten({background:layout.background}).toColorspace('srgb').removeAlpha().jpeg({quality:92,chromaSubsampling:'4:4:4'}).toBuffer();
}
