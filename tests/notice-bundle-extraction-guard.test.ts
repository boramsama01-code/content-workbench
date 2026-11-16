import {beforeEach,describe,expect,it,vi} from 'vitest';
import {getTableName} from 'drizzle-orm';
import type {DB} from '../server/db';
import type {LlmBudget} from '../server/services/llm';
const mock=vi.hoisted(()=>({source:vi.fn(async(..._args:unknown[])=>null),extract:vi.fn()}));
vi.mock('../server/services/itemSources',async original=>({...await original<object>(),itemPrimarySource:(...args:unknown[])=>mock.source(...args)}));
vi.mock('../server/services/llm',async original=>({...await original<object>(),extractNotice:(...args:unknown[])=>mock.extract(...args)}));
import {extractForItem} from '../server/worker/collect';
beforeEach(()=>vi.clearAllMocks());
function database(location:'revision'|'edited'|'extracted'|'none'){
  const item={id:1,channelId:1,currentRevisionId:location==='revision'?2:null,edited:location==='edited'?{noticeBundle:{version:1}}:null,extracted:location==='extracted'?{noticeBundle:{version:1}}:null};
  const db={select:()=>({from:(table:unknown)=>({where:async()=>getTableName(table as Parameters<typeof getTableName>[0])==='content_items'?[item]:[{payload:{noticeBundle:{version:1}}}]})})};
  return db as unknown as DB;
}
describe('기관별 비교 원고의 단일 모집요강 추출 방지',()=>{
 it.each(['revision','edited','extracted'] as const)('%s의 묶음 표시가 있으면 원문 조회·AI·저장을 시작하지 않는다',async location=>{
  const result=await extractForItem(database(location),1,{} as LlmBudget,new Date());
  expect(result).toMatchObject({ok:false,kind:'parse',error:expect.stringContaining('기관별 비교 자료')});
  expect(mock.source).not.toHaveBeenCalled();expect(mock.extract).not.toHaveBeenCalled();
 });
 it('일반 모집요강은 기존 원문 확보 절차를 유지한다',async()=>{
  const result=await extractForItem(database('none'),1,{} as LlmBudget,new Date());
  expect(result).toMatchObject({ok:false,kind:'no_source'});expect(mock.source).toHaveBeenCalledOnce();
 });
});
