import {load} from 'cheerio';

export type GedPublicAttachment={url:string;name:string;kind:string;status:string;reason?:string;role?:'primary'|'supplement'};
export const GED_PDF_LIMITS={files:3,bytes:8*1024*1024,pages:80,text:80_000} as const;

/** The public GED notice popup advertises these exact data-file arguments.
 * No site script is evaluated, session cookie copied, or endpoint guessed. */
export function isGedNoticePage(value:string):boolean {
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&url.hostname==='ged.kedi.re.kr'&&url.pathname==='/inno/slctNotiInnoPop.do'
      &&/^\d{4}$/.test(url.searchParams.get('stndYear')??'')&&/^\d{1,20}$/.test(url.searchParams.get('orgId')??'')&&/^\d{1,20}$/.test(url.searchParams.get('seq')??'');
  }catch{return false;}
}

function kindFor(filename:string):string {
  const extension=filename.split('.').at(-1)!.toLowerCase();
  if(['pdf','hwp','hwpx','zip'].includes(extension))return extension;
  return ['doc','docx','xls','xlsx','ppt','pptx'].includes(extension)?'office':'file';
}
function documentRank(item:GedPublicAttachment):number {
  const name=item.name.replace(/[+\s]/g,'');
  const guide=/(?:모집|전형|선발)(?:요강|공고)/.test(name)?300:/(?:모집|선발)안내/.test(name)?200:100;
  const supplement=/faq|q[_. -]*[a&]|q_?a|질문|질의|서식|양식|자기소개서|추천서/i.test(name)?150:0;
  return guide-supplement+(item.kind==='pdf'?1:0);
}

export function gedNoticeAttachments(html:string,pageUrl:string):GedPublicAttachment[] {
  if(!isGedNoticePage(pageUrl))return [];
  const $=load(html),items:GedPublicAttachment[]=[],seen=new Set<string>();
  $('a[onclick]').each((_,element)=>{
    if(items.length>=20)return false;
    const operation=$(element).attr('onclick')??'';
    const args=/^\s*(?:javascript:\s*)?fn_down\(\s*(['"])([A-Za-z0-9][A-Za-z0-9_.-]{0,199})\1\s*,\s*(['"])([^'"\\\r\n]{1,500})\3\s*\)\s*;?\s*(?:return\s+false\s*;?)?\s*$/i.exec(operation);
    if(!args)return;
    const physical=args[2],logical=args[4];
    if(physical.includes('..')||!/[.]\w{1,8}$/.test(physical)||/[\/\\\u0000-\u001f\u007f]/.test(logical)||seen.has(physical))return;
    seen.add(physical);
    const url=new URL('/inno/fileDownload.do',pageUrl);
    url.search=new URLSearchParams({filePath:'dataFiles',physFileNm:physical,logiFileNm:logical}).toString();
    const kind=kindFor(physical);
    items.push({url:url.href,name:logical.slice(0,200),kind,status:kind==='pdf'?'pending':'manual_check',
      ...(kind!=='pdf'?{reason:`${kind.toUpperCase()} 파일은 자동 추출하지 않음 — 원본 확인 필요`}:{})});
  });
  return items.sort((a,b)=>documentRank(b)-documentRank(a)).map((item,index)=>({...item,role:index===0?'primary':'supplement'}));
}
