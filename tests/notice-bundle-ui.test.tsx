// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {NoticeBundleDialog,NoticeBundleComparison,NoticeBundlePanel,useNoticeBasket,type NoticeChoice} from '../client/src/NoticeBundle';
import {InboxPage} from '../client/src/pages/Inbox';
import type {NoticeBundle} from '../shared/noticeBundle';
const mocks=vi.hoisted(()=>({api:vi.fn(),navigate:vi.fn(),cid:1,toast:vi.fn(),rows:[] as any[]}));
vi.mock('../client/src/api',async original=>({...await original<object>(),api:mocks.api}));
vi.mock('wouter',async original=>({...await original<object>(),useLocation:()=>['/inbox',mocks.navigate],useSearch:()=>''}));
vi.mock('../client/src/state',()=>({useChannel:()=>{const channels=[{id:1,slug:'opportunities',name:'HighScoop',contentType:'notice',active:true},{id:2,slug:'other-notice',name:'다른 모집',contentType:'notice',active:true}];return {current:channels.find(ch=>ch.id===mocks.cid),selected:mocks.cid,channels,allChannels:channels,select:vi.fn()};},useDirtyGuard:()=>({confirmLeave:(callback:()=>void)=>callback()})}));
vi.mock('../client/src/toast',()=>({useToast:()=>mocks.toast}));
vi.mock('../client/src/pages/InboxKeywords',()=>({InboxKeywords:()=>null}));
vi.mock('../client/src/collection',()=>({CollectionPanel:()=>null,useKstToday:()=>'2026-11-16'}));
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let host:HTMLDivElement,root:Root,client:QueryClient;
const choices:NoticeChoice[]=[{id:1,title:'서울 A 영재학급',sourceStatus:'ok'},{id:2,title:'부산 B 영재학급',sourceStatus:'not_fetched'}];
const row=(id:number)=>({item:{id,title:`공고 ${id}`,kind:'notice',createdAt:'2026-11-16T00:00:00Z',category:null,subcategory:null,reviewStatus:'pending',evidenceStatus:'unverified',scheduleStatus:'unknown',relevance:'uncertain',publishStatus:'waiting',excluded:false,isSample:false},source:{id,kind:'official',url:`https://example.org/${id}`,fetchStatus:'not_fetched',snippet:'',publishedAt:null,publishedPrecision:null},channelSlug:'opportunities',channelName:'HighScoop'});
const bundle=():NoticeBundle=>({version:1,status:'partial',createdAt:'2026-11-16T00:00:00Z',sourceItemIds:[1,2],instruction:'지역과 추천 마감을 구분',rows:[{itemId:1,title:'서울 A 영재학급',url:'https://example.org/a',sourceId:11,fetchStatus:'ok',extracted:{organization:'서울 A학교',audience:'초등 6학년',eligibility:'서울 재학생',schedules:[{kind:'apply',label:'학생 접수',end:{date:'2026-11-20'}},{kind:'other',label:'교사 추천',end:{date:'2026-11-22'}}]},attachments:[{url:'https://example.org/a.pdf',name:'A 모집요강.pdf',kind:'pdf',status:'ok',pages:[{page:3,text:'서울 재학생만 지원합니다. 학생 접수는 11월 20일, 추천은 11월 22일까지.'}]}]},{itemId:2,title:'부산 B 영재학급',url:'https://example.org/b',sourceId:12,fetchStatus:'unsupported',extracted:{organization:'부산 B학교'},issue:'스캔 PDF의 텍스트를 읽지 못했습니다.'}]});
beforeEach(()=>{vi.clearAllMocks();sessionStorage.clear();localStorage.clear();mocks.cid=1;mocks.rows=[row(1),row(2)];mocks.api.mockImplementation(async(path:string)=>{if(path.startsWith('/items?'))return {total:2,page:1,pageSize:20,items:mocks.rows};throw new Error(path);});client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0},mutations:{retry:false}}});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());client.clear();host.remove();});
const settle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,40));});
async function render(content:React.ReactNode){await act(async()=>root.render(<QueryClientProvider client={client}>{content}</QueryClientProvider>));await settle();}
const button=(text:string)=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===text)!;
async function click(node:HTMLElement){await act(async()=>node.click());await settle();}

