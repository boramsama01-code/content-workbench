import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {generateCardCopy,LlmBudget} from '../server/services/llm';
import {type NoticeBundle} from '../shared/noticeBundle';
beforeEach(()=>{vi.stubEnv('OPENAI_API_KEY','test-only-key');vi.stubEnv('AI_PROVIDER','openai');});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
it('기관별 묶음 원고는 4장 140자로 강제하지 않고 기존 장수와 긴 조건을 유지한다',async()=>{
 const copy={version:1,templateKey:'highscoop:gifted',cover:{title:'기관별 영재학급 비교',subtitle:''},pages:Array.from({length:6},(_,i)=>({id:`notice-${i+1}-1`,title:`공고 ${i+1}`,subtitle:'',body:'필수 지원 조건을 확인해 주세요. '.repeat(12)}))};
 const bundle:NoticeBundle={version:1,status:'ready',sourceItemIds:[10,20],instruction:'학년과 마감 구분',createdAt:'2026-11-16T00:00:00Z',rows:[]};
 const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'completed',model:'test',output:[{type:'function_call',name:'submit_card_copy',arguments:JSON.stringify(copy)}],usage:{input_tokens:10,output_tokens:20}})));vi.stubGlobal('fetch',fetcher);
 const result=await generateCardCopy({kind:'notice',title:copy.cover.title,payload:{cardCopy:copy,noticeBundle:bundle},templateKey:copy.templateKey,channelSlug:'highscoop',budget:new LlmBudget(1),provider:'openai'});
 expect(result.ok).toBe(true);if(result.ok)expect(result.data.pages).toHaveLength(6);
 const sent=JSON.parse(fetcher.mock.calls[0][1].body);
 expect(sent.instructions).toContain('학생 마감과 추천/학교 마감');expect(sent.instructions).toContain('본문 6장');
 expect(sent.tools[0].parameters.properties.pages.minItems).toBe(6);expect(sent.tools[0].parameters.properties.pages.items.properties.body.maxLength).toBe(1000);
 expect(fetcher).toHaveBeenCalledOnce();
});
