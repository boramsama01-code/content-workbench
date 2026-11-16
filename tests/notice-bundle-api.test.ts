import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import request from 'supertest';
import {eq,and,sql} from 'drizzle-orm';
import {setTestEnv,resetDb,login} from './helpers';
import {emptyPayload} from '../shared/payloads';
setTestEnv();
const fetchSource=vi.hoisted(()=>vi.fn());
const extractOne=vi.hoisted(()=>vi.fn());
vi.mock('../server/services/publisherLookup',async original=>({...await original<object>(),fetchPublisherArticle:fetchSource}));
vi.mock('../server/services/llm',async original=>({...await original<object>(),extractNotice:extractOne}));
const {createApp}=await import('../server/app');
const {getDb,closeDb}=await import('../server/db');
const {channels,contentItems,contentRevisions,sourceDocuments,contentSources,jobs,appSettings}=await import('../shared/schema');
const {createRevision}=await import('../server/content');
const {processNoticeBundleJob,NOTICE_BUNDLE_JOB,createNoticeBundle}=await import('../server/services/noticeBundle');
const {claimJob,recoverExpired}=await import('../server/worker/queue');
const {loadNoticeBundleWriting}=await import('../server/services/noticeBundleWriting');
const {currentGenerationSignal}=await import('../server/services/generationContext');
let app:ReturnType<typeof createApp>;
beforeAll(async()=>{await resetDb();app=createApp();});
beforeEach(()=>{vi.clearAllMocks();delete process.env.OPENAI_API_KEY;delete process.env.GEMINI_API_KEY;delete process.env.ANTHROPIC_API_KEY;});
afterAll(closeDb);
function payload(label:string){return {...emptyPayload('notice',`${label} 모집`),organization:label,academic_year:'2027학년도',audience:'현재 초등학교 5학년',eligibility:'공고에 적힌 지역의 학교 재학생',schedules:[{kind:'apply',label:'학생 지원',end:{date:'2026-11-25',time:'18:00'},raw:'2026년 11월 25일 18시까지'}],key_details:`${label} 학생지원조건을 그대로 보존합니다.`,evidence:[]};}
async function notice(label:string,options:{missing?:boolean;pendingPdf?:boolean;blank?:boolean}={}){
 const db=getDb(),url=`https://official.example/${crypto.randomUUID()}`;
 const [doc]=options.missing?[]:await db.insert(sourceDocuments).values({normalizedUrl:url,originalUrl:url,kind:'official',title:`${label} 모집`,fetchedText:`${label} 2027학년도 모집요강. 현재 초등학교 5학년이며 관내 학교 재학생이 지원합니다. 학생 지원 마감은 2026년 11월 25일 18시까지입니다.`,contentHash:'a'.repeat(64),fetchStatus:'ok',lastFetchedAt:new Date(Date.now()-1000),attachments:options.pendingPdf?[{url:`${url}.pdf`,name:'모집요강.pdf',kind:'pdf',status:'pending'}]:[]}).returning();
 const [item]=await db.insert(contentItems).values({channelId:1,kind:'notice',title:`${label} 모집`,origin:'manual',primarySourceId:doc?.id??null}).returning();
 const data=options.blank?emptyPayload('notice',item.title):payload(label);
 const rev=await createRevision(db,{contentItemId:item.id,author:'operator',payload:data});
 return {item:(await db.select().from(contentItems).where(eq(contentItems.id,item.id)))[0],doc,rev};
}
async function pair(){return [await notice('기관 A'),await notice('기관 B')];}
async function step(worker='bundle-test'){
 const job=await claimJob(getDb(),worker,[NOTICE_BUNDLE_JOB]);expect(job).toBeTruthy();
 return {job:job!,ok:await processNoticeBundleJob(getDb(),job!,worker)};
}
async function finish(count:number){for(let n=0;n<count+1;n++)await step(`step-${n}`);}

