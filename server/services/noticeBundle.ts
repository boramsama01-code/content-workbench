import {and,eq,inArray,sql} from 'drizzle-orm';
import type {DB} from '../db';
import {channels,contentItems,contentRevisions,contentSources,jobs,sourceDocuments,studioCards,type Job,type SourceDocument} from '../../shared/schema';
import {noticeBundleRequestSchema,noticeBundleFromPayload,buildNoticeBundlePayload,type NoticeBundle,type NoticeBundleReply,type NoticeBundleRequest,type NoticeBundleRow} from '../../shared/noticeBundle';
import {emptyPayload,noticePayloadSchema} from '../../shared/payloads';
import {createRevision} from '../content';
import {audit} from '../audit';
import {getSetting} from '../seed';
import {HttpError} from '../routes/util';
import {itemPrimarySource} from './itemSources';
import {sha256} from './text';
import {fetchPublisherArticle} from './publisherLookup';
import {sourceFetchUrl} from './sourceFetchUrl';
import {persistSourceFetchAttempt} from './sourceFetchPersistence';
import {channelAiAvailability,channelAiSelection} from './channelAi';
import {extractNotice,LlmBudget} from './llm';
import {failJob} from '../worker/queue';
import {withGenerationContext} from './generationContext';

export const NOTICE_BUNDLE_JOB='notice_bundle';
type Selection={itemId:number;version:number;revisionId:number|null;sourceId:number|null;sourceHash:string|null;sourceFetchedAt:string|null};
type Progress={itemId:number;targetVersion:number;requestHash:string;requestId:string;title:string;bundle:NoticeBundle;selections:Selection[];nextIndex:number};
const receipt=(actor:string,requestId:string)=>`notice-bundle:${sha256(actor).slice(0,16)}:${requestId}`;
const activeCalls=new Set<AbortController>();
let stopping=false;
export function stopActiveNoticeBundles(){stopping=true;for(const controller of activeCalls)controller.abort(new Error('서버 종료로 공고 읽기를 중단했습니다.'));}
const publicUrl=(value:string|null|undefined)=>{try{const u=new URL(value??'');return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}};
function view(job:Job):NoticeBundleReply {
 const payload=job.payload as unknown as Progress;
 const bundle=['queued','running'].includes(job.status)?{...payload.bundle,rows:payload.bundle.rows.map(row=>({...row,text:undefined,attachments:row.attachments?.map(attachment=>({...attachment,pages:undefined}))}))}:payload.bundle;
 return {itemId:payload.itemId,jobId:job.id,status:job.status,bundle};
}

/** Selection creates a separate draft and a durable collection job. It
 * does not fetch in the HTTP request or modify the original item/revision. */
