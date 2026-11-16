// Actual built React screens with isolated HTTP fixtures. Never calls paid AI,
// production APIs, Canva or a publishing destination. Run after npm run build:
// node --import tsx scripts/ai-capacity-regression.mjs
import assert from "node:assert/strict";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { preview } from "vite";
import sharp from "sharp";
import { cardCopyFixture } from "../tests/fixtures/cardCopy.ts";
import { editorialSource, editorialSummary } from "../tests/fixtures/newsEditorial.ts";
import { browserLayout } from "./browser-layout.mjs";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(require.resolve("playwright", { paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ?? "/nonexistent"] })); }
const output = "test-results/ai-capacity-browser";
await mkdir(output, { recursive: true });
await writeFile(`${output}/results.json`, JSON.stringify({ passed: false, results: [] }, null, 2));
const widths = [1440, 390, 320];
const stamp = "2026-11-16T07:00:00.000Z", itemPath = "/api/channels/3/items/9828", copyPath = `${itemPath}/card-copy`;
const roles = { summary: { provider: "gemini", model: "gemini-capacity-saved-analysis" }, copy: { provider: "openai", model: "gpt-capacity-copy" }, image: { provider: "openai", model: "gpt-image-capacity-example-model" } };
const channel = { id: 3, slug: "current-dialogue", name: "알리고당", active: true, version: 1, accentColor: "#32756b", contentType: "current_dialogue", description: "아이와 나누는 뉴스", audience: "부모와 자녀", editorialGuide: "", categories: [], budget: {}, aiSettings: roles, effectiveAiSettings: roles, aiDefaultModels: { gemini: "gemini-capacity-default", openai: "gpt-capacity-default", anthropic: "claude-capacity-default", image: roles.image.model }, aiAvailability: { gemini: true, openai: true, anthropic: false } };
const ai = { defaultProvider: "openai", text: { openai: true, gemini: true, anthropic: false }, image: true };
const copy = cardCopyFixture(), source = editorialSource();
const payload = { ...editorialSummary("current_dialogue", 1), cardCopy: copy };
const current = { id: 30, revisionNo: 1, author: "operator", model: null, promptVersion: null, note: "브라우저 검증용 합성 자료", payload, createdAt: stamp, usage: null };
const item = { id: 9828, channelId: 3, primarySourceId: 1, title: "AI 사용량 표시 검증용 원고", kind: "current_dialogue", origin: "collected", version: 3, currentRevisionId: 30, reviewStatus: "pending", evidenceStatus: "needs_review", relevance: "relevant", publishStatus: "waiting", excluded: false, edited: payload, canvaDesign: null, createdAt: stamp, updatedAt: stamp, subcategory: null };
const detail = { item, current, primary: { id: 1, title: source.title, originalUrl: "https://source.example/isolated", normalizedUrl: "https://source.example/isolated", kind: "rss_direct", publisher: "합성 자료", fetchStatus: "ok", fetchedText: source.text, snippet: "브라우저 검증용 합성 기사", publishedAt: stamp, publishedPrecision: "day", lastFetchedAt: stamp, attachments: [], meta: {} }, linked: [], revisions: [current], cards: [], approvals: [], deliveries: [], similar: [], imageAiAvailable: true, canonicalStudioCardId: null, publicationDraft: { version: 1, captions: { instagram: "검증용 캡션", telegram: "" }, options: { destinationIds: [], timing: "now", scheduledAtKst: "" } }, defaultCaptions: { instagram: "검증용 캡션", telegram: "" }, publicationReadiness: { ready: false, blockers: ["검증용 환경"], dryRun: true, autoPublish: false, dailyLimit: 0, expectedUsername: null, destinations: [] } };
const studioCard = { id: 8, version: 1, title: "그림 요청 장수 검증", channel: "news", format: "카드뉴스", stage: "making", finishedDeck: null, experience: null, altTexts: [], subcategory: "", dueDate: "", memo: "", script: "확인한 장면을 보여 주세요.", caption: "검증용 캡션", exportDesign: "editorial", sourceLabel: "브라우저 검증용 합성 자료", panels: Array.from({ length: 4 }, (_, i) => ({ scene: `확인한 장면 ${i + 1}`, dialogue: `저장 문구 ${i + 1}`, imageId: i === 0 ? 91 : null, poseRefs: [] })), characters: [], imagePath: "", sourceItemId: null, createdAt: stamp, updatedAt: stamp };
const previewImage = await sharp({ create: { width: 108, height: 135, channels: 3, background: "#c9ddd7" } }).png().toBuffer();
const server = await preview({ preview: { host: "127.0.0.1", port: 4191, strictPort: true } }), origin = "http://127.0.0.1:4191";
const results = [];
let browser;

