// Real built app with isolated news fixtures. No production, provider or publishing requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {preview} from 'vite';
import {openChannelMenu,closeChannelMenu} from './channel-picker.mjs';
const require=createRequire(import.meta.url);
let playwright;try{playwright=require('playwright');}catch{playwright=require(require.resolve('playwright',{paths:[process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES??'/nonexistent']}));}
const output='test-results/highscoop-news';await mkdir(output,{recursive:true});
const stamp=new Date().toISOString(),discovery={enabled:true,queries:['과학 기술 사회'],picksPerRun:3,autoDraft:false};
const channel={id:1,slug:'opportunities',name:'HighScoop',active:true,version:8,contentType:'notice',cardTemplate:'highscoop:gifted',accentColor:'#e84b42',categories:['중등입시','고등입시','전국대회','캠프·체험 선발모집','뉴스'],budget:{discovery},legacyChannelIds:[2,3],legacyStudioKeys:['news','science-dialogue','current-dialogue']};
const channels=[channel,{id:106,slug:'penguin',name:'우주펭귄상회',active:true,version:1,contentType:'manual',accentColor:'#32756b',categories:['웹툰'],budget:{}}];
const ai={defaultProvider:'openai',text:{openai:false,gemini:false,anthropic:false},image:false};
const item={id:9828,channelId:1,kind:'current_dialogue',origin:'discovered',title:'검증용 뉴스 · AI와 환경 정책을 아이와 이야기한다면',subcategory:'뉴스',reviewStatus:'pending',publishStatus:'waiting',evidenceStatus:'needs_review',scheduleStatus:'not_applicable',version:1,excluded:false,isSample:false,createdAt:stamp,updatedAt:stamp};
const row={item,source:{id:1,kind:'rss_direct',url:'https://example.com/isolated-test',publisher:'검증용 자료',publishedAt:stamp,publishedPrecision:'minute',fetchStatus:'ok',snippet:'실제 보도가 아닌 UI 검증용 자료입니다.'},channelSlug:'opportunities',channelName:'HighScoop'};
const server=await preview({preview:{host:'127.0.0.1',port:4193,strictPort:true}}),origin='http://127.0.0.1:4193';
const browser=await playwright.webkit.launch({headless:true}),results=[];
try{for(const width of [1280,390,320]){
  const context=await browser.newContext({viewport:{width,height:1000},locale:'ko-KR',timezoneId:'Asia/Seoul'}),page=await context.newPage(),reads=[],writes=[],errors=[];
  await page.addInitScript(()=>{localStorage.setItem('spacepenguin.channel','3');});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url()),method=route.request().method(),path=url.pathname;
    if(url.origin!==origin)return route.abort('blockedbyclient');
    if(!path.startsWith('/api/'))return route.continue();
    if(method!=='GET'){writes.push({path,body:route.request().postDataJSON()});assert.equal(path,'/api/collection/collect');return route.fulfill({json:{inline:false,requested:[{channelId:1,jobId:19}]}});}
    let data;
    if(path==='/api/auth/me')data={user:'isolated-test',csrf:'fixture',demo:false,recoveryScope:'highscoop-news-test',authConfigured:true};
    else if(path==='/api/channels')data=channels;
    else if(path==='/api/status')data={globalStop:false,workerConnected:true,integrations:{gemini:false,openai:false,anthropic:false,flags:{dryRun:true,autoPublish:false}}};
    else if(path==='/api/items'){reads.push(new URLSearchParams(url.search));data={total:1,page:1,pageSize:20,items:[row]};}
    else if(path==='/api/collection/overview')data={date:stamp.slice(0,10),autoCollect:false,globalStop:false,naverReady:true,searchReady:true,sourceMode:'public_rss',lastScheduledAt:null,nextScheduledAt:null,channels:[{...channel,queries:1,discoveryQueries:1,boards:0,budget:10,profile:null,newItems:1,pending:1,fetched:1,jobs:[],lastRun:null,categories:[{label:'뉴스',newItems:1}]}]};
    else if(path==='/api/channels/1/rules')data={items:[],discovery,estimate:{activeRules:0,discoveryCalls:1,callsPerRun:1,budget:1}};
    else if(path==='/api/channels/1/today')data={counts:{pendingReview:1,needsEvidence:0,draftsReady:0},discovered:[],pendingJobs:[],discovery};
    else if(path==='/api/studio/cards')data={cards:[],ai,notes:'',notesVersion:1,trashCount:0};
    else if(path==='/api/studio/ai-status')data=ai;
    else if(path.startsWith('/api/canva/'))data={connected:false,configured:false};
    else {errors.push('Unexpected API '+path);return route.fulfill({status:404,json:{error:'Isolated route not defined'}});}
    return route.fulfill({json:data});
  });
  try{
    await page.goto(origin+'/inbox');
    await page.getByRole('button',{name:'뉴스·이슈 브리핑',exact:true}).waitFor();
    await openChannelMenu(page);
    const picker=page.getByRole('combobox',{name:'보기 채널',exact:true});
    assert.equal(await picker.inputValue(),'1','stored Alligodang selection must resolve to HighScoop');
    assert(!/Alligodang|알리고당/i.test(await picker.innerText()));
    await closeChannelMenu(page);
    await page.getByRole('button',{name:'뉴스·이슈 브리핑',exact:true}).click();
    await page.getByRole('heading',{name:'최신 뉴스·이슈 브리핑',exact:true}).waitFor();
    await page.getByRole('button',{name:'최신 뉴스 모으기',exact:true}).waitFor();
    await page.waitForFunction(()=>new URL(location.href).searchParams.get('subcategory')==='뉴스');
    assert(reads.some(query=>query.get('channelId')==='1'&&query.get('subcategory')==='뉴스'&&!query.get('noticeIntent')&&!query.get('schedule')),'news must not inherit recruitment filters');
    await page.screenshot({path:`${output}/news-${width}.png`});
    await page.getByRole('button',{name:'최신 뉴스 모으기',exact:true}).click();
    await page.waitForTimeout(150);
    assert.deepEqual(writes,[{path:'/api/collection/collect',body:{channelId:1,subcategory:'뉴스'}}]);
    assert.equal(await page.evaluate(()=>localStorage.getItem('spacepenguin.channel')),'1');
    const size=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert(size.scroll<=size.width+1);
    assert.deepEqual(errors,[]);
    results.push({width,passed:true,storedChannelRedirect:true,removedLegacyTab:true,newsOnlyFilters:true,newsOnlyCollection:true,paidCalls:0});
  }finally{await context.close();}
}}finally{await browser.close();await server.httpServer.close();await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));}
console.log(JSON.stringify({passed:results.length===3&&results.every(row=>row.passed),results}));
