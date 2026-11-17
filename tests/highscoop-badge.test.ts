import {describe, expect, it} from 'vitest';
import sharp from 'sharp';
import {assertHighScoopBadgeContract, createHighScoopBadgeSvg, highScoopBadgeGeometry, HIGHSCOOP_BADGE_CONTRACT} from '../shared/highscoopBadge';

async function capsuleSamples(svg: string, width: number, height: number) {
  const {data, info}=await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  expect(info).toMatchObject({width, height, channels:4});
  const alpha=(x:number,y:number)=>data[(Math.round(y)*width+Math.round(x))*4+3];
  return {corner:alpha(height*.1,height*.1),topMiddle:alpha(width/2,2),endMiddle:alpha(2,height/2)};
}

describe('HighScoop capsule badge contract',()=>{
  it('rejects rounded-box defaults, damaged SVG templates, invalid sizes and unsafe colors',()=>{
    expect(()=>assertHighScoopBadgeContract({...HIGHSCOOP_BADGE_CONTRACT,cornerRadiusRatio:0.16})).toThrow('알약 모양');
    expect(()=>assertHighScoopBadgeContract({...HIGHSCOOP_BADGE_CONTRACT,pptxAdjustment:16667})).toThrow('알약 모양');
    expect(()=>assertHighScoopBadgeContract({...HIGHSCOOP_BADGE_CONTRACT,svgTemplate:HIGHSCOOP_BADGE_CONTRACT.svgTemplate.replace('rx="{{radius}}"','rx="16"')})).toThrow('알약 모양');
    for(const [width,height] of [[160,0],[40,60],[Infinity,60],[160,NaN]]) expect(()=>highScoopBadgeGeometry(width,height)).toThrow('가로 알약');
    expect(()=>createHighScoopBadgeSvg({width:160,height:60,color:'red"/>'})).toThrow('색상');
  });

  it('renders transparent semicircular ends and rejects the former rounded-box pixel mask',async()=>{
    for(const [width,height,color] of [[180,60,'#FF493B'],[160,63,'#57C7E3'],[130,50,'#5ED7B5']] as const){
      expect(highScoopBadgeGeometry(width,height)).toEqual({width,height,radius:height/2,pptxAdjustment:50000});
      const current=await capsuleSamples(createHighScoopBadgeSvg({width,height,color}),width,height);
      expect(current).toEqual({corner:0,topMiddle:255,endMiddle:255});
      const legacy=await capsuleSamples(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${height===50?8:16}" fill="${color}"/></svg>`,width,height);
      expect(legacy.corner).toBe(255);
      expect(legacy).not.toEqual(current);
    }
  });
});
