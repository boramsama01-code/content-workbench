import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {extractNotice,LlmBudget} from '../server/services/llm';
import {emptyPayload} from '../shared/payloads';
beforeEach(()=>vi.stubEnv('OPENAI_API_KEY','fixture-key'));
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('선택한 기관의 PDF 전체를 읽는 조건 추출',()=>{
 it('기존12k요약과구분하여뒤쪽학교추천마감까지모델에전달한다',async()=>{
  const tail='말미의 교사 추천 마감은 11월 23일 오후 6시입니다.',text='본문 안내입니다. '.repeat(1800)+tail;
  const source={source_id:7,kind:'official',url:'https://official.example/notice',title:'초등 영재학급 모집',published:null,text};
  const data={...emptyPayload('notice',source.title),organization:'영재학급',audience:'초등학교 5학년',evidence:[{source_id:7,field:'schedules',quote:tail}]};
  const fetchMock=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({status:'completed',model:'fixture',output:[{type:'function_call',name:'submit_notice',arguments:JSON.stringify(data)}],usage:{input_tokens:1,output_tokens:1}})));
  vi.stubGlobal('fetch',fetchMock);
  const result=await extractNotice({sources:[source],provider:'openai',sourceHint:null,now:new Date(),budget:new LlmBudget(1),completeDocument:true});
  expect(result).toMatchObject({ok:true,data:{evidence:data.evidence}});
  const full=JSON.parse(fetchMock.mock.calls[0][1].body);expect(full.input).toContain(tail);expect(full.instructions).toContain('초등·중등·고등');expect(full.instructions).toContain('교사·학교 추천');
  await extractNotice({sources:[source],provider:'openai',sourceHint:null,now:new Date(),budget:new LlmBudget(1)});
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).input).not.toContain(tail);
 });
 it('전체입력한도를넘으면자료를조용히자르거나유료모델을호출하지않는다',async()=>{
  const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
  const result=await extractNotice({sources:[{source_id:1,kind:'official',url:'https://official.example/long.pdf',title:'긴 PDF',published:null,text:'가'.repeat(80001)}],provider:'openai',sourceHint:null,now:new Date(),budget:new LlmBudget(1),completeDocument:true});
  expect(result).toMatchObject({ok:false,error:expect.stringContaining('80,000')});expect(fetchMock).not.toHaveBeenCalled();
 });
 it('조건정리형식이잘못되어도두번째유료보정호출을자동실행하지않는다',async()=>{
  const fetchMock=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({status:'completed',model:'fixture',output:[{type:'function_call',name:'submit_notice',arguments:'{}'}],usage:{input_tokens:1,output_tokens:1}})));vi.stubGlobal('fetch',fetchMock);
  const result=await extractNotice({sources:[{source_id:1,kind:'official',url:'https://official.example/notice',title:'모집 공고',published:null,text:'지원 대상과 학생 접수 마감을 읽습니다.'}],provider:'openai',sourceHint:null,now:new Date(),budget:new LlmBudget(2),completeDocument:true});
  expect(result).toMatchObject({ok:false,kind:'parse'});expect(fetchMock).toHaveBeenCalledTimes(1);
 });
});