export async function createNoticeBundle(db:DB,channelId:number,input:NoticeBundleRequest,actor:string):Promise<NoticeBundleReply>{
 const body=noticeBundleRequestSchema.parse(input),key=receipt(actor,body.requestId),requestHash=sha256(JSON.stringify({channelId,...body}));
 return db.transaction(async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
  const [previous]=await tx.select().from(jobs).where(and(eq(jobs.type,NOTICE_BUNDLE_JOB),eq(jobs.dedupeKey,key))).orderBy(jobs.id).limit(1);
  if(previous){if(previous.channelId!==channelId||previous.payload.requestHash!==requestHash)throw new HttpError(409,'같은 요청으로 다른 공고 묶음을 만들 수 없습니다.');return view(previous);}
  const [channel]=await tx.select().from(channels).where(eq(channels.id,channelId)).for('share');
  if(!channel)throw new HttpError(404,'채널을 찾을 수 없습니다.');
  if(!channel.active||channel.contentType!=='notice')throw new HttpError(400,'사용 중인 모집 공고 채널에서 자료를 선택해 주세요.');
  if(await getSetting(tx as DB,'global_stop',false))throw new HttpError(409,'전체 작업이 정지돼 있습니다. 정지를 해제한 뒤 다시 묶어 주세요.');
  const selected=await tx.select().from(contentItems).where(and(eq(contentItems.channelId,channelId),inArray(contentItems.id,body.itemIds))).for('share');
  if(selected.length!==body.itemIds.length||selected.some(item=>item.kind!=='notice'||item.isSample))throw new HttpError(400,'같은 채널의 실제 모집 공고를 2~10개 선택해 주세요.');
  const revisionIds=selected.flatMap(item=>item.currentRevisionId?[item.currentRevisionId]:[]);
  const revisions=revisionIds.length?await tx.select().from(contentRevisions).where(inArray(contentRevisions.id,revisionIds)):[];
  if(selected.some(item=>noticeBundleFromPayload(item.edited)||noticeBundleFromPayload(item.extracted)||noticeBundleFromPayload(revisions.find(revision=>revision.id===item.currentRevisionId)?.payload)))throw new HttpError(400,'이미 묶은 콘텐츠 대신 원본 모집 공고를 다시 선택해 주세요. 묶음 안의 다른 기관이 빠지지 않도록 새로 합치지 않았습니다.');
  const ordered=body.itemIds.map(id=>selected.find(item=>item.id===id)!);
  const rows:NoticeBundleRow[]=[],selections:Selection[]=[];
  for(const item of ordered){const source=await itemPrimarySource(tx as DB,item);rows.push({itemId:item.id,title:item.title,url:publicUrl(source?.originalUrl),sourceId:source?.id??null,fetchStatus:'pending',extracted:null});selections.push({itemId:item.id,version:item.version,revisionId:item.currentRevisionId,sourceId:source?.id??null,sourceHash:source?.contentHash??null,sourceFetchedAt:source?.lastFetchedAt?.toISOString()??null});}
  const title=body.title||`${ordered[0].title.slice(0,105)} 외 ${ordered.length-1}개 모집 공고 모아보기`;
  const bundle:NoticeBundle={version:1,status:'collecting',sourceItemIds:body.itemIds,instruction:body.instruction??'',rows,createdAt:new Date().toISOString()};
  const [item]=await tx.insert(contentItems).values({channelId,kind:'notice',origin:'manual',primarySourceId:null,title,relevance:'relevant',evidenceStatus:'needs_review',reviewStatus:'pending',scheduleStatus:'unknown',subcategory:ordered.every(item=>item.subcategory===ordered[0].subcategory)?ordered[0].subcategory:null}).returning();
  const sourceIds=[...new Set(rows.flatMap(row=>row.sourceId?[row.sourceId]:[]))];
  if(sourceIds.length)await tx.insert(contentSources).values(sourceIds.map((sourceDocumentId,index)=>({contentItemId:item.id,sourceDocumentId,role:index===0?'bundle_primary':'supporting'}))).onConflictDoNothing();
  const progress:Progress={itemId:item.id,targetVersion:item.version,requestHash,requestId:body.requestId,title,bundle,selections,nextIndex:0};
  const [job]=await tx.insert(jobs).values({channelId,type:NOTICE_BUNDLE_JOB,dedupeKey:key,requestedBy:actor,maxAttempts:100,payload:progress as unknown as Record<string,unknown>}).returning();
  bundle.jobId=job.id;
  await tx.update(jobs).set({payload:progress as unknown as Record<string,unknown>}).where(eq(jobs.id,job.id));
  job.payload=progress as unknown as Record<string,unknown>;
  await createRevision(tx,{contentItemId:item.id,author:'system',payload:{...emptyPayload('notice',title),noticeBundle:bundle},note:'선택한 모집 공고 묶기 · 원본은 별도로 보존'});
  await audit(tx,{actor,action:'create_notice_bundle',entity:'content_item',entityId:item.id,channelId,detail:{jobId:job.id,itemIds:body.itemIds}});
  return view(job);
 });
}