const fact = (panel, label) => panel.locator("dt").filter({ hasText: new RegExp(`^${label}$`) }).locator("..").locator("dd");
async function noOverflow(page, stage) {
  const layout = await browserLayout(page);
  assert(layout.scroll <= layout.width + 1, `${stage}: ${JSON.stringify(layout)}`);
}
async function screenshotPanel(page, panel, pathname) {
  // Keep the tested responsive width, with enough height for the entire panel.
  // This prevents the app's fixed mobile navigation covering a stitched capture.
  const viewport = page.viewportSize(), bounds = await panel.boundingBox();
  await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, Math.ceil(bounds.height) + 240) });
  await panel.evaluate(node => node.scrollIntoView({ block: "start" }));
  await page.evaluate(() => window.scrollBy(0, -140));
  await panel.screenshot({ path: pathname });
  await page.setViewportSize(viewport);
}
async function assertUnknown(panel) {
  assert.match(await fact(panel, "실제 잔여 토큰·장수").innerText(), /공급자 계정에서 확인 필요/);
  assert.doesNotMatch(await fact(panel, "실제 잔여 토큰·장수").innerText(), /0|무제한|제한 없음/);
}
async function openCalculator(panel) {
  const summary = panel.getByText("예산으로 예상 장수 계산", { exact: true });
  await summary.click();
  return { budget: panel.getByLabel("사용할 예산 (USD)", { exact: true }), unit: panel.getByLabel("예상 이미지 1장 비용 (USD)", { exact: true }), output: panel.locator("output") };
}

