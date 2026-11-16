import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { manualBoardWorkload, manualCollectionBudget } from '../server/services/manualCollectionBudget';
import type { ChannelBudget } from '../shared/schema';

const state = vi.hoisted(() => ({ snapshot: null as any, report: null as any, nextItem: 100, persisted:[] as any[], extraFetch:vi.fn(async(..._args:unknown[])=>{throw new Error('Unexpected attachment request');}) }));
vi.mock('../server/seed', () => ({ getSetting: async () => false }));
vi.mock('../server/worker/discovery', () => ({ runDiscovery: async () => null, upsertNaverDoc: async () => ({ id: 1 }) }));
vi.mock('../server/services/sourceFetchPersistence', () => ({ persistSourceFetchAttempt: async (...args:any[]) => {state.persisted.push(args[2]);return { hasUsableBody: true };} }));
vi.mock('../server/services/safeFetch',async original=>({...await original<object>(),safeFetch:(...args:unknown[])=>state.extraFetch(...args)}));
vi.mock('../server/services/telegram', () => ({ sendReviewMessage: () => { throw new Error('Manual collection must not notify'); } }));
const zero: ChannelBudget = { naverCallsPerRun: 0, resultsPerRun: 0, fetchTargetsPerRun: 0, fetchCallsPerRun: 0, llmCallsPerRun: 0, dailyPublishLimit: 0, discovery: { enabled: false, autoDraft: false } };
beforeEach(() => {
  state.snapshot = state.report = null; state.nextItem = 100;state.persisted=[];state.extraFetch.mockClear();
  vi.stubEnv('NAVER_CLIENT_ID', 'unit-not-a-real-key'); vi.stubEnv('NAVER_CLIENT_SECRET', 'unit-not-a-real-key');
  vi.stubEnv('AUTO_GENERATE', 'true');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External calls forbidden'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('finite explicit manual collection plan', () => {
  it('replaces all four legacy zeros from selected work without mutating stored AI/publishing policy', () => {
    const plan = manualCollectionBudget(zero, [{ display: 3 }], [{ linkSelector: 'a', maxItems: 2 }], null);
    expect(plan.budget).toMatchObject({ naverCallsPerRun: 7, resultsPerRun: 5, fetchTargetsPerRun: 5, fetchCallsPerRun: 31, llmCallsPerRun: 0, dailyPublishLimit: 0 });
    expect(zero.resultsPerRun).toBe(0);
    expect(plan.boardCalls).toBe(1);
  });
  it('bounds GED pages/provider displays and discovery selections by actual search work', () => {
    const plan = manualCollectionBudget(zero, [{ display: 1000 }], [{ linkSelector: 'a', format: 'ged_selection' }], { enabled: true, queries: ['one'], picksPerRun: 1000, autoDraft: true });
    expect(manualBoardWorkload({ linkSelector: 'a', format: 'ged_selection' })).toEqual({ pages: 10, results: 1000 });
    expect(plan.discoveryPicks).toBe(100);
    expect(plan.budget.resultsPerRun).toBe(1200);
    expect(plan.budget.naverCallsPerRun).toBe(14);
    expect(Object.values(plan.budget).filter(x => typeof x === 'number').every(Number.isSafeInteger)).toBe(true);
  });
  it('does not invent work for an empty/disabled selection and rejects non-finite input', () => {
    expect(manualCollectionBudget(zero, [], [], null).budget).toMatchObject({ naverCallsPerRun: 0, resultsPerRun: 0, fetchTargetsPerRun: 0, fetchCallsPerRun: 0 });
    expect(() => manualCollectionBudget(zero, [{ display: NaN }], [], null)).toThrow('유한');
  });
});