export async function noticeBundleJob(db:DB,channelId:number,jobId:number):Promise<NoticeBundleReply>{
 const [job]=await db.select().from(jobs).where(and(eq(jobs.id,jobId),eq(jobs.channelId,channelId),eq(jobs.type,NOTICE_BUNDLE_JOB)));
 if(!job)throw new HttpError(404,'공고 묶기 작업을 찾을 수 없습니다.');
 return {...view(job),...(job.lastError?{error:job.lastError}:{})};
}

const isGedSource=(doc:SourceDocument)=>{try{return /(^|\.)ged\.kedi\.re\.kr$/.test(new URL(doc.originalUrl).hostname);}catch{return false;}};
const gedPrimaryProof=(doc:SourceDocument)=>doc.attachments.some(a=>a.kind==='pdf'&&(a as typeof a&{role?:string}).role==='primary'&&a.status==='ok'&&!!a.pdfSha256&&!!a.pages?.some(page=>page.text.trim()));
function needsFetch(doc:SourceDocument){
 if(doc.kind==='manual_text')return false;
 if(doc.fetchStatus!=='ok'||!doc.fetchedText?.trim()||!doc.contentHash)return true;
 const ged=isGedSource(doc);
 const pdf=doc.attachments.filter(a=>a.kind==='pdf'||/\.pdf(?:$|[?\s])/i.test(a.name));
 const primary=pdf.find(a=>(a as typeof a&{role?:string}).role==='primary');
 return ged&&(!primary||primary.status!=='ok'||!primary.pdfSha256||!primary.pages?.length)||pdf.some(a=>a.status==='pending');
}
function sourceIssue(doc:SourceDocument):string|undefined{
 const incomplete=doc.attachments.filter(a=>a.status!=='ok'||a.truncated||a.unreadablePages?.length);
 return incomplete.length?`첨부자료 확인 필요: ${incomplete.map(a=>`${a.name}${a.reason?` (${a.reason})`:''}`).join(' · ')}`:undefined;
}
function meaningfulExtraction(value:Record<string,unknown>){return !!(value.organization||value.academic_year||value.audience||value.eligibility||Array.isArray(value.schedules)&&value.schedules.length||Array.isArray(value.evidence)&&value.evidence.length);}
function extractionIssue(row:NoticeBundleRow){
 const value=row.extracted;
 if(value&&(!value.organization||!value.audience||!Array.isArray(value.schedules)||!value.schedules.length))row.issue=[row.issue,'기관·지원 대상·일정 중 확인되지 않은 항목이 있습니다.'].filter(Boolean).join(' · ');
}

/** A claim processes one original notice, persists its result, then releases
 * the lease. Reopening/another worker resumes at nextIndex without redoing paid
 * extraction. A crash during a reserved AI call is terminal, not auto-replayed. */
