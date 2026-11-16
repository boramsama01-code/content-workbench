/** Replace only the common final page of the six local editable template kits.
 * Existing first-ten-page XML, relationships, photos and annotations stay byte
 * identical. Emoji artwork comes from the operator-supplied closing reference.
 * This does not change any existing Canva design or catalog ID.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {strFromU8,strToU8,unzipSync,zipSync} from 'fflate';
import {HIGH_SCOOP_TEMPLATE_KITS,HIGH_SCOOP_TEMPLATE_VERSION} from '../shared/highscoopTemplates';
import {HIGHSCOOP_CLOSING_VERSION} from '../shared/highscoopClosing';
import {buildNotionCanvaPptx,type NotionCanvaDocument} from '../server/services/notionCanva';

const target=path.resolve('docs/artifacts/highscoop-current');
const publicDir=path.resolve('client/public/highscoop/current');
const manifestPath=path.join(target,'manifest.json');
const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
for(const kit of HIGH_SCOOP_TEMPLATE_KITS){
  const slug=kit.key.slice('highscoop:'.length),pptx=path.join(target,`${slug}.pptx`);
  const original=unzipSync(await fs.readFile(pptx));
  if(Object.keys(original).filter(file=>/^ppt\/slides\/slide\d+\.xml$/.test(file)).length!==11)throw new Error(`${slug}: expected the existing 11-page master`);
  const doc:NotionCanvaDocument={title:`${kit.category} 공통 마지막 장`,coverStyle:'B',category:kit.category,categoryColor:kit.color,pages:[{title:'기존 표지 보존'},{title:'기존 내지 보존'}]};
  const closing=await buildNotionCanvaPptx(doc,[],{previewPage:2}),generated=unzipSync(closing.bytes);
  let relationships=strFromU8(generated['ppt/slides/_rels/slide3.xml.rels']);
  const next={...original};
  for(const match of relationships.matchAll(/Target="\.\.\/media\/([^"]+)"/g)){
    const name=match[1],newName=`standard-closing-${name}`;
    next[`ppt/media/${newName}`]=generated[`ppt/media/${name}`];
    relationships=relationships.replaceAll(`../media/${name}`,`../media/${newName}`);
  }
  next['ppt/slides/slide11.xml']=generated['ppt/slides/slide3.xml'];
  next['ppt/slides/_rels/slide11.xml.rels']=strToU8(relationships);
  const contentTypes=strFromU8(next['[Content_Types].xml']);
  if(!contentTypes.includes('Extension="png"'))next['[Content_Types].xml']=strToU8(contentTypes.replace('</Types>','<Default Extension="png" ContentType="image/png"/></Types>'));
  const bytes=Buffer.from(zipSync(next,{level:6}));
  const checked=unzipSync(bytes);
  for(const [file,contents]of Object.entries(original)){
    if(file==='ppt/slides/slide11.xml'||file==='ppt/slides/_rels/slide11.xml.rels'||file==='[Content_Types].xml'||file.startsWith('ppt/media/standard-closing-'))continue;
    if(!Buffer.from(checked[file]).equals(Buffer.from(contents)))throw new Error(`${slug}: original entry changed: ${file}`);
  }
  await fs.writeFile(pptx,bytes);
  await sharp(Buffer.from(closing.previewSvg!)).webp({quality:89}).toFile(path.join(publicDir,`${slug}-page-11.webp`));
  const previews=Array.from({length:11},(_,i)=>path.join(publicDir,`${slug}-page-${i+1}.webp`));
  const thumbs=await Promise.all(previews.map((file,i)=>sharp(file).resize(216,270).toBuffer().then(input=>({input,left:i%4*216,top:Math.floor(i/4)*270}))));
  await sharp({create:{width:864,height:810,channels:3,background:'#F0F2F4'}}).composite(thumbs).webp({quality:87}).toFile(path.join(publicDir,`${slug}-overview.webp`));
  const record=manifest.records.find((record:{key:string})=>record.key===kit.key);
  if(!record)throw new Error(`${slug}: missing manifest record`);
  record.sha256=crypto.createHash('sha256').update(bytes).digest('hex');
  record.closingVersion=HIGHSCOOP_CLOSING_VERSION;
  record.preservedOriginalPages=10;
  console.log(JSON.stringify({category:kit.category,pptx,pageCount:11,preservedOriginalPages:10,bytes:bytes.length}));
}
manifest.version=HIGH_SCOOP_TEMPLATE_VERSION;
manifest.closingVersion=HIGHSCOOP_CLOSING_VERSION;
manifest.closingReference={kind:'operator-supplied-closing',layoutCanvaDesignId:'DAHakNtBLjU',layoutPageNumber:9,emojiArtwork:'operator-supplied-closing-reference'};
await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
