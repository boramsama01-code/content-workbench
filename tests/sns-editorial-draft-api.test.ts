import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { login, resetDb, setTestEnv } from "./helpers";
import { SNS_EDITORIAL_VERSION, SNS_TASKS } from "../shared/snsEditorial";
import { manualTextStageRequests } from "../server/services/manualAiBudget";
setTestEnv();
const mocked = vi.hoisted(() => ({ callTool: vi.fn() }));
vi.mock("../server/services/llm", async original => ({ ...await original<object>(), callTool: mocked.callTool }));
const { createApp } = await import("../server/app");
const { getDb, closeDb } = await import("../server/db");
const { jobs, studioCards, studioRequests, appSettings, auditLogs, channels } = await import("../shared/schema");
let app: ReturnType<typeof createApp>;
const output = () => ({ hooks: [{ angle: "장면", text: "붙잡는 순간부터 보여준다", reason: "제공된 장면과 연결" }], sections: [{ label: "첫 장면", text: "확인한 장면의 대본" }], finalCopy: "검토할 최종 문구", checks: ["시제를 원문과 대조"] });
const success = () => ({ ok: true, data: output(), model: "test-observed-model", usage: { inputTokens: 10, outputTokens: 20 }, provenance: { provider: "openai", requestedModel: "gpt-test", actualModel: "test-observed-model", requestId: "provider-unit-response", usageStatus: "known", inputTokens: 10, outputTokens: 20, status: "completed" } });
const body = (over: Record<string, unknown> = {}) => ({ version: 1, requestId: randomUUID(), provider: "openai", task: "carousel_plan", topic: "우주선 회수", audience: "학부모", format: "카드뉴스", channel: "news", referenceText: "비공개 자료 문장", existingText: "기존 문구", instruction: "좋은 문장을 유지", ...over });
async function setup() {
  const auth = await login(app), headers = { "x-csrf-token": auth.csrf };
  const created = await auth.agent.post("/api/studio/cards").set(headers).send({ title: "실제 제목", channel: "highscoop", format: "카드뉴스" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { ...auth, headers, card: created.body, endpoint: `/api/studio/cards/${created.body.id}/editorial-draft` };
}
beforeAll(async () => { await resetDb(); app = createApp(); });
afterAll(async () => { await closeDb(); });
beforeEach(async () => {
  process.env.OPENAI_API_KEY = "isolated-unit-never-a-real-key";
  process.env.GEMINI_API_KEY = "isolated-unit-never-a-real-key";
  process.env.ANTHROPIC_API_KEY = "isolated-unit-never-a-real-key";
  mocked.callTool.mockReset().mockResolvedValue(success());
  await getDb().insert(appSettings).values({ key: "global_stop", value: false }).onConflictDoUpdate({ target: appSettings.key, set: { value: false } });
});
it("requires operator login and CSRF, validates bounded inputs, and makes no call on rejection", async () => {
  const { agent, headers, endpoint } = await setup();
  expect((await request(app).post(endpoint).send(body())).status).toBe(401);
  expect((await agent.post(endpoint).send(body())).status).toBe(403);
  for (const invalid of [{ task: "publish" }, { version: 0 }, { requestId: "bad" }, { referenceText: "가".repeat(24001) }, { topic: "" }, { provider: "unknown" }])
    expect((await agent.post(endpoint).set(headers).send(body(invalid))).status).toBe(400);
  expect(mocked.callTool).not.toHaveBeenCalled();
});
it("uses the saved canonical channel and guide, returns provider provenance, and never applies the draft", async () => {
  const { agent, headers, card, endpoint } = await setup();
  await getDb().update(channels).set({ editorialGuide: "저장된 편집 가이드" }).where(eq(channels.slug, "opportunities"));
  const reply = await agent.post(endpoint).set(headers).send(body());
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  expect(reply.body).toMatchObject({ finalCopy: output().finalCopy, promptVersion: SNS_EDITORIAL_VERSION, provider: "openai", model: "test-observed-model", cardVersion: 1, provenance: { requestId: "provider-unit-response" } });
  const call = mocked.callTool.mock.calls[0][0];
  expect(call.system).toContain("HighScoop:"); expect(call.system).toContain("저장된 편집 가이드");
  expect(call.user).toContain('"channel": "highscoop"');
  expect(call).toMatchObject({ provider: "openai", structured: true, maxAttempts: 1 });
  expect(call.budget.limit).toBe(1);
  expect((await agent.get(`/api/studio/cards/${card.id}`)).body.card).toMatchObject({ title: "실제 제목", version: 1, script: "", caption: "" });
  const [receipt] = await getDb().select().from(jobs).where(eq(jobs.id, reply.body.jobId));
  expect(receipt.payload).toMatchObject({ cardId: card.id, task: "carousel_plan", version: 1 });
  expect(JSON.stringify(receipt.payload)).not.toContain("비공개 자료 문장");
  expect(JSON.stringify((receipt.result?.response as Record<string, unknown>)?.promptTrace)).not.toContain("비공개 자료 문장");
  expect(JSON.stringify(await getDb().select().from(auditLogs))).not.toContain("비공개 자료 문장");
});
it("replays one completed UUID without another paid call and rejects changed input/provider reuse", async () => {
  const { agent, headers, endpoint } = await setup(), input = body();
  const first = await agent.post(endpoint).set(headers).send(input);
  const replay = await agent.post(endpoint).set(headers).send(input);
  expect(first.status).toBe(200); expect(replay.body).toEqual(first.body);
  expect((await agent.post(endpoint).set(headers).send({ ...input, instruction: "다른 요청" })).status).toBe(409);
  expect((await agent.post(endpoint).set(headers).send({ ...input, provider: "anthropic" })).status).toBe(409);
  expect(mocked.callTool).toHaveBeenCalledOnce();
});
it("rejects stale versions both before I/O and after an edit while generation is running", async () => {
  const { agent, headers, card, endpoint } = await setup();
  expect((await agent.post(endpoint).set(headers).send(body({ version: 2 }))).status).toBe(409);
  expect(mocked.callTool).not.toHaveBeenCalled();
  mocked.callTool.mockImplementationOnce(async () => {
    await getDb().update(studioCards).set({ version: 2 }).where(eq(studioCards.id, card.id));
    return success();
  });
  const reply = await agent.post(endpoint).set(headers).send(body());
  expect(reply.status).toBe(409);
  expect((await getDb().select().from(jobs).where(eq(jobs.id, reply.body.jobId)))[0]).toMatchObject({ status: "failed", result: null });
  expect((await agent.get(`/api/studio/cards/${card.id}`)).body.card.script).toBe("");
});
it("persists cancellation before admission so the delayed original request cannot call AI", async () => {
  const { agent, headers, endpoint } = await setup(), input = body();
  expect((await agent.post(`${endpoint}/${input.requestId}/cancel`).set(headers).send({})).body.cancelled).toBe(true);
  expect((await agent.post(endpoint).set(headers).send(input)).status).toBe(422);
  expect(mocked.callTool).not.toHaveBeenCalled();
});
it("cancels a running provider signal, rejects both competing generation paths, and never reruns that UUID", async () => {
  const { agent, headers, card, endpoint } = await setup(), input = body();
  let started!: () => void, finish!: (value: unknown) => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  mocked.callTool.mockImplementationOnce((options: { signal: AbortSignal }) => new Promise(resolve => {
    finish = resolve; options.signal.addEventListener("abort", () => resolve({ ok: false, kind: "api", error: "취소된 테스트 요청" }), { once: true }); started();
  }));
  const pending = agent.post(endpoint).set(headers).send(input).then(value => value);
  await ready;
  const duplicate = await agent.post(endpoint).set(headers).send(input);
  expect(duplicate.status).toBe(409); expect(duplicate.body).toMatchObject({ jobStatus: "running", replayed: true });
  expect((await agent.post(endpoint).set(headers).send(body())).status).toBe(409);
  const competingId = randomUUID();
  expect((await agent.post(`/api/studio/cards/${card.id}/generate`).set(headers).send({ version: 1, kind: "text", textTarget: "fill", provider: "openai", requestId: competingId })).status).toBe(409);
  expect(await getDb().select().from(studioRequests).where(eq(studioRequests.requestId, competingId))).toHaveLength(0);
  const cancel = await agent.post(`${endpoint}/${input.requestId}/cancel`).set(headers).send({});
  finish(success());
  expect(cancel.body.cancelled).toBe(true); expect((await pending).status).toBe(422);
  expect((await agent.post(endpoint).set(headers).send(input)).status).toBe(422);
  expect(mocked.callTool).toHaveBeenCalledOnce();
});
it("honors global stop and provider configuration before spending any call", async () => {
  const { agent, headers, endpoint } = await setup();
  delete process.env.OPENAI_API_KEY;
  expect((await agent.post(endpoint).set(headers).send(body())).status).toBe(503);
  process.env.OPENAI_API_KEY = "isolated-unit-never-a-real-key";
  await getDb().update(appSettings).set({ value: true }).where(eq(appSettings.key, "global_stop"));
  expect((await agent.post(endpoint).set(headers).send(body())).status).toBe(409);
  expect(mocked.callTool).not.toHaveBeenCalled();
});
it("moving a card to trash cancels the active editorial job and its provider signal", async () => {
  const { agent, headers, card, endpoint } = await setup();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  mocked.callTool.mockImplementationOnce((options: { signal: AbortSignal }) => new Promise(resolve => {
    options.signal.addEventListener("abort", () => resolve({ ok: false, kind: "api", error: "취소된 테스트 요청" }), { once: true }); started();
  }));
  const pending = agent.post(endpoint).set(headers).send(body()).then(value => value);
  await ready;
  const moved = await agent.post(`/api/studio/cards/${card.id}/trash`).set(headers).send({ version: 1 });
  expect(moved.status).toBe(200); expect(moved.body.cancelledJobs).toBe(1);
  const result = await pending;
  expect(result.status).toBe(409);
  expect((await getDb().select().from(jobs).where(eq(jobs.id, result.body.jobId)))[0]).toMatchObject({ status: "cancelled", result: null });
  expect(mocked.callTool).toHaveBeenCalledOnce();
});
it("supports all 13 task contracts and rejects fabricated extra score fields without fallback", async () => {
  const { agent, headers, endpoint } = await setup();
  for (const task of SNS_TASKS) {
    const reply = await agent.post(endpoint).set(headers).send(body({ task: task.id }));
    expect(reply.status, task.id + JSON.stringify(reply.body)).toBe(200); expect(reply.body.task).toBe(task.id);
    expect(mocked.callTool.mock.lastCall?.[0].user).toContain(task.label);
  }
  mocked.callTool.mockResolvedValueOnce({ ...success(), data: { ...output(), algorithmScore: 99 } });
  expect((await agent.post(endpoint).set(headers).send(body())).status).toBe(422);
  expect(mocked.callTool).toHaveBeenCalledTimes(14);
});
it.each(["gemini", "openai", "anthropic"] as const)("uses the explicitly selected %s provider and its bounded manual budget without fallback", async provider => {
  const { agent, headers, endpoint } = await setup();
  mocked.callTool.mockImplementationOnce(async () => ({ ...success(), provenance: { ...success().provenance, provider } }));
  const response = await agent.post(endpoint).set(headers).send(body({ provider }));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body).toMatchObject({ provider, provenance: { provider } });
  expect(mocked.callTool).toHaveBeenCalledOnce();
  expect(mocked.callTool.mock.calls[0][0].budget.limit).toBe(manualTextStageRequests(provider));
  expect(mocked.callTool.mock.calls[0][0]).toMatchObject({ provider, maxAttempts: 1 });
});
