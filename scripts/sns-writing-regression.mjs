// Real production React screens with synthetic API fixtures. External requests
// and all production writes are blocked; no paid generation is performed.
import assert from "node:assert/strict";
import { aiCapacityFixture } from "./ai-capacity-fixture.mjs";
import { createRequire } from "node:module";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { preview } from "vite";

const require = createRequire(import.meta.url);
async function verifyContentFlowPrompt(desk) {
  const manual = desk.locator("details.sns-workbench-manual");
  await manual.locator(":scope > summary").click();
  await manual.getByRole("button", { name: "프롬프트 보기", exact: true }).click();
  const prompt = await manual.locator("textarea[readonly]").inputValue();
  assert(prompt.includes(await desk.getAttribute("data-editorial-version")), "manual handoff uses the displayed prompt revision");
  assert(prompt.includes("카드뉴스·영상의 독자 흐름과 저장·공유 기준"), "the default flow is included without pasting extra instructions");
  assert(prompt.includes("저장할 이유는 나중에 다시 쓸 수 있는 내용으로 만든다"));
  assert(prompt.includes("공유할 이유는 누구에게 어떤 상황에서 보여주면 쓸모 있는지"));
  assert(prompt.includes("최신 사용자 지시와 해당 형식의 계약을 우선한다"));
  await manual.getByRole("button", { name: "프롬프트 보기", exact: true }).click();
  await manual.locator(":scope > summary").click();
}
let pw;
try { pw = require("playwright"); }
catch { pw = require(require.resolve("playwright", { paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ?? "/nonexistent"] })); }
const output = "test-results/sns-writing";
await mkdir(output, { recursive: true });
const poseImage = await readFile("assets/studio-final-v14/restored/PP001.png");
const stamp = "2026-11-16T02:00:00Z";
const channel = { id: 2, slug: "opportunities", name: "HighScoop", active: true, version: 1, accentColor: "#355d82", contentType: "notice", categories: [], description: "중고등학생과 학부모를 위한 발견", audience: "중고등학생과 학부모", editorialGuide: "구체적인 사건을 짧게", budget: {}, creativeProfile: null, aiSettings: null };
const card = { id: 9, title: "하늘에서 로켓을 붙잡는 방법", channel: "highscoop", stage: "writing", format: "카드뉴스", version: 1, subcategory: "", dueDate: "", memo: "비공개 제작 메모는 기본으로 전달하지 않습니다.", script: "발사대의 두 팔이 돌아오는 로켓 부스터를 붙잡았습니다.\n왜 이런 방법을 택했을까요?", caption: "로켓이 착륙하는 대신, 발사대가 로켓을 잡았습니다. 회수 방법이 달라지면 무엇이 바뀔까요?", exportDesign: "editorial", sourceLabel: "브라우저 검증용 합성 자료", panels: Array.from({ length: 4 }, (_, i) => ({ scene: "", dialogue: `${i + 1}번째 저장 문구`, imageId: null, poseRefs: [] })), characters: [], imagePath: "", finishedDeck: null, experience: null, altTexts: [], sourceItemId: null, createdAt: stamp, updatedAt: stamp };
const video = { ...structuredClone(card), id: 20, format: "릴스", videoProject: { version: 1, ratio: "9:16", audioGuide: "현장음", coverMediaId: null, outputMediaId: null, scenes: [{ id: "00000000-0000-4000-8000-000000000001", title: "로켓 회수", duration: 3, subtitle: "최신 장면 자막", narration: "최신 장면의 내레이션", audio: "현장음", mediaId: null }] } };
const ai = { defaultProvider: "openai", text: { openai: true, gemini: true, anthropic: false }, image: false };
const requests = [], codexRequests = [], errors = [], results = [], codexJobs = new Map();
const server = await preview({ preview: { host: "127.0.0.1", port: 4188, strictPort: true } });
const origin = "http://127.0.0.1:4188";
let browser;
try {
  browser = await pw.webkit.launch();
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname;
      if (url.origin !== origin) { errors.push(`External request blocked: ${url.origin}`); return route.abort(); }
      if (!p.startsWith("/api/")) return route.continue();
      const method = req.method(); let data;
      if (p === "/api/auth/me") data = { user: "visual-fixture", csrf: "fixture", demo: false, recoveryScope: `sns-writing-browser-${width}`, authConfigured: true, demoAllowed: false };
      else if (p === "/api/channels") data = [channel];
      else if (p === "/api/status") data = { globalStop: false, workerConnected: true, integrations: { flags: { dryRun: true, autoPublish: false } } };
      else if (p === "/api/studio/cards") data = { cards: [card, video], ai, notes: { notes: "", version: 1 }, trashCount: 0 };
      else if (/^\/api\/studio\/cards\/(9|20)$/.test(p) && method === "GET") data = { card: p.endsWith("/20") ? video : card, revisions: [], jobs: [], images: [] };
      else if (p === "/api/studio/ai-status") data = ai;
      else if (p === "/api/studio/ai-capacity") data = aiCapacityFixture(url, [channel], ai);
      else if (p === "/api/studio/codex-writer/status") data = { configured:true,online:true,lastSeenAt:stamp,model:"gpt-6.1-sol",deviceName:"Browser fixture PC" };
      else if (p.startsWith("/api/studio/editorial-voice/") && method === "GET") data = { schemaVersion:1,profileRevision:0,rules:[],examples:[],updatedAt:null };
      else if (/\/studio\/cards\/\d+\/canva-sync$/.test(p) && method === "GET") data = { binding:null,phase:"idle",cardVersion:1,message:"검증용 디자인 미연결 상태" };
      else if (p === "/api/studio/instagram/oauth/config") data = { configured: false, missing: ["INSTAGRAM_APP_ID"], appId: null, redirectUri: `${origin}/api/studio/instagram/oauth/callback` };
      else if (p.startsWith("/api/studio/characters/")) return route.fulfill({ contentType: "image/png", body: poseImage });
      else if (/\/channels\/\d+\/templates$/.test(p)) data = { current: "editorial", items: [] };
      else if (/\/channels\/\d+\/today$/.test(p)) data = { counts: { pendingReview: 0 } };
      else if (/\/studio\/cards\/\d+\/media$/.test(p)) data = [];
      else if (p === "/api/canva/status") data = { connected: false };
      else if (p === "/api/canva/template-library") data = { connected: false, configured: false, enabled: false, items: [], syncStatus: "disabled" };
      else if (p === "/api/studio/export-check") data = { errors: [], warnings: [], pageCount: 4 };
      else if (/\/studio\/cards\/\d+\/publication$/.test(p)) data = { ready: false, blockers: ["검증용 환경"], destinations: [], deliveries: [], dryRun: true, publicationDraft: { version: 0, options: { destinationIds: [], timing: "now", scheduledAtKst: "" } } };
      else if (p.endsWith("/codex-draft") && method === "POST") {
        const body = req.postDataJSON(); codexRequests.push(body);
        assert(!body.referenceText.includes(card.memo), "Codex also keeps private notes opt-in");
        const result = { hooks:[{angle:"장면",text:"회수 장면에서 시작하는 Codex 제안",reason:"주어진 장면과 문구를 대조합니다."}],sections:[{label:"첫 장면",text:"실제 회수 장면을 먼저 보여 줍니다."}],finalCopy:"최신 장면의 내레이션을 다듬은 Codex 검증용 제안입니다.",checks:["완료 시제를 원문에 대조하세요."],task:body.task,promptVersion:"browser-fixture",writer:"codex",provider:"openai",model:"gpt-6.1-sol",usageStatus:"usage_unknown",qualityReview:{passed:true,issues:[],revisionsApplied:["내레이션과 자막을 함께 대조했습니다."]},promptTrace:{toolName:"codex_writer",inputSha256:"fixture"},jobId:51,cardVersion:1 };
        codexJobs.set(body.requestId,{jobId:51,requestId:body.requestId,cardVersion:1,status:"succeeded",phase:"review",error:null,result});
        data = {jobId:51,requestId:body.requestId,cardVersion:1,status:"queued",phase:null,error:null,result:null};
      }
      else if (/\/codex-draft\/[^/]+$/.test(p) && method === "GET") data = codexJobs.get(p.split("/").at(-1));
      else if (p.endsWith("/editorial-draft") && method === "POST") {
        const body = req.postDataJSON(); requests.push(body);
        assert(!body.referenceText.includes(card.memo), "private notes remain opt-in");
        data = { hooks: ["장면", "실용", "의외의 연결"].map((angle, i) => ({ angle, text: `도입 후보 ${i + 1}`, reason: "확인한 장면과 본문을 바로 연결합니다." })), sections: [{ label: "첫 장면", text: "회수 장면을 먼저 보여준 뒤 이유를 설명합니다." }], finalCopy: "다듬은 첫 문장입니다. 확인한 장면부터 시작합니다.", checks: ["회수 주체와 완료 시제를 원문에 대조하세요."], task: body.task, promptVersion: "browser-fixture", provider: body.provider, model: "fixture-model", usage: { inputTokens: 0, outputTokens: 0 }, promptTrace: { toolName: "write_sns_editorial_draft", inputSha256: "fixture" }, jobId: 1, cardVersion: 1 };
      } else { errors.push(`${method} ${p}`); return route.fulfill({ status: 404, json: { error: "Unmocked fixture API" } }); }
      return route.fulfill({ json: data });
    });
    await page.goto(`${origin}/studio/9`);
    const desk = page.locator("details.sns-writing-workbench");
    await desk.locator(":scope > summary").click();
    await verifyContentFlowPrompt(desk);
    await desk.getByLabel("작성 방식",{exact:true}).selectOption("api");
    await desk.locator('select[id$="-task"]').waitFor({ state: "visible" });
    assert.equal(await desk.locator('select[id$="-task"]').locator("option").count(), 13);
    await desk.getByLabel("확인한 사실·원문·분석 수치", { exact: true }).fill("확인된 로켓 부스터 회수 사례만 사용합니다.");
    await desk.getByLabel("더 다듬고 싶은 점", { exact: true }).fill("군더더기는 줄이고 실제 장면은 살려 주세요.");
    await desk.locator('select[id$="-task"]').selectOption("caption_review");
    assert.equal(await desk.getByLabel("더 다듬고 싶은 점", { exact: true }).inputValue(), "군더더기는 줄이고 실제 장면은 살려 주세요.");
    assert.equal(await desk.getByText("로그인 세션이 바뀌어", { exact: false }).count(), 0, "valid fixture sessions retain device recovery");
    await desk.getByRole("button", { name: "스튜디오에서 제안 받기", exact: true }).click();
    await desk.getByRole("region", { name: "글쓰기 제안 결과" }).waitFor();
    assert.equal(await desk.locator(".sns-result-hooks article").count(), 3);
    assert.equal(await desk.getByRole("button", { name: "제목에 반영", exact: true }).count(), 0, "caption openings are not cover-title candidates");
    await desk.getByLabel("더 다듬고 싶은 점", { exact: true }).fill("입력 변경 후 예전 결과를 덮어쓰지 않습니다.");
    assert.equal(await desk.getByRole("button", { name: "캡션에 반영", exact: true }).isDisabled(), true);
    const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert(layout.scroll <= layout.width + 1, `desktop/mobile overflow: ${JSON.stringify(layout)}`);
    await desk.screenshot({ path: `${output}/writing-${width}.png` });
    // A fresh page avoids intentionally triggering the edited-form leave guard.
    const reelPage = await context.newPage();
    reelPage.on("pageerror", error => errors.push(error.message));
    await reelPage.goto(`${origin}/studio/20`);
    const reelDesk = reelPage.locator("details.sns-writing-workbench");
    await reelDesk.locator(":scope > summary").click();
    await verifyContentFlowPrompt(reelDesk);
    await reelDesk.getByLabel("작성 방식",{exact:true}).selectOption("api");
    assert.equal(await reelDesk.locator('select[id$="-task"]').inputValue(), "reel_script");
    await reelDesk.getByRole("button", { name: "스튜디오에서 제안 받기", exact: true }).click();
    await reelDesk.getByRole("region", { name: "글쓰기 제안 결과" }).waitFor();
    assert(requests.at(-1).existingText.includes("최신 장면의 내레이션"));
    await reelDesk.screenshot({ path: `${output}/reel-${width}.png` });
    const codexPage = await context.newPage();
    codexPage.on("pageerror",error => errors.push(error.message));
    await codexPage.goto(`${origin}/studio/20`);
    const codexDesk = codexPage.locator("details.sns-writing-workbench");
    await codexDesk.locator(":scope > summary").click();
    await codexDesk.getByLabel("작성 방식",{exact:true}).selectOption("codex");
    await codexDesk.getByRole("button",{name:"스튜디오에서 제안 받기",exact:true}).click();
    const codexResult = codexDesk.getByRole("region",{name:"글쓰기 제안 결과"});
    await codexResult.waitFor();
    assert((await codexResult.innerText()).includes("Codex · 이 PC · gpt-6.1-sol"));
    assert((await codexResult.innerText()).includes("Codex 자체 검토 기록"));
    assert(codexRequests.at(-1).existingText.includes("최신 장면의 내레이션"));
    assert.equal(codexRequests.at(-1).provider,undefined,"Codex is not an API-provider selection");
    await codexDesk.screenshot({path:`${output}/codex-${width}.png`});
    results.push({ width, tasks: 13, sharedDefaultFlowPrompt: true, generatedHooks: 3, staleApplyBlocked: true, latestVideoNarration: true, codexQueueReviewed:true, externalCalls: 0 });
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}/results.json`, JSON.stringify({ results, requests: requests.length, codexRequests:codexRequests.length, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, results }));
} finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