function database(officials: any[] = []) {
  const channel = { id: 2, slug: 'science-dialogue', contentType: 'science_dialogue', active: true, budget: zero };
  const rules = ['selected-one', 'selected-two'].map((query, index) => ({ id: index + 1, query, endpoint: 'news', display: 1, excludeTerms: [], excludeScope: 'title' }));
  function builder(action: string, table?: any) {
    let name = table ? getTableName(table) : '';
    const q: any = { from(t: any) { name = getTableName(t); return q; }, where() { return q; }, for() { return q; }, orderBy() { return q; }, innerJoin() { return q; },
      values(v: any) { if (name === 'runs') state.snapshot = v.snapshot; return q; }, onConflictDoNothing() { return q; },
      set(v: any) { if (name === 'runs') state.report = v; return q; },
      returning() { return Promise.resolve([{ id: name === 'content_items' ? ++state.nextItem : 1 }]); },
      then(resolve: any, reject: any) { return Promise.resolve(action !== 'select' ? [] : name === 'channels' ? [channel] : name === 'search_rules' ? rules : name === 'official_sources' ? officials : name === 'content_items' ? [{ id: 101, primarySourceId: 1 }] : name === 'source_documents' ? [{ id: 1, normalizedUrl: 'https://source.example/article', originalUrl: 'https://source.example/article', fetchStatus: 'not_fetched', meta: {} }] : []).then(resolve, reject); },
    }; return q;
  }
  const db: any = { select: () => builder('select'), insert: (t: any) => builder('insert', t), update: (t: any) => builder('update', t), transaction: (work: (tx: any) => unknown) => work(db) };
  return db;
}
it('actually searches and fetches both selected rules from zero budgets, serially, without an AI or notification path', async () => {
  const { runCollect } = await import('../server/worker/collect');
  const searched: string[] = []; let active = 0, maxActive = 0;
  const search = vi.fn(async (url: any) => { searched.push(new URL(String(url)).searchParams.get('query')!); return new Response(JSON.stringify({ items: [{ title: 'Synthetic article', link: 'https://source.example/article', description: 'fixture' }] }), { status: 200 }); }) as typeof fetch;
  const fetchSource = vi.fn(async (url: string) => { active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); active--; return { ok: true as const, finalUrl: url, title: 'fixture', text: 'fixture article', hash: 'fixture', attachments: [], contentKind: 'html' as const }; });
  const result = await runCollect(database(), 2, { trigger: 'worker', manualWorkload: true, collectionOnly: true, naverFetch: search, fetchSource });
  expect(searched).toEqual(['selected-one', 'selected-two']); expect(fetchSource).toHaveBeenCalledTimes(2); expect(maxActive).toBe(1);
  expect(result.counts).toMatchObject({ rulesProcessed: 2, results: 2, fetchedOk: 2, rulesSkippedByBudget: 0 });
  expect(state.report.actualCalls.llm).toBe(0); expect(state.snapshot.ai).toBeNull(); expect(state.snapshot.manualWorkload).toBe(true);
});
it('reserves the existing finite GED page contract and still fetches selected articles when all four legacy limits are zero', async () => {
  const { runCollect } = await import('../server/worker/collect');
  const official = { id: 50, name: 'synthetic GED', enabled: true, adapter: 'generic_board', verifiedAt: new Date(), domain: 'source.example', boardUrl: 'https://source.example/board', adapterConfig: { linkSelector: 'a', format: 'ged_selection', maxItems: 20 } };
  const fetchBoard = vi.fn(async (_url: string, _domain: string, _config: any, _fetch: any, options: any) => {
    for (let page = 2; page <= 10; page++) expect(options.takeExtraCall()).toBe(true);
    expect(options.takeExtraCall()).toBe(false);
    return { ok: true as const, entries: [{ title: 'synthetic source', url: 'https://source.example/one', dateText: null }] };
  });
  const search = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as typeof fetch;
  const fetchSource = vi.fn(async (url: string) => ({ ok: true as const, finalUrl: url, title: 'fixture', text: 'fixture article', hash: 'fixture', attachments: [], contentKind: 'html' as const }));
  const result = await runCollect(database([official]), 2, { trigger: 'worker', manualWorkload: true, collectionOnly: true, naverFetch: search, fetchBoard, fetchSource });
  expect(result.counts).toMatchObject({ officialChecked: 1, officialExtraPages: 9, officialNew: 1, fetchedOk: 1, rulesProcessed: 2 });
  expect(fetchBoard).toHaveBeenCalledOnce(); expect(fetchSource).toHaveBeenCalledOnce(); expect(state.report.actualCalls.fetch).toBe(11);
});
it.each([{ trigger: 'schedule', manualWorkload: true }, { trigger: 'worker', manualWorkload: undefined }])('keeps scheduled/default zero budgets instead of silently upgrading them: %j', async options => {
  const { runCollect } = await import('../server/worker/collect'); const naverFetch = vi.fn() as typeof fetch;
  await runCollect(database(), 2, { ...options, trigger: options.trigger as 'schedule' | 'worker', collectionOnly: true, naverFetch });
  expect(naverFetch).not.toHaveBeenCalled(); expect(state.snapshot.manualWorkload).toBe(false); expect(state.snapshot.channel.budget.resultsPerRun).toBe(0);
});

it('does not spend a fourth attachment request after the GED reader reaches its PDF cap',async()=>{
  const {runCollect}=await import('../server/worker/collect');
  const naverFetch=vi.fn(async()=>new Response(JSON.stringify({items:[{title:'Synthetic article',link:'https://source.example/article',description:'fixture'}]}),{status:200})) as typeof fetch;
  const fetchSource=vi.fn(async()=>({ok:true as const,finalUrl:'https://ged.kedi.re.kr/inno/slctNotiInnoPop.do?pop1=Y&stndYear=2027&orgId=10117174001&seq=25584',title:'GED guide',text:'주 모집요강 PDF에서 이미 확보한 본문입니다.',hash:'fixture',contentKind:'pdf' as const,attachments:[
    {url:'https://ged.kedi.re.kr/first.pdf',name:'모집요강.pdf',kind:'pdf',status:'ok',role:'primary' as const},
    {url:'https://ged.kedi.re.kr/fourth.pdf',name:'추가.pdf',kind:'pdf',status:'pending',reason:'PDF 3개 자동 읽기 한도'},
  ]}));
  const result=await runCollect(database(),2,{trigger:'worker',manualWorkload:true,collectionOnly:true,naverFetch,fetchSource});
  expect(result.counts.fetchedOk).toBe(2);expect(state.extraFetch).not.toHaveBeenCalled();
  expect(state.persisted).toHaveLength(2);expect(state.persisted.every(value=>value.attachments[1].status==='pending')).toBe(true);
});