describe('여러 모집 공고 제작',()=>{
 it('수집함 리패치로 목록이 바뀌어도 선택을 보존하고 새 공고와 함께 제작한다',async()=>{
  const originals=structuredClone(mocks.rows);await render(<InboxPage/>);
  await click(host.querySelector<HTMLInputElement>('[aria-label="공고 1 선택"]')!);
  await click(host.querySelector<HTMLInputElement>('[aria-label="공고 2 선택"]')!);
  expect(host.querySelector('[aria-label="함께 만들 공고"]')?.textContent).toContain('2 / 10건');
  mocks.rows=[row(3)];await act(async()=>{await client.invalidateQueries({queryKey:['ch',1,'items']});});await settle();
  expect(host.querySelector('[aria-label="함께 만들 공고"]')?.textContent).toContain('공고 1');
  await click(host.querySelector<HTMLInputElement>('[aria-label="공고 3 선택"]')!);
  expect(host.querySelector('[aria-label="함께 만들 공고"]')?.textContent).toContain('3 / 10건');
  await click(button('선택한 공고로 콘텐츠 만들기'));
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain('선택한 3개 공고');
  expect(originals).toEqual([row(1),row(2)]);
  expect(mocks.api.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false);
 });
 it('선택 바구니는 채널별로 격리되고 최대 10건만 유지한다',async()=>{
  function Harness({cid}:{cid:number}){const basket=useNoticeBasket(cid);return <><output>{basket.choices.map(row=>row.id).join(',')}</output><button onClick={()=>basket.update(()=>Array.from({length:12},(_,index)=>({id:index+cid*100,title:`선택 ${index}`,sourceStatus:'ok'})))}>여러 건 선택</button></>;}
  await render(<Harness cid={1}/>);await click(button('여러 건 선택'));expect(host.querySelector('output')?.textContent?.split(',')).toHaveLength(10);
  await render(<Harness cid={2}/>);expect(host.querySelector('output')?.textContent).toBe('');
  await click(button('여러 건 선택'));await render(<Harness cid={1}/>);expect(host.querySelector('output')?.textContent?.startsWith('100,101')).toBe(true);
  expect(JSON.parse(sessionStorage.getItem('notice-bundle-selections:v1')!)[2][0].id).toBe(200);
 });
 it('응답 유실 후 닫고 다시 열어도 동일한 요청 ID와 원문 목록으로 복구한다',async()=>{
  let attempts=0;const before=structuredClone(choices);
  mocks.api.mockImplementation(async(path:string,options?:{method?:string;body?:unknown})=>{if(options?.method==='POST'){attempts++;if(attempts===1)throw new Error('연결이 끊겼습니다.');return {jobId:7,itemId:77,status:'queued'};}if(path.endsWith('/notice-bundles/7'))return {jobId:7,itemId:77,status:'succeeded',bundle:bundle()};throw new Error(path);});
  await render(<NoticeBundleDialog channelId={1} choices={choices} onClose={vi.fn()} onOpen={vi.fn()}/>);
  await click(button('공고를 읽고 초안 만들기'));const first=mocks.api.mock.calls.find(([,opts])=>opts?.method==='POST')![1].body;
  expect(host.textContent).toContain('연결이 끊겼습니다.');await render(<div/>);
  await render(<NoticeBundleDialog channelId={1} choices={choices} onClose={vi.fn()} onOpen={vi.fn()}/>);await click(button('같은 요청 다시 확인'));
  const posts=mocks.api.mock.calls.filter(([,opts])=>opts?.method==='POST');expect(posts).toHaveLength(2);expect(posts[1][1].body).toEqual(first);expect(first.itemIds).toEqual([1,2]);
  expect(host.querySelector('a[href="/items/1/77"]')).not.toBeNull();expect(host.textContent).toContain('스캔 PDF');expect(choices).toEqual(before);
 });
 it('실패한 작업의 재생성은 명시적인 버튼을 누를 때만 새 요청으로 만든다',async()=>{
  mocks.api.mockImplementation(async(path:string,options?:{method?:string})=>options?.method==='POST'?{jobId:9,itemId:99,status:'queued'}:{jobId:9,itemId:99,status:'failed',bundle:{...bundle(),status:'collecting'}});
  await render(<NoticeBundleDialog channelId={1} choices={choices} onClose={vi.fn()} onOpen={vi.fn()}/>);await click(button('공고를 읽고 초안 만들기'));
  expect(mocks.api.mock.calls.filter(([,opts])=>opts?.method==='POST')).toHaveLength(1);
  await click(button('새 요청으로 다시 만들기'));const posts=mocks.api.mock.calls.filter(([,opts])=>opts?.method==='POST');expect(posts).toHaveLength(2);expect(posts[0][1].body.requestId).not.toBe(posts[1][1].body.requestId);
 });
 it('기관별 조건과 두 마감을 분리하고 실제 제공된 PDF 쪽수만 근거로 표시한다',async()=>{
  const data=bundle(),before=structuredClone(data);await render(<NoticeBundleComparison bundle={data}/>);
  const institutions=host.querySelectorAll('article');expect(institutions).toHaveLength(2);expect(institutions[0].textContent).toContain('서울 재학생');expect(institutions[0].textContent).toContain('학생 접수 · 마감 2026-11-20');expect(institutions[0].textContent).toContain('교사 추천 · 마감 2026-11-22');expect(institutions[1].textContent).not.toContain('서울 재학생');expect(institutions[1].textContent).toContain('미확인');
  expect(host.querySelector('.notice-bundle-page')).toBeNull();const details=host.querySelector<HTMLDetailsElement>('.notice-bundle-source-pages')!;
  await act(async()=>{details.open=true;details.dispatchEvent(new Event('toggle',{bubbles:true}));});await settle();
  expect(host.querySelector('.notice-bundle-page strong')?.textContent).toBe('3쪽');expect(host.querySelectorAll('.notice-bundle-page')).toHaveLength(1);expect(data).toEqual(before);
 });
 it('저장된 묶음은 브라우저 요청 기록 없이 jobId로 재접속하고 최종 자료를 다시 불러온다',async()=>{
  let done=false;const initial:NoticeBundle={...bundle(),status:'collecting',jobId:7,rows:bundle().rows.map(row=>({...row,fetchStatus:'pending',attachments:undefined,extracted:null}))};
  mocks.api.mockImplementation(async(path:string)=>{expect(path).toBe('/channels/1/notice-bundles/7');return done?{jobId:7,itemId:77,status:'succeeded',bundle:{...bundle(),rows:bundle().rows.map(({text,attachments,...row})=>row)}}:{jobId:7,itemId:77,status:'running',bundle:initial};});
  const invalidation=vi.spyOn(client,'invalidateQueries');
  await render(<NoticeBundlePanel bundle={initial} channelId={1}/>);expect(host.textContent).toContain('원문과 첨부를 읽고');expect(sessionStorage.length).toBe(0);
  done=true;await act(async()=>{await client.invalidateQueries({queryKey:['ch',1,'notice-bundle',7]});});await settle();
  expect(invalidation).toHaveBeenCalledWith({queryKey:['ch',1,'item']});expect(invalidation).toHaveBeenCalledWith({queryKey:['studio']});
  await render(<NoticeBundlePanel bundle={{...bundle(),jobId:7}} channelId={1}/>);
  expect(host.textContent).toContain('A 모집요강.pdf');expect(host.textContent).toContain('스캔 PDF');expect(mocks.api.mock.calls.every(([,options])=>!options?.method||options.method==='GET')).toBe(true);
 });
 it('재접속한 실패 작업에서 서버가 보관한 중단 사유를 표시한다',async()=>{
  mocks.api.mockResolvedValue({jobId:7,itemId:77,status:'failed',bundle:{...bundle(),status:'collecting'},error:'공고 묶음이 편집돼 자동으로 덮어쓰지 않았습니다.'});
  await render(<NoticeBundlePanel bundle={{...bundle(),status:'collecting',jobId:7}} channelId={1}/>);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('편집돼 자동으로 덮어쓰지');expect(host.textContent).toContain('작업을 완료하지 못했습니다.');
 });
 it('GPT용 복사에 기관별 자료와 실제 PDF 전체·말투 기준·읽기 실패를 빠짐없이 담는다',async()=>{
  const data=bundle(),tail='본문 마지막의 교사 추천 조건은 반드시 따로 확인합니다.';
  data.rows[0].attachments![0].pages![0].text='원문 본문 '.repeat(40000)+tail;
  const writeText=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
  await render(<NoticeBundleComparison bundle={{...data,status:'collecting'}}/>);expect(button('비교 자료 전체·원고 요청 복사').disabled).toBe(true);
  await render(<NoticeBundleComparison bundle={data}/>);await click(button('비교 자료 전체·원고 요청 복사'));
  expect(writeText).toHaveBeenCalledTimes(1);const copied=writeText.mock.calls[0][0] as string;
  for(const expected of ['HighScoop','제목 3안','장별 제목과 본문','게시용 캡션','지역과 추천 마감을 구분','서울 A 영재학급','부산 B 영재학급','서울 재학생','https://example.org/a','A 모집요강.pdf 3쪽',tail,'스캔 PDF의 텍스트를 읽지 못했습니다.','읽기 실패 자료를 현재 근거로 사용하지 않는다.'])expect(copied).toContain(expected);
  expect(copied.length).toBeGreaterThan(200000);expect(host.textContent).toContain('GPT 대화창에 붙여넣어');
  writeText.mockRejectedValueOnce(new Error('clipboard denied'));await click(button('비교 자료 전체·원고 요청 복사'));expect(host.textContent).toContain('복사하지 못했습니다.');
 });
});
