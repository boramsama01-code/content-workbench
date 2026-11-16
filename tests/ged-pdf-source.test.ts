import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
const {pdfs,destroy}=vi.hoisted(()=>({pdfs:new Map<string,string[]>(),destroy:vi.fn(async()=>{})}));
vi.mock('unpdf',()=>({
  getDocumentProxy:vi.fn(async(bytes:Uint8Array)=>{const key=Buffer.from(bytes).toString();return {numPages:pdfs.get(key)?.length??1,key,destroy};}),
  extractText:vi.fn(async(document:{key:string},options:{mergePages:boolean})=>({text:options.mergePages?(pdfs.get(document.key)??[]).join('\n'):pdfs.get(document.key)??[]})),
}));
import {fetchAndExtract,extractHtml,extractPdf} from '../server/services/extract';
import {gedNoticeAttachments,GED_PDF_LIMITS} from '../server/services/gedAttachments';
const page='https://ged.kedi.re.kr/inno/slctNotiInnoPop.do?pop1=Y&stndYear=2027&orgId=10117174001&seq=25584';
const link=(physical:string,name:string)=>`<a href="#fn_none" onclick="fn_down('${physical}','${name}');">${name}(424.92 KB)</a>`;
const markup=()=>`<div class="tit">선발공고자료</div>${link('faq.pdf','FAQ.pdf')}${link('guide.pdf','2027학년도 모집요강.pdf')}${link('qa.pdf','사회통합전형 Q_A.pdf')}${link('forms.zip','추천서 서식.zip')}`;
const body=(key:string)=>Buffer.from(`%PDF-${key}`);
const response=(url:string,bytes:string|Buffer,contentType='text/html')=>({finalUrl:url,body:Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes),contentType,status:200});
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const prose=(topic:string)=>`${topic} 확인된 공고의 지원 대상은 현재 중학교 1학년이고 접수 마감은 2026년 11월 25일 오후 6시입니다.`;
beforeEach(()=>{pdfs.clear();destroy.mockClear();pdfs.set(body('guide').toString(),[prose('대상'),prose('일정')]);pdfs.set(body('faq').toString(),[prose('FAQ')]);pdfs.set(body('qa').toString(),[prose('사회통합')]);});
function fetcher(html=markup()){
 return vi.fn(async(url:string)=>url===page?response(page,html):response(url,body(new URL(url).searchParams.get('physFileNm')!.replace('.pdf','')),'application/x-unknown-content-type;charset=utf-8'));
}

