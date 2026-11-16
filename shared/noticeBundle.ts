import {z} from 'zod';
import type {SourceAttachment} from './sourceAttachment';
import {cardCopySchema} from './cardCopy';

export const NOTICE_BUNDLE_LIMIT=10;
export const noticeBundleRequestSchema=z.object({
  itemIds:z.array(z.number().int().positive()).min(2).max(NOTICE_BUNDLE_LIMIT).refine(ids=>new Set(ids).size===ids.length,'같은 공고를 중복 선택할 수 없습니다.'),
  title:z.string().trim().min(1).max(160).optional(),instruction:z.string().trim().max(2000).optional(),requestId:z.string().uuid(),
}).strict();
export type NoticeBundleRequest=z.infer<typeof noticeBundleRequestSchema>;
export type NoticeBundleRow={
  itemId:number;title:string;url:string|null;sourceId:number|null;
  fetchStatus:'pending'|'ok'|'failed'|'unsupported'|'blocked';
  text?:string;textHash?:string|null;attachments?:SourceAttachment[];
  extracted?:Record<string,unknown>|null;issue?:string;
};
export type NoticeBundle={version:1;status:'collecting'|'ready'|'partial';sourceItemIds:number[];instruction:string;rows:NoticeBundleRow[];createdAt:string;jobId?:number};
export type NoticeBundleReply={itemId:number;jobId:number;status:string;bundle?:NoticeBundle;error?:string};
export function noticeBundleFromPayload(payload:Record<string,unknown>|null|undefined):NoticeBundle|undefined{
  const value=payload?.noticeBundle as NoticeBundle|undefined;
  return value?.version===1&&Array.isArray(value.rows)&&Array.isArray(value.sourceItemIds)?value:undefined;
}
const field=(value:unknown)=>typeof value==='string'&&value.trim()?value.trim():'미확인';
export function noticeBundleRowFields(row:NoticeBundleRow){
  const p=row.extracted??{};
  return {organization:field(p.organization==='미확인'?undefined:p.organization),academicYear:field(p.academic_year),audience:field(p.audience),eligibility:field(p.eligibility),details:field(p.key_details),
    schedules:Array.isArray(p.schedules)?p.schedules as Array<{kind?:string;label?:string|null;round?:string|null;start?:{date?:string;time?:string}|null;end?:{date?:string;time?:string}|null;raw?:string|null}>:[],
    uncertainties:Array.isArray(p.uncertainties)?p.uncertainties.filter((v):v is string=>typeof v==='string'):[]};
}
export const NOTICE_BUNDLE_WRITING_RULES=`[여러 모집 공고를 묶는 원고]
공고별 기관·학년도·대상 학년·거주/재학 지역 조건·전형 유형·학생 접수·교사 추천·서류 제출·정원을 각각 유지한다. 한 기관의 조건이나 날짜를 다른 기관에 옮기지 않는다.
지역 제한은 해당 기관의 문구에만 붙인다. 공고 게시일·PDF 업로드일을 접수 마감일로 사용하지 않는다. 학생 마감과 추천/학교 마감을 같은 마감으로 합치지 않는다.
확보한 공고만 다루며 '전국 전체', '모든 영재학급' 또는 접수 중이라고 추정하지 않는다. 학년도와 현재 지원 학년을 구분한다.
미확인·읽기 실패·스캔/잘림·상충되는 값은 확인 필요로 남긴다. 원문에 없는 수치·정원·우열·지원 가능 여부를 채우지 않는다.
비교 문장마다 해당 기관의 원문 URL과 실제 PDF 페이지/발췌를 확인한다. 페이지를 모르면 만들지 않는다.
독자가 먼저 비교할 기준을 제시한 뒤 기관별 차이와 다음 확인 사항을 묶어 카드뉴스로 쓴다. 반복 안내와 공통 마무리는 한 번만 둔다.`;

/** A bounded, labelled source handoff for either ChatGPT/Codex or configured AI. */
export function noticeBundleWritingContext(bundle:NoticeBundle):string{
  return `${NOTICE_BUNDLE_WRITING_RULES}\n묶는 기준: ${bundle.instruction||'선택한 모집 공고 비교'}\n${bundle.rows.map((row,index)=>{
    const p=noticeBundleRowFields(row);
    const pages=(row.attachments??[]).flatMap(a=>(a.pages??[]).filter(page=>page.text.trim()).map(page=>`${a.name} ${page.page}쪽: ${page.text}`)).join('\n');
    return `[공고 ${index+1} / 원문ID ${row.sourceId??'미확보'}]\n제목: ${row.title}\n원문: ${row.url??'미확보'}\n읽기 상태: ${row.fetchStatus}${row.issue?` (${row.issue})`:''}\n확인한 구조화 정보: ${JSON.stringify({...p,schedules:p.schedules})}\n원문 본문/페이지 근거:\n${row.fetchStatus==='ok'?(pages||row.text||'확보하지 못함'):'확보하지 못함 — 읽기 실패 자료를 현재 근거로 사용하지 않는다.'}`;
  }).join('\n\n')}`;
}