export async function processNoticeBundleJob(db:DB,job:Job,workerId:string):Promise<boolean>{
 const progress=structuredClone(job.payload) as unknown as Progress;
 const guard=async(tx:DB)=>{
  if(stopping)throw new Error('서버 종료로 공고 묶기를 중단했습니다.');
  const [fresh]=await tx.select().from(jobs).where(and(eq(jobs.id,job.id),eq(jobs.type,NOTICE_BUNDLE_JOB),eq(jobs.status,'running'),eq(jobs.leaseOwner,workerId),sql`${jobs.leaseExpiresAt}>clock_timestamp()`)).for('update');
  if(!fresh)throw new Error('공고 묶기 작업의 실행 권한이 만료됐습니다.');
  if(await getSetting(tx,'global_stop',false))throw new Error('전체 작업이 정지돼 공고 묶기를 중단했습니다.');
  const [channel]=await tx.select().from(channels).where(and(eq(channels.id,job.channelId!),eq(channels.active,true)));
  const [item]=await tx.select().from(contentItems).where(and(eq(contentItems.id,progress.itemId),eq(contentItems.channelId,job.channelId!)));
  const [board]=await tx.select().from(studioCards).where(eq(studioCards.sourceItemId,progress.itemId));
  if(!channel||!item||board?.trashedAt)throw new Error('채널이나 공고 묶음의 상태가 변경돼 중단했습니다.');
  if(item.version!==progress.targetVersion)throw new Error('공고 묶음이 편집돼 자동으로 덮어쓰지 않았습니다.');
  return {fresh,channel,item};
 };
 try{
  const state=await db.transaction(tx=>guard(tx as DB));
  if(progress.nextIndex<progress.selections.length){
   const index=progress.nextIndex,selection=progress.selections[index],row=progress.bundle.rows[index];
   let [doc]=selection.sourceId?await db.select().from(sourceDocuments).where(eq(sourceDocuments.id,selection.sourceId)):[];
   if(!doc){Object.assign(row,{fetchStatus:'failed',extracted:null,issue:'원문이 연결되지 않은 공고입니다. 원문 링크나 본문을 먼저 추가해 주세요.'});}
   else{
    const refreshed=needsFetch(doc);
    let attemptIssue:string|undefined;
    if(refreshed){
     const started=new Date();
     const result=await fetchPublisherArticle(sourceFetchUrl(doc),undefined,{title:doc.title||row.title});
     if(!result.ok)attemptIssue=`이번 원문 조회를 완료하지 못했습니다: ${result.error}`;
     await db.transaction(tx=>guard(tx as DB));
     doc=(await persistSourceFetchAttempt(db,doc.id,result,{attemptStartedAt:started})).document;
    }
    Object.assign(row,{url:publicUrl(typeof doc.meta.finalUrl==='string'?doc.meta.finalUrl:doc.originalUrl),fetchStatus:doc.fetchStatus==='ok'?'ok':['failed','blocked','unsupported'].includes(doc.fetchStatus)?doc.fetchStatus:'failed',text:doc.fetchedText??'',textHash:doc.contentHash,attachments:doc.attachments,issue:[attemptIssue,doc.fetchStatus==='ok'?sourceIssue(doc):doc.fetchError||'원문을 읽지 못했습니다.'].filter(Boolean).join(' · ')||undefined});
    if(doc.kind==='manual_text')row.issue=[row.issue,'직접 입력한 본문입니다. 실제 모집요강 원문과 대조해 확인해 주세요.'].filter(Boolean).join(' · ');
    if(doc.kind!=='manual_text'&&isGedSource(doc)&&!gedPrimaryProof(doc)){row.fetchStatus='unsupported';row.extracted=null;row.issue=[row.issue,'모집요강 PDF의 실제 페이지 본문을 확보하지 못했습니다. 이전 게시판 목록을 모집요강으로 사용하지 않았습니다.'].filter(Boolean).join(' · ');}
    if(row.fetchStatus==='ok'&&doc.fetchedText?.trim()){
     const [original]=await db.select().from(contentItems).where(and(eq(contentItems.id,selection.itemId),eq(contentItems.channelId,job.channelId!)));
     const [revision]=selection.revisionId?await db.select().from(contentRevisions).where(and(eq(contentRevisions.id,selection.revisionId),eq(contentRevisions.contentItemId,selection.itemId))):[];
     const saved=noticePayloadSchema.safeParse(revision?.payload??original?.edited??original?.extracted);
     const ai=channelAiSelection(state.channel,'summary');
     if(original&&(original.version!==selection.version||original.currentRevisionId!==selection.revisionId))row.issue=[row.issue,'자료를 선택한 뒤 원공고의 편집본이 변경됐습니다. 현재 확보한 원문과 비교해 주세요.'].filter(Boolean).join(' · ');
     const sameSource=!!selection.sourceHash&&selection.sourceHash===doc.contentHash&&!!selection.sourceFetchedAt&&doc.lastFetchedAt?.toISOString()===selection.sourceFetchedAt;
     const groundedSaved=!!revision&&!!doc.lastFetchedAt&&doc.lastFetchedAt<=revision.createdAt&&original?.version===selection.version;
     if(!refreshed&&sameSource&&groundedSaved&&saved.success&&meaningfulExtraction(saved.data as unknown as Record<string,unknown>)){row.extracted=saved.data as unknown as Record<string,unknown>;}
     else if(channelAiAvailability()[ai.provider]){
      await db.transaction(async tx=>{await guard(tx as DB);await tx.update(jobs).set({maxAttempts:job.attempts}).where(eq(jobs.id,job.id));});
      job.maxAttempts=job.attempts;
      const controller=new AbortController();activeCalls.add(controller);let checking=false;
      const monitor=setInterval(()=>{if(checking||controller.signal.aborted)return;checking=true;void guard(db).catch(error=>controller.abort(error)).finally(()=>{checking=false;});},2000);monitor.unref();
      const result=await (async()=>{try{return await withGenerationContext({signal:controller.signal,assertActive:async tx=>{await guard(tx);}},()=>extractNotice({sources:[{source_id:doc.id,kind:doc.kind,url:doc.originalUrl,title:doc.title,published:doc.publishedRaw,text:doc.fetchedText!}],sourceHint:original?.category??null,now:new Date(),budget:new LlmBudget(1),completeDocument:true,...ai}));}finally{clearInterval(monitor);activeCalls.delete(controller);}})();
      if(result.ok){row.extracted=result.data as unknown as Record<string,unknown>;if(result.data.has_conflict)row.issue=[row.issue,'원문에 상충되는 조건이 있습니다.'].filter(Boolean).join(' · ');}
      else{row.extracted=null;row.issue=[row.issue,`본문은 확보했지만 조건 정리가 필요합니다: ${result.error}`].filter(Boolean).join(' · ');}
     }else{row.extracted=null;row.issue=[row.issue,'본문은 확보했습니다. 연결된 작성 AI가 없어 기관별 조건은 정리 대기입니다.'].filter(Boolean).join(' · ');}
     extractionIssue(row);
    }
   }
   progress.nextIndex++;
   await db.transaction(async tx=>{await guard(tx as DB);await tx.update(jobs).set({status:'queued',payload:progress as unknown as Record<string,unknown>,maxAttempts:100,runAfter:new Date(),leaseOwner:null,leaseExpiresAt:null,heartbeatAt:new Date()}).where(eq(jobs.id,job.id));});
   return true;
  }
  progress.bundle.status=progress.bundle.rows.every(row=>row.fetchStatus==='ok'&&!!row.extracted&&!row.issue)?'ready':'partial';
  await db.transaction(async tx=>{
   const {item}=await guard(tx as DB);
   const [previous]=item.currentRevisionId?await tx.select().from(contentRevisions).where(eq(contentRevisions.id,item.currentRevisionId)):[];
   if(previous?.payload.noticeBundle&&((previous.payload.noticeBundle as NoticeBundle).status!=='collecting'||previous.author==='operator'))throw new Error('묶음 원고가 편집돼 자동으로 덮어쓰지 않았습니다.');
   const payload=buildNoticeBundlePayload(progress.bundle,progress.title);
   await createRevision(tx,{contentItemId:item.id,author:'system',payload,note:'선택 공고별 본문·첨부와 조건을 각각 정리했습니다. 확인이 필요한 값은 별도로 표시했습니다.'});
   await tx.update(contentItems).set({version:item.version+1,reviewStatus:'pending',evidenceStatus:'needs_review',edited:null,extracted:payload,updatedAt:new Date()}).where(eq(contentItems.id,item.id));
   await tx.update(jobs).set({status:'succeeded',payload:progress as unknown as Record<string,unknown>,result:{itemId:item.id,bundle:progress.bundle},finishedAt:new Date(),leaseOwner:null,leaseExpiresAt:null}).where(eq(jobs.id,job.id));
  });
  return true;
 }catch(error){await failJob(db,job,workerId,(error as Error).message||'공고 묶기를 완료하지 못했습니다.',false);return false;}
}