describe('GED 공개 모집요강 첨부 읽기',()=>{
 it('해시 링크를 실제 파일로 오인하지 않고 공개 fn_down 인자를 별개 파일로 연결한다',()=>{
  const result=extractHtml(markup(),page),items=result.attachments;
  expect(items).toHaveLength(4);expect(items.map(item=>item.name)).toEqual(['2027학년도 모집요강.pdf','FAQ.pdf','사회통합전형 Q_A.pdf','추천서 서식.zip']);
  expect(items[0]).toMatchObject({role:'primary',kind:'pdf',status:'pending'});
  expect(items[3]).toMatchObject({role:'supplement',kind:'zip',status:'manual_check'});
  expect(new Set(items.map(item=>item.url)).size).toBe(4);
  const url=new URL(items[0].url);expect(url.pathname).toBe('/inno/fileDownload.do');
  expect([...url.searchParams]).toEqual([['filePath','dataFiles'],['physFileNm','guide.pdf'],['logiFileNm','2027학년도 모집요강.pdf']]);
  expect(items.every(item=>!new URL(item.url).hash)).toBe(true);
 });
 it('사이트 스크립트를 실행하지 않고 경로 조작·알 수 없는 함수를 거절한다',()=>{
  const html=[link('../secret.pdf','모집요강.pdf'),link('%2e%2e.pdf','모집요강.pdf'),link('safe.pdf','../모집요강.pdf'),'<a href="#" onclick="fn_down(\'x.pdf\',\'x.pdf\'); fetch(\'https://other.example/\');">x.pdf</a>'].join('');
  expect(gedNoticeAttachments(html,page)).toEqual([]);
  expect(gedNoticeAttachments(markup(),page.replace('ged.kedi.re.kr','other.example'))).toEqual([]);
  expect(gedNoticeAttachments(markup(),page.replace('/inno/slctNotiInnoPop.do','/other.do'))).toEqual([]);
  expect(gedNoticeAttachments(markup(),page.replace('seq=25584','seq=bad'))).toEqual([]);
 });
 it('모집요강·FAQ·추가 PDF를 예산 안에서 읽고 파일·쪽별 텍스트와 해시를 보관한다',async()=>{
  const read=fetcher(),reserve=vi.fn(()=>true),result=await fetchAndExtract(page,read,{title:'공식 모집 공고',takeExtraCall:reserve});
  expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.error);
  expect(result.contentKind).toBe('pdf');expect(result.title).toBe('공식 모집 공고');expect(result.finalUrl).toBe(page);
  expect(result.text).toContain('[첨부 PDF: 2027학년도 모집요강.pdf · 2쪽]');expect(result.text).toContain(prose('일정'));expect(result.text).toContain(prose('FAQ'));
  expect(result.text).not.toContain('선발공고자료');expect(result.text).not.toContain('(424.92 KB)');
  expect(result.attachments[0]).toMatchObject({status:'ok',role:'primary',pageCount:2,pages:[{page:1,text:prose('대상')},{page:2,text:prose('일정')}],pdfSha256:hash(body('guide')),textSha256:hash(`${prose('대상')}\n${prose('일정')}`),truncated:false,unreadablePages:[]});
  expect(result.attachments[3].status).toBe('manual_check');expect(read).toHaveBeenCalledTimes(4);expect(reserve).toHaveBeenCalledTimes(3);expect(destroy).toHaveBeenCalledTimes(3);
  for(const [,options] of read.mock.calls.slice(1) as unknown as Array<[string,{allowedHosts:string[];maxBytes:number;timeoutMs:number}]>){expect(options.allowedHosts).toEqual(['ged.kedi.re.kr']);expect(options.maxBytes).toBe(8*1024*1024);expect(options.timeoutMs).toBeLessThanOrEqual(12_000);}
 });
 it('추가 요청 한도가 끝나면 성공한 모집요강은 유지하고 나머지 파일을 미확보로 표시한다',async()=>{
  const read=fetcher();let calls=0;
  const result=await fetchAndExtract(page,read,{takeExtraCall:()=>++calls===1});
  expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.error);
  expect(read).toHaveBeenCalledTimes(2);expect(result.attachments[0].status).toBe('ok');
  expect(result.attachments[1]).toMatchObject({status:'pending',reason:expect.stringContaining('호출 한도')});
  expect(result.text).not.toContain(prose('FAQ'));
  const denied=await fetchAndExtract(page,fetcher(),{takeExtraCall:()=>false});expect(denied).toMatchObject({ok:false,status:'unsupported',attachments:[{status:'pending'},expect.anything(),expect.anything(),expect.anything()]});
 });
 it('스캔된 주 모집요강을 FAQ 본문만으로 읽기 성공 처리하지 않는다',async()=>{
  pdfs.set(body('guide').toString(),['','']);
  const result=await fetchAndExtract(page,fetcher());
  expect(result).toMatchObject({ok:false,status:'unsupported',attachments:[{status:'manual_check',role:'primary',unreadablePages:[1,2]},{status:'ok'},{status:'ok'},{status:'manual_check'}]});
 });
 it('PDF 일부 쪽을 읽지 못한 사실과 문자 한도를 숨기지 않는다',async()=>{
  pdfs.set(body('guide').toString(),[prose('첫 쪽'),'',prose('마지막 쪽')]);
  const partial=await fetchAndExtract(page,fetcher(),{takeExtraCall:(()=>{let n=0;return()=>++n===1;})()});
  expect(partial.ok).toBe(true);if(!partial.ok)throw new Error(partial.error);
  expect(partial.attachments[0]).toMatchObject({unreadablePages:[2],reason:expect.stringContaining('2쪽')});expect(partial.text).toContain('· 3쪽]');
  pdfs.set(body('guide').toString(),Array.from({length:80},()=>prose('대상').repeat(40)));
  const limited=await fetchAndExtract(page,fetcher());expect(limited.ok).toBe(true);if(!limited.ok)throw new Error(limited.error);
  expect(limited.text.length).toBeLessThanOrEqual(GED_PDF_LIMITS.text);expect(limited.attachments[0].truncated).toBe(true);expect(limited.attachments[0].reason).toContain('일부만');
 });
 it('HTML 오류 응답·타 도메인 이동·과도한 페이지는 읽은 PDF로 인정하지 않는다',async()=>{
  const one=link('guide.pdf','모집요강.pdf');
  for(const invalid of [response('https://other.example/guide.pdf',body('guide'),'application/pdf'),response(page,'<h1>로그인</h1>','text/html')]){
   const read=vi.fn(async(url:string)=>url===page?response(page,one):invalid);
   expect(await fetchAndExtract(page,read)).toMatchObject({ok:false,attachments:[{status:'failed'}]});
  }
  pdfs.set(body('guide').toString(),Array(81).fill(prose('본문')));
  expect(await fetchAndExtract(page,fetcher(one))).toMatchObject({ok:false,attachments:[{status:'failed',reason:expect.stringContaining('80쪽')}]});
 });
 it('HWP가 주 모집요강이면 보조 PDF만으로 자동 확보했다고 하지 않는다',async()=>{
  const html=link('guide.hwp','모집요강.hwp')+link('faq.pdf','FAQ.pdf');
  const read=fetcher(html),result=await fetchAndExtract(page,read);
  expect(result).toMatchObject({ok:false,attachments:[{role:'primary',kind:'hwp',status:'manual_check'},{kind:'pdf',status:'ok'}]});
  expect(read).toHaveBeenCalledTimes(2);
 });
 it('기존 단일 PDF의 20k 텍스트 계약과 문서 메모리 해제를 유지한다',async()=>{
  pdfs.set(body('legacy').toString(),['가'.repeat(30_000)]);
  expect((await extractPdf(body('legacy'))).length).toBe(20_000);expect(destroy).toHaveBeenCalledOnce();
 });
});