export function buildNoticeBundlePayload(bundle:NoticeBundle,title:string):Record<string,unknown>{
  const issues=bundle.rows.flatMap(row=>[...(row.issue?[`${row.title}: ${row.issue}`]:[]),...noticeBundleRowFields(row).uncertainties.map(value=>`${row.title}: ${value}`)]);
  const schedule=(entry:ReturnType<typeof noticeBundleRowFields>['schedules'][number])=>{
    const point=(p:typeof entry.start)=>p?.date?[p.date,p.time].filter(Boolean).join(' '):'';
    return [entry.label||entry.kind||'일정',entry.round,entry.raw||[point(entry.start),point(entry.end)].filter(Boolean).join(' ~ ')].filter(Boolean).join(' · ');
  };
  const blocks=bundle.rows.flatMap((row,index)=>{
    const p=noticeBundleRowFields(row);
    const text=[`[공고 ${index+1}] ${row.title}`,`기관: ${p.organization}`,`학년도: ${p.academicYear}`,`대상: ${p.audience}`,`지원 조건: ${p.eligibility}`,
      ...(p.schedules.length?p.schedules.map(schedule):['일정: 미확인']),`추가 안내: ${p.details}`,
      ...p.uncertainties.map(value=>`확인 필요: ${value}`),...(row.issue?[`자료 확인: ${row.issue}`]:[]),...(row.fetchStatus!=='ok'?[`원문 읽기: ${row.fetchStatus}`]:[])].join('\n');
    // Break without dropping any institution's conditions. Overflow is visible
    // review work; the payload always retains the full source and comparison.
    const chunks:string[]=[];let chunk='';
    for(const line of text.split('\n')){
      for(const part of line.match(/[\s\S]{1,520}/gu)??[]){
        if([...chunk].length+[...part].length+1>580&&chunk){chunks.push(chunk);chunk='';}
        chunk+=(chunk?'\n':'')+part;
      }
    }
    if(chunk)chunks.push(chunk);
    return chunks.map((body,part)=>({id:`notice-${index+1}-${part+1}`,title:`공고 ${index+1}${chunks.length>1?` · ${part+1}/${chunks.length}`:' · 조건과 일정'}`,subtitle:'',body,sourceIds:row.sourceId?[row.sourceId]:[]}));
  });
  const pages:typeof blocks=[];
  for(const block of blocks){
    const previous=pages.at(-1);
    if(previous&&[...previous.body].length+[...block.body].length+2<=580){previous.body+='\n\n'+block.body;previous.title='기관별 조건과 일정';previous.sourceIds=[...new Set([...previous.sourceIds,...block.sourceIds])];}
    else pages.push({...block});
  }
  const candidate={version:1,templateKey:'highscoop:gifted',cover:{title,subtitle:`선택한 ${bundle.rows.length}개 모집 공고 · 기관별 조건과 일정 비교`},pages};
  const checked=pages.length<=8?cardCopySchema.safeParse(candidate):null;
  if(!checked?.success)issues.push('자료 전체는 비교표와 원문에 보존했습니다. 카드 한 편에 담기에는 내용이 많아 공고를 나누거나 원고를 먼저 편집해 주세요.');
  return {relevance:'relevant',irrelevance_reason:null,title,organization:null,notice_type:'기타',category:'영재교육원',school_type:null,
    academic_year:null,audience:null,eligibility:null,schedules:[],deadline_type:'unknown',key_details:`선택한 ${bundle.rows.length}개 공고의 정보는 아래 기관별 비교표에 구분해 보관합니다.`,one_line_summary:'기관별 모집 조건과 일정을 함께 살펴봅니다.',
    uncertainties:issues.slice(0,10).map(issue=>[...issue].slice(0,300).join('')),has_conflict:bundle.status!=='ready'||issues.length>0,evidence:[],
    noticeBundle:bundle,...(checked?.success?{cardCopy:checked.data,rendererProvider:'builtin'}:{})};
}