try {
  browser = await playwright.webkit.launch();
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ko-KR", timezoneId: "Asia/Seoul", serviceWorkers: "block" });
    await context.addInitScript(() => localStorage.setItem("spacepenguin.channel", "3"));
    const state = { errors: [], blocked: [], writes: [], capacityRequests: [], imageModel: roles.image.model, failCapacity: false, sourceIncomplete: false, allImagesMissing: false };
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url()), pathname = url.pathname, method = request.method();
      if (url.origin !== origin) { state.blocked.push(url.href); return route.abort(); }
      if (!pathname.startsWith("/api/")) return route.continue();
      if (method !== "GET") state.writes.push({ method, path: pathname });
      let data;
      if (pathname === "/api/auth/me") data = { user: "capacity-fixture", csrf: "fixture-csrf", demo: false, recoveryScope: `ai-capacity-${width}`, authConfigured: true, demoAllowed: false };
      else if (pathname === "/api/channels") data = [channel];
      else if (pathname === "/api/channels/3/today") data = { counts: { pendingReview: 1, draftsReady: 1 } };
      else if (pathname === "/api/status") data = { globalStop: false, workerConnected: true, integrations: { gemini: true, openai: true, anthropic: false, flags: { dryRun: true, autoPublish: false } } };
      else if (pathname === "/api/studio/ai-status") data = ai;
      else if (pathname === "/api/studio/ai-capacity") {
        state.capacityRequests.push(url.search);
        assert.equal(url.searchParams.get("channelId"), "3");
        if (state.failCapacity) return route.fulfill({ status: 503, json: { error: "합성 상태 조회 실패" } });
        const provider = url.searchParams.get("analysisProvider") ?? "gemini";
        data = { channelId: 3, analysis: { provider, model: provider === "gemini" ? roles.summary.model : channel.aiDefaultModels[provider], keyConfigured: true }, image: { provider: "openai", model: state.imageModel, keyConfigured: true }, studioDailyImageLimit: null, providerRemainingTokens: null, providerRemainingImages: null, latestFailure: { provider: "gemini", model: roles.summary.model, kind: "quota", at: stamp } };
      }
      else if (pathname === itemPath && method === "GET") {
        data = structuredClone(detail);
        if (state.sourceIncomplete) { delete data.current.payload.cardCopy; delete data.item.edited.cardCopy; }
      }
      else if (pathname === copyPath && method === "GET") data = { version: 3, revisionId: 30, copy, hasSavedCopy: !state.sourceIncomplete, ai: roles };
      else if (pathname === `${copyPath}/preview` && method === "POST") return route.fulfill({ contentType: "image/png", body: previewImage });
      else if (pathname === "/api/channels/3/templates") data = { current: "builtin:classic", items: [] };
      else if (pathname === "/api/channels/3/canva/masters") data = { items: [] };
      else if (pathname === `${itemPath}/canva/jobs`) data = { items: [] };
      else if (pathname === "/api/canva/status") data = { connected: false };
      else if (pathname === "/api/canva/editorial/status") data = { configured: false, connected: false, autofill: false, capabilities: [] };
      else if (pathname === "/api/canva/template-library") data = { connected: false, configured: false, enabled: false, items: [], syncStatus: "disabled" };
      else if (pathname === "/api/studio/cards") data = { cards: [studioCard], ai, notes: "", notesVersion: 1, trashCount: 0 };
      else if (pathname === "/api/studio/cards/8") data = { card: state.allImagesMissing ? { ...studioCard, panels: studioCard.panels.map(panel => ({ ...panel, imageId: null })) } : studioCard, revisions: [], jobs: [], images: [] };
      else if (pathname === "/api/studio/cards/8/canva-sync") data = { binding: null, phase: "idle", cardVersion: 1, message: "합성 미연결 상태" };
      else if (/^\/api\/studio\/characters\//.test(pathname) || pathname === "/api/studio/images/91") return route.fulfill({ contentType: "image/png", body: previewImage });
      else if (pathname === "/api/studio/cards/8/publication") data = { ready: false, blockers: ["검증용 환경"], destinations: [], deliveries: [], dryRun: true, publicationDraft: { version: 0, options: { destinationIds: [], timing: "now", scheduledAtKst: "" } } };
      else if (pathname === "/api/studio/export-check") data = { errors: [], warnings: [], pageCount: 6 };
      else if (pathname === "/api/studio/codex-writer/status") data = { configured: false, online: false, lastSeenAt: null, model: "gpt-6.1-sol", deviceName: null };
      else if (pathname === "/api/studio/instagram/oauth/config") data = { configured: false, missing: ["INSTAGRAM_APP_ID"], appId: null, redirectUri: `${origin}/api/studio/instagram/oauth/callback` };
      else if (pathname.startsWith("/api/studio/editorial-voice/")) data = { schemaVersion: 1, profileRevision: 0, rules: [], examples: [], updatedAt: null };
      else { state.errors.push(`Unmocked ${method} ${pathname}`); return route.fulfill({ status: 404, json: { error: "Unmocked isolated API" } }); }
      return route.fulfill({ json: data });
    });
    const page = await context.newPage(); page.on("pageerror", error => state.errors.push(error.message));
    try {
      await page.goto(`${origin}/items/3/9828?tab=edit`);
      const sourcePanel = page.locator("#edit-panel").getByTestId("ai-capacity-panel");
      await sourcePanel.waitFor();
      await sourcePanel.getByText(new RegExp(roles.summary.model)).first().waitFor();
      assert.match(await fact(sourcePanel, "원문 분석").innerText(), /Gemini/);
      assert.match(await fact(sourcePanel, "이미지 제작").innerText(), /OpenAI/);
      await assertUnknown(sourcePanel);
      await page.getByLabel("기사 요약 AI", { exact: true }).selectOption("openai");
      await sourcePanel.getByText(new RegExp(channel.aiDefaultModels.openai)).first().waitFor();
      assert.match(await fact(sourcePanel, "원문 분석").innerText(), /GPT|OpenAI/);
      assert.match(await fact(sourcePanel, "이미지 제작").innerText(), new RegExp(roles.image.model));
      assert(state.capacityRequests.some(search => search.includes("analysisProvider=openai")), "selected summary provider must reach the status request");
      await noOverflow(page, `source ${width}`);
      await screenshotPanel(page, sourcePanel, `${output}/source-${width}.png`);

      const background = page.locator("details.page-background-editor");
      await background.locator(":scope > summary").click();
      const backgroundPanel = background.getByTestId("ai-capacity-panel");
      await backgroundPanel.waitFor();
      assert.equal(await backgroundPanel.locator("dt").filter({ hasText: /^원문 분석$/ }).count(), 0);
      assert.match(await fact(backgroundPanel, "이번 이미지 요청").innerText(), /^최대 1장/);
      assert.equal(await backgroundPanel.getByText(/최근 Gemini 요청/).count(), 0, "an unrelated Gemini quota must not be shown as an image failure");
      await assertUnknown(backgroundPanel);
      const calculator = await openCalculator(backgroundPanel);
      await calculator.budget.fill("0.30"); await calculator.unit.fill("0.10");
      assert.match(await calculator.output.innerText(), /약 3장 · 이번 1장 예상 \$0\.1(?:\s|$)/);
      for (const invalid of ["0", "-0.1", "0.000000001"]) {
        await calculator.unit.fill(invalid); assert.match(await calculator.output.innerText(), /0보다 큰 금액/);
      }
      await calculator.unit.fill("0.1"); await calculator.budget.fill("-1");
      assert.match(await calculator.output.innerText(), /예산은 0 이상/);
      await calculator.budget.fill("0"); assert.match(await calculator.output.innerText(), /약 0장/);
      await calculator.budget.fill("0.30");
      await noOverflow(page, `background calculator ${width}`);
      await screenshotPanel(page, backgroundPanel, `${output}/background-${width}.png`);

      state.sourceIncomplete = true;
      const partialPage = await context.newPage(); partialPage.on("pageerror", error => state.errors.push(error.message));
      await partialPage.goto(`${origin}/items/3/9828?tab=edit`);
      const partialCapacity = partialPage.locator("#edit-panel").getByTestId("ai-capacity-panel");
      await partialCapacity.waitFor();
      assert.match(await fact(partialCapacity, "이번 이미지 요청").innerText(), /^최대 1장/, "an existing analysis-only revision still needs its first cover");
      await noOverflow(partialPage, `partial draft ${width}`);
      state.sourceIncomplete = false;

      const studioPage = await context.newPage(); studioPage.on("pageerror", error => state.errors.push(error.message));
      await studioPage.goto(`${origin}/studio/8`);
      const composition = studioPage.locator("#studio-composition"), studioPanel = composition.getByTestId("ai-capacity-panel");
      await studioPanel.waitFor();
      assert.match(await fact(studioPanel, "이번 이미지 요청").innerText(), /빈 그림 자동 생성 · 최대 3장/, "one stored image leaves three missing images");
      const studioCalculator = await openCalculator(studioPanel);
      await studioCalculator.budget.fill("0.30"); await studioCalculator.unit.fill("0.10");
      assert.match(await studioCalculator.output.innerText(), /약 3장 · 빈 그림 자동 생성 3장 예상 \$0\.3(?:\s|$)/);
      await studioPage.getByLabel("2컷 다시 생성 선택", { exact: true }).check();
      await studioPage.getByLabel("4컷 다시 생성 선택", { exact: true }).check();
      assert.match(await fact(studioPanel, "이번 이미지 요청").innerText(), /빈 그림 자동 생성 · 최대 3장/);
      assert.match(await fact(studioPanel, "이번 이미지 요청").innerText(), /선택한 그림 다시 생성 · 최대 2장/);
      assert.match(await studioCalculator.output.innerText(), /선택한 그림 다시 생성 2장 예상 \$0\.2(?:\s|$)/);
      await assertUnknown(studioPanel);
      await noOverflow(studioPage, `selected batch ${width}`);
      await screenshotPanel(studioPage, studioPanel, `${output}/studio-${width}.png`);
      state.failCapacity = true;
      await studioPanel.getByRole("button", { name: "상태 새로 확인", exact: true }).click();
      await studioPanel.getByText("AI 설정을 불러오지 못했습니다.", { exact: false }).waitFor();
      assert.equal(await studioCalculator.budget.inputValue(), "0.30"); assert.equal(await studioCalculator.unit.inputValue(), "0.10");
      state.failCapacity = false; state.imageModel = "gpt-image-capacity-changed-model";
      await studioPanel.getByRole("button", { name: "상태 새로 확인", exact: true }).click();
      await studioPanel.getByText(new RegExp(state.imageModel)).first().waitFor();
      assert.equal(await studioCalculator.budget.inputValue(), ""); assert.equal(await studioCalculator.unit.inputValue(), "", "a different model requires confirming its unit price again");

      state.allImagesMissing = true;
      const blankPage = await context.newPage(); blankPage.on("pageerror", error => state.errors.push(error.message));
      await blankPage.goto(`${origin}/studio/8`);
      const blankCapacity = blankPage.locator("#studio-composition").getByTestId("ai-capacity-panel");
      await blankCapacity.waitFor();
      assert.match(await fact(blankCapacity, "이번 이미지 요청").innerText(), /빈 그림 자동 생성 · 최대 4장/);
      await blankPage.getByLabel("1컷 다시 생성 선택", { exact: true }).check();
      assert.equal(await blankPage.getByRole("button", { name: "빈 그림 4컷 자동 생성", exact: true }).count(), 1);
      assert.equal(await blankPage.getByRole("button", { name: "선택한 1컷 다시 생성", exact: true }).count(), 1);
      assert.match(await blankCapacity.innerText(), /빈 그림 자동 생성[^\n]*4장/);
      assert.match(await blankCapacity.innerText(), /선택[^\n]*1장/);
      await noOverflow(blankPage, `blank batch ${width}`);
      await screenshotPanel(blankPage, blankCapacity, `${output}/blank-batch-${width}.png`);
      assert(state.writes.every(write => [`${copyPath}/preview`, "/api/studio/export-check"].includes(write.path)), `only read-only previews and export validation: ${JSON.stringify(state.writes)}`);
      assert.deepEqual(state.errors, []); assert.deepEqual(state.blocked, []);
      results.push({ width, browser: "webkit", sourceProviderOverride: true, imageProvider: "openai", unknownRemaining: true, incompleteDraftCover: 1, singlePageImages: 1, missingImages: 3, selectedImages: 2, blankBatchAndSingleSelection: true, calculatorDecimalAndValidation: true, refreshFailurePreservesInputs: true, modelChangeClearsPrice: true, noHorizontalOverflow: true, paidCalls: 0, capacityRequests: state.capacityRequests.length });
      await writeFile(`${output}/results.json`, JSON.stringify({ passed: results.length === widths.length, results }, null, 2));
    } catch (error) {
      await page.screenshot({ path: `${output}/failure-${width}.png` });
      await writeFile(`${output}/failure-${width}.html`, await page.content());
      await writeFile(`${output}/failure-${width}.json`, JSON.stringify(state, null, 2));
      await writeFile(`${output}/results.json`, JSON.stringify({ passed: false, results, failedWidth: width, error: error.message }, null, 2));
      throw error;
    } finally { await context.close(); }
  }
  for (const width of widths) for (const extension of ["png", "html", "json"]) await unlink(`${output}/failure-${width}.${extension}`).catch(error => { if (error.code !== "ENOENT") throw error; });
  console.log(JSON.stringify({ passed: true, results }));
} finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