describe('선택한 모집 공고로 별도 콘텐츠 만들기',()=>{
 it('인증·채널 경계를 확인하고 같은 요청을 다시 보내도 원본을 합치거나 중복 생성하지 않는다',async()=>{
  const source=await pair(),{agent,csrf}=await login(app),input={itemIds:source.map(v=>v.item.id),requestId:crypto.randomUUID(),title:'지역 영재학급 비교'};
  expect((await request(app).post('/api/channels/1/notice-bundles').send(input)).status).toBe(401);
  expect((await agent.post('/api/channels/1/notice-bundles').send(input)).status).toBe(403);
  const a=await agent.post('/api/channels/1/notice-bundles').set('x-csrf-token',csrf).send(input);expect(a.status,JSON.stringify(a.body)).toBe(202);
  const b=await agent.post('/api/channels/1/notice-bundles').set('x-csrf-token',csrf).send(input);expect(b.body).toEqual(a.body);
  expect(a.body.itemId).not.toBe(source[0].item.id);expect(a.body.bundle.rows).toHaveLength(2);
  expect(a.body.bundle.jobId).toBe(a.body.jobId);
  expect((await agent.get(`/api/channels/2/notice-bundles/${a.body.jobId}`)).status).toBe(404);
  expect((await agent.post('/api/channels/1/notice-bundles').set('x-csrf-token',csrf).send({...input,title:'다른 묶음'})).status).toBe(409);
  for(const original of source)expect((await getDb().select().from(contentItems).where(eq(contentItems.id,original.item.id)))[0]).toEqual(original.item);
  await finish(2);
  const ready=await agent.get(`/api/channels/1/notice-bundles/${a.body.jobId}`);expect(ready.body).toMatchObject({status:'succeeded',bundle:{status:'ready'}});
  expect(ready.body.bundle.rows.map((row:any)=>row.extracted.organization)).toEqual(['기관 A','기관 B']);
  expect(fetchSource).not.toHaveBeenCalled();expect(extractOne).not.toHaveBeenCalled();
  const [item]=await getDb().select().from(contentItems).where(eq(contentItems.id,a.body.itemId));
  expect(item.primarySourceId).toBeNull();expect(item.reviewStatus).toBe('pending');
  const [revision]=await getDb().select().from(contentRevisions).where(eq(contentRevisions.id,item.currentRevisionId!));
  expect((revision.payload.noticeBundle as any).rows).toHaveLength(2);expect(revision.payload.cardCopy).toBeTruthy();
  expect((await getDb().select().from(contentSources).where(eq(contentSources.contentItemId,item.id))).map(v=>v.role)).toContain('bundle_primary');
  await expect(createNoticeBundle(getDb(),1,{itemIds:[item.id,source[0].item.id],requestId:crypto.randomUUID()},'operator')).rejects.toThrow('원본 모집 공고');
 });
 it('자료 한 건마다 진행을 저장해 다른 워커가 이어 처리하며 없는 원문도 행에서 숨기지 않는다',async()=>{
  const first=await notice('기관 C'),second=await notice('원문 없는 기관',{missing:true});
  const created=await createNoticeBundle(getDb(),1,{itemIds:[first.item.id,second.item.id],requestId:crypto.randomUUID()},'operator');
  await step('worker-one');
  const [progress]=await getDb().select().from(jobs).where(eq(jobs.id,created.jobId));expect(progress.status).toBe('queued');expect(progress.payload.nextIndex).toBe(1);
  expect((progress.payload.bundle as any).rows[0].extracted.organization).toBe('기관 C');
  await step('worker-two');await step('worker-three');
  const [finished]=await getDb().select().from(jobs).where(eq(jobs.id,created.jobId));
  expect(finished.status).toBe('succeeded');expect((finished.payload.bundle as any).status).toBe('partial');
  expect((finished.payload.bundle as any).rows[1]).toMatchObject({itemId:second.item.id,fetchStatus:'failed',extracted:null});
 });
 it('미확보 PDF가 있으면 저장된 HTML로 완료 처리하지 않고 원문을 다시 읽는다',async()=>{
  const first=await notice('첨부 기관',{pendingPdf:true}),second=await notice('다른 기관');
  fetchSource.mockResolvedValueOnce({ok:false,status:'unsupported',error:'스캔된 모집요강이라 텍스트 확인이 필요합니다.',attachments:[{url:first.doc!.originalUrl+'.pdf',name:'모집요강.pdf',kind:'pdf',status:'manual_check'}]});
  const created=await createNoticeBundle(getDb(),1,{itemIds:[first.item.id,second.item.id],requestId:crypto.randomUUID()},'operator');
  await finish(2);
  const [job]=await getDb().select().from(jobs).where(eq(jobs.id,created.jobId));
  expect(fetchSource).toHaveBeenCalledWith(first.doc!.originalUrl,undefined,{title:first.doc!.title});
  expect((job.payload.bundle as any).status).toBe('partial');expect((job.payload.bundle as any).rows[0].issue).toContain('스캔');
  expect((job.payload.bundle as any).rows[0].text).toContain('첨부 기관');expect(extractOne).not.toHaveBeenCalled();
 });
 it('중지·원고 편집·외부 채널 항목을 확인하고 사용자 변경을 덮어쓰지 않는다',async()=>{
  const source=await pair();
  await expect(createNoticeBundle(getDb(),2,{itemIds:source.map(v=>v.item.id),requestId:crypto.randomUUID()},'operator')).rejects.toThrow();
  const created=await createNoticeBundle(getDb(),1,{itemIds:source.map(v=>v.item.id),requestId:crypto.randomUUID()},'operator');
  await getDb().update(contentItems).set({version:2,title:'사용자가 직접 편집한 제목'}).where(eq(contentItems.id,created.itemId));
  expect((await step()).ok).toBe(false);
  const [item]=await getDb().select().from(contentItems).where(eq(contentItems.id,created.itemId));expect(item.title).toBe('사용자가 직접 편집한 제목');
  expect((await getDb().select().from(jobs).where(eq(jobs.id,created.jobId)))[0].status).toBe('failed');expect(fetchSource).not.toHaveBeenCalled();
 });
 it('기관별 AI 입력을 분리하고 불명확한 유료 실행은 lease 만료 후 자동 반복하지 않는다',async()=>{
  const a=await notice('AI 기관 A',{blank:true}),b=await notice('AI 기관 B',{blank:true});
  process.env.GEMINI_API_KEY='fixture-key';
  const created=await createNoticeBundle(getDb(),1,{itemIds:[a.item.id,b.item.id],requestId:crypto.randomUUID()},'operator');
  let entered!:()=>void,release!:(value:any)=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  extractOne.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;entered();}));
  const job=await claimJob(getDb(),'ai-worker',[NOTICE_BUNDLE_JOB]);const processing=processNoticeBundleJob(getDb(),job!,'ai-worker');await started;
  expect(extractOne.mock.calls[0][0].sources).toHaveLength(1);expect(extractOne.mock.calls[0][0].sources[0].source_id).toBe(a.doc!.id);
  expect(extractOne.mock.calls[0][0].sources[0].text).not.toContain('AI 기관 B');
  expect((await getDb().select().from(jobs).where(eq(jobs.id,created.jobId)))[0].maxAttempts).toBe(1);
  await getDb().update(jobs).set({leaseExpiresAt:new Date(Date.now()-1000)}).where(eq(jobs.id,created.jobId));await recoverExpired(getDb());
  release({ok:true,data:payload('AI 기관 A'),model:'fixture',usage:{inputTokens:1,outputTokens:1}});expect(await processing).toBe(false);
  expect((await getDb().select().from(jobs).where(eq(jobs.id,created.jobId)))[0].status).toBe('failed');
  expect(await claimJob(getDb(),'another-worker',[NOTICE_BUNDLE_JOB])).toBeNull();expect(extractOne).toHaveBeenCalledTimes(1);
 });
 it('작성에는서버에저장한각기관·실제PDF쪽을전달하고수집중이나초과자료는모델호출전에알린다',async()=>{
  const source=await pair(),db=getDb();
  await db.update(sourceDocuments).set({attachments:[{url:source[0].doc!.originalUrl+'.pdf',name:'기관 A 모집요강',kind:'pdf',status:'ok',pages:[{page:3,text:'기관 A 학교 추천 마감은 11월 21일입니다.'}],pageCount:4,pdfSha256:'b'.repeat(64)}]}).where(eq(sourceDocuments.id,source[0].doc!.id));
  const created=await createNoticeBundle(db,1,{itemIds:source.map(v=>v.item.id),requestId:crypto.randomUUID()},'operator');
  await expect(loadNoticeBundleWriting(db,created.itemId)).rejects.toMatchObject({status:409});
  await finish(2);
  const context=await loadNoticeBundleWriting(db,created.itemId);expect(context?.text).toContain('기관 A');expect(context?.text).toContain('기관 B');expect(context?.text).toContain('3쪽: 기관 A 학교 추천 마감');
  const [item]=await db.select().from(contentItems).where(eq(contentItems.id,created.itemId));const [rev]=await db.select().from(contentRevisions).where(eq(contentRevisions.id,item.currentRevisionId!));
  const bundle=structuredClone(rev.payload.noticeBundle) as any;bundle.rows[0].attachments=[];bundle.rows[0].text='가'.repeat(200001);
  await createRevision(db,{contentItemId:item.id,author:'system',payload:{...rev.payload,noticeBundle:bundle}});
  await expect(loadNoticeBundleWriting(db,item.id)).rejects.toMatchObject({status:422});expect(extractOne).not.toHaveBeenCalled();
 });
 it('GED이전목록캐시가ok여도PDF쪽근거가없으면실패본문을모집요강으로추출하지않는다',async()=>{
  const a=await notice('GED 레거시'),b=await notice('정상기관'),db=getDb();
  await db.update(sourceDocuments).set({originalUrl:'https://ged.kedi.re.kr/notice/popup.do?seq=7'}).where(eq(sourceDocuments.id,a.doc!.id));
  fetchSource.mockResolvedValueOnce({ok:false,status:'unsupported',error:'모집요강 PDF를 읽지 못했습니다.',attachments:[]});
  const created=await createNoticeBundle(db,1,{itemIds:[a.item.id,b.item.id],requestId:crypto.randomUUID()},'operator');await finish(2);
  const [job]=await db.select().from(jobs).where(eq(jobs.id,created.jobId));const row=(job.payload.bundle as any).rows[0];
  expect(row).toMatchObject({fetchStatus:'unsupported',extracted:null});expect(row.issue).toContain('이전 게시판 목록');expect((job.payload.bundle as any).status).toBe('partial');expect(extractOne).not.toHaveBeenCalled();
 });
 it('GED연결에직접붙여넣은본문은자동PDF처럼차단하지않고직접입력확인필요로보존한다',async()=>{
  const a=await notice('직접 입력 기관'),b=await notice('자동 확보 기관'),db=getDb();
  await db.update(sourceDocuments).set({kind:'manual_text',originalUrl:'https://ged.kedi.re.kr/notice/popup.do?seq=8',attachments:[]}).where(eq(sourceDocuments.id,a.doc!.id));
  const created=await createNoticeBundle(db,1,{itemIds:[a.item.id,b.item.id],requestId:crypto.randomUUID()},'operator');await finish(2);
  const [job]=await db.select().from(jobs).where(eq(jobs.id,created.jobId));const row=(job.payload.bundle as any).rows[0];
  expect(row).toMatchObject({sourceId:a.doc!.id,fetchStatus:'ok',extracted:{organization:'직접 입력 기관'}});expect(row.text).toContain('직접 입력 기관');expect(row.issue).toContain('직접 입력');
  expect((job.payload.bundle as any).status).toBe('partial');expect(fetchSource).not.toHaveBeenCalled();expect(extractOne).not.toHaveBeenCalled();
 });
 it('원문이기존조건정리이후바뀌면옛지원대상을새본문에재사용하지않는다',async()=>{
  const a=await notice('정정된 기관'),b=await notice('유지 기관'),db=getDb();
  await db.update(sourceDocuments).set({contentHash:'c'.repeat(64),lastFetchedAt:new Date(Date.now()+1000),fetchedText:'정정된 모집요강. 지원 대상은 현재 중학교 1학년입니다.'}).where(eq(sourceDocuments.id,a.doc!.id));
  const created=await createNoticeBundle(db,1,{itemIds:[a.item.id,b.item.id],requestId:crypto.randomUUID()},'operator');await finish(2);
  const [job]=await db.select().from(jobs).where(eq(jobs.id,created.jobId));const rows=(job.payload.bundle as any).rows;
  expect(rows[0].extracted).toBeNull();expect(rows[0].text).toContain('중학교 1학년');expect(rows[0].issue).toContain('정리 대기');expect(rows[1].extracted.organization).toBe('유지 기관');
  expect((await db.select().from(contentRevisions).where(eq(contentRevisions.id,a.rev.id)))[0].payload.audience).toBe('현재 초등학교 5학년');
 });
 it('진행중전체정지를감지하면유료호출신호를중단하고다음요청을시작하지않는다',async()=>{
  const a=await notice('중지 기관 A',{blank:true}),b=await notice('중지 기관 B',{blank:true}),db=getDb();process.env.GEMINI_API_KEY='fixture-key';
  const created=await createNoticeBundle(db,1,{itemIds:[a.item.id,b.item.id],requestId:crypto.randomUUID()},'operator');
  let entered!:()=>void,signal:AbortSignal|undefined;const started=new Promise<void>(resolve=>{entered=resolve;});
  extractOne.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{signal=currentGenerationSignal();signal!.addEventListener('abort',()=>reject(new Error('전체 정지로 중단')),{once:true});entered();}));
  const job=await claimJob(db,'stop-worker',[NOTICE_BUNDLE_JOB]);const processing=processNoticeBundleJob(db,job!,'stop-worker');await started;
  try{
   await db.insert(appSettings).values({key:'global_stop',value:true}).onConflictDoUpdate({target:appSettings.key,set:{value:true}});
   expect(await processing).toBe(false);expect(signal?.aborted).toBe(true);expect(extractOne).toHaveBeenCalledTimes(1);
   expect((await db.select().from(jobs).where(eq(jobs.id,created.jobId)))[0].status).toBe('failed');
  }finally{await db.update(appSettings).set({value:false}).where(eq(appSettings.key,'global_stop'));}
 });
});
