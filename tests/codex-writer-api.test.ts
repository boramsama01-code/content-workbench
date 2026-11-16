import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { login, resetDb, setTestEnv } from "./helpers";
import { CODEX_WRITER_JOB_TYPE, CODEX_WRITER_MODEL } from "../shared/codexWriter";
import { SNS_CONTENT_FLOW_RULES, SNS_EDITORIAL_VERSION } from "../shared/snsEditorial";
setTestEnv();
const { createApp } = await import("../server/app");
const { getDb, getPool, closeDb } = await import("../server/db");
const { appSettings, jobs, studioCards, studioRequests, contentItems, channels } = await import("../shared/schema");
const token = "codex-writer-isolated-fixture-token-never-a-real-token";
const worker = { authorization: `Bearer ${token}` };
const body = (over: Record<string, unknown> = {}) => ({ version: 1, requestId: randomUUID(), provider: "openai", task: "carousel_plan", topic: "실제 회수 장면", audience: "부모", format: "카드뉴스", channel: "news", referenceText: "외부에 그대로 노출하면 안 되는 원문 자료", existingText: "사용자가 고른 문구", instruction: "첫 장만 구체적으로", ...over });
const output = () => ({ hooks: [{ angle: "장면", text: "원문의 구체적인 장면", reason: "첫 장에서 약속을 이행" }], sections: [{ label: "첫 장", text: "검토할 내용" }], finalCopy: "검토한 최종 문구", checks: ["주체와 시제 확인"] });
const reviewed = { passed: true, status: "ready", issues: [], revisionsApplied: [], checks: ["source", "conditions", "voice", "flow", "scope"].map(aspect => ({ aspect, status: "pass", detail: "제공한 자료와 요청 범위를 대조" })) };
let app: ReturnType<typeof createApp>;
beforeAll(async () => { await resetDb(); app = createApp(); });
afterAll(async () => { await closeDb(); });
beforeEach(async () => {
  process.env.STUDIO_CODEX_WRITER_TOKEN_SHA256 = createHash("sha256").update(token).digest("hex");
  await getDb().delete(jobs).where(eq(jobs.type, CODEX_WRITER_JOB_TYPE));
  await getDb().insert(appSettings).values({ key: "global_stop", value: false }).onConflictDoUpdate({ target: appSettings.key, set: { value: false } });
});
async function setup() {
  const auth = await login(app), headers = { "x-csrf-token": auth.csrf };
  const created = await auth.agent.post("/api/studio/cards").set(headers).send({ title: "실제 원고", channel: "highscoop", format: "카드뉴스" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { ...auth, headers, card: created.body, endpoint: `/api/studio/cards/${created.body.id}/codex-draft` };
}
const claim = () => request(app).post("/api/codex-writer/claim").set(worker).send({});
function complete(job: { jobId: number; leaseId: string }, over: Record<string, unknown> = {}) {
  return request(app).post(`/api/codex-writer/jobs/${job.jobId}/complete`).set(worker).send({ leaseId: job.leaseId, output: output(), model: CODEX_WRITER_MODEL, qualityReview: reviewed, ...over });
}
it("keeps worker bearer scope separate from operator session and CSRF", async () => {
  const { agent, headers, endpoint } = await setup();
  expect((await request(app).post(endpoint).send(body())).status).toBe(401);
  expect((await agent.post(endpoint).send(body())).status).toBe(403);
  expect((await request(app).post("/api/codex-writer/claim").send({})).status).toBe(401);
  expect((await agent.post("/api/codex-writer/claim").set(headers).send({})).status).toBe(401);
  expect((await request(app).post("/api/codex-writer/claim").set("authorization", "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").send({})).status).toBe(401);
  expect((await request(app).get("/api/studio/cards").set(worker)).status).toBe(401);
  expect((await claim()).status).toBe(200);
});
it("reports a scoped device heartbeat without returning credentials or letting it select another model", async () => {
  const { agent } = await setup();
  const response = await request(app).post("/api/codex-writer/heartbeat").set(worker).send({ deviceName: "편집용 PC", model: CODEX_WRITER_MODEL });
  expect(response.status).toBe(200);
  const status = await agent.get("/api/studio/codex-writer/status");
  expect(status.body).toMatchObject({ configured: true, online: true, deviceName: "편집용 PC", model: CODEX_WRITER_MODEL });
  expect(JSON.stringify(status.body)).not.toContain(token);
  expect((await request(app).post("/api/codex-writer/heartbeat").set(worker).send({ deviceName: "PC", model: "untrusted-model" })).status).toBe(400);
});
it.each([{ task: "carousel_plan", format: "카드뉴스" }, { task: "reel_script", format: "릴스" }])("seals source text and delivers the canonical shared flow prompt for $task to a worker", async ({ task, format }) => {
  const { agent, headers, endpoint, card } = await setup(), input = body({ task, format });
  const queued = await agent.post(endpoint).set(headers).send(input);
  expect(queued.status, JSON.stringify(queued.body)).toBe(202); expect(queued.body.status).toBe("queued");
  expect(queued.body.result).toBeNull(); expect(JSON.stringify(queued.body)).not.toContain(input.referenceText);
  const [row] = await getDb().select().from(jobs).where(eq(jobs.id, queued.body.jobId));
  expect(JSON.stringify(row.payload)).not.toContain(input.referenceText); expect(row.payload.sealedPrompt).toBeTruthy();
  expect(row.payload.promptVersion).toBe(SNS_EDITORIAL_VERSION);
  expect((await agent.post(endpoint).set(headers).send(input)).body.jobId).toBe(row.id);
  expect((await agent.post(endpoint).set(headers).send({ ...input, instruction: "다른 요청" })).status).toBe(409);
  const claimed = await claim();
  expect(claimed.body.job).toMatchObject({ jobId: row.id, cardId: card.id, model: CODEX_WRITER_MODEL, effort: "ultra" });
  expect(claimed.body.job.prompt).toContain(input.referenceText); expect(claimed.body.job.prompt).toContain('"channel": "highscoop"');
  expect(claimed.body.job.prompt).toContain("인형뽑기 클라스");
  expect(claimed.body.job.prompt).toContain(SNS_EDITORIAL_VERSION);
  expect(claimed.body.job.prompt).toContain(SNS_CONTENT_FLOW_RULES);
  expect(claimed.body.job.prompt).toContain(input.existingText);
  expect(claimed.body.job.prompt).toContain(input.instruction);
  expect(claimed.body.job.prompt).toContain(`"format": "${format}"`);
  expect((await claim()).body.job).toBeNull();
});
it("validates lease, model, output and independent review then stores a proposal without modifying the card", async () => {
  const { agent, headers, endpoint, card } = await setup(), input = body();
  await agent.post(endpoint).set(headers).send(input);
  const job = (await claim()).body.job;
  expect((await complete(job, { leaseId: randomUUID() })).status).toBe(409);
  expect((await complete(job, { model: "wrong-model" })).status).toBe(400);
  expect((await complete(job, { qualityReview: undefined })).status).toBe(400);
  expect((await complete(job, { qualityReview: { ...reviewed, checks: undefined } })).status).toBe(400);
  expect((await complete(job, { qualityReview: { ...reviewed, checks: reviewed.checks.slice(0, 1) } })).status).toBe(400);
  expect((await complete(job, { qualityReview: { ...reviewed, checks: [...reviewed.checks.slice(0, 4), reviewed.checks[0]] } })).status).toBe(400);
  expect((await complete(job, { qualityReview: { ...reviewed, checks: reviewed.checks.map((check, index) => index === 4 ? { ...check, status: "revise" } : check) } })).status).toBe(400);
  expect((await complete(job, { output: { ...output(), algorithmScore: 99 } })).status).toBe(400);
  const finished = await complete(job);
  expect(finished.status, JSON.stringify(finished.body)).toBe(200);
  expect(finished.body).toMatchObject({ status: "succeeded", result: { writer: "codex", provider: "openai", model: CODEX_WRITER_MODEL, qualityReview: { passed: true }, usageStatus: "usage_unknown" } });
  expect(finished.body.result).not.toHaveProperty("provenance"); expect(finished.body.result).not.toHaveProperty("usage");
  const polled = await agent.get(`${endpoint}/${input.requestId}`);
  expect(polled.body.result).toEqual(finished.body.result);
  const replay = await complete(job);
  expect(replay.status).toBe(200); expect(replay.body).toEqual(finished.body);
  expect((await complete(job, { output: { ...output(), finalCopy: "다른 결과" } })).status).toBe(409);
  expect((await complete(job, { leaseId: randomUUID() })).status).toBe(409);
  expect((await getDb().select().from(jobs).where(eq(jobs.id, job.jobId)))[0].payload.sealedPrompt).toBeUndefined();
  expect((await agent.get(`/api/studio/cards/${card.id}`)).body.card).toMatchObject({ version: 1, title: "실제 원고", script: "", caption: "" });
  await getDb().update(studioCards).set({ version: 2 }).where(eq(studioCards.id, card.id));
  expect((await complete(job)).status).toBe(409);
});
it("preserves an unfinished proposal with a failed review instead of reporting review success", async () => {
  const { agent, headers, endpoint } = await setup(); await agent.post(endpoint).set(headers).send(body());
  const job = (await claim()).body.job;
  const result = await complete(job, { qualityReview: { passed: false, status: "needs_source", issues: ["원문에서 날짜 확인 필요"], revisionsApplied: [], checks: [{ aspect: "source", status: "not_checked", detail: "원문 없음" }] } });
  expect(result.body).toMatchObject({ status: "succeeded", phase: "completed_needs_review", result: { qualityReview: { passed: false, status: "needs_source" } } });
});
it("persists cancellation before admission and rejects running work after cancellation", async () => {
  const { agent, headers, endpoint } = await setup(), input = body();
  expect((await agent.post(`${endpoint}/${input.requestId}/cancel`).set(headers).send({})).body.status).toBe("cancelled");
  expect((await agent.post(endpoint).set(headers).send(input)).body.status).toBe("cancelled");
  expect((await claim()).body.job).toBeNull();
  const next = body(); await agent.post(endpoint).set(headers).send(next); const job = (await claim()).body.job;
  expect((await agent.post(`${endpoint}/${next.requestId}/cancel`).set(headers).send({})).body.status).toBe("cancelled");
  expect((await complete(job)).status).toBe(409);
});
it("stops stale Studio versions before claim, and stops linked source revisions before completion and replay", async () => {
  const { agent, headers, endpoint, card } = await setup(), input = body();
  await agent.post(endpoint).set(headers).send(input);
  await getDb().update(studioCards).set({ version: 2 }).where(eq(studioCards.id, card.id));
  expect((await claim()).body.job).toBeNull();
  expect((await agent.get(`${endpoint}/${input.requestId}`)).body.result).toBeNull();
  const [channel] = await getDb().select().from(channels).where(eq(channels.slug, "opportunities"));
  const [source] = await getDb().insert(contentItems).values({ channelId: channel.id, kind: "notice", title: "연결한 원문", currentRevisionId: 10 }).returning();
  await getDb().update(studioCards).set({ sourceItemId: source.id }).where(eq(studioCards.id, card.id));
  const second = body({ version: 2 }); await agent.post(endpoint).set(headers).send(second); const job = (await claim()).body.job;
  const [queued] = await getDb().select().from(jobs).where(eq(jobs.id, job.jobId));
  expect(queued.payload.sourceSnapshot).toEqual({ itemId: source.id, version: 1, revisionId: 10 });
  await getDb().update(contentItems).set({ currentRevisionId: 11 }).where(eq(contentItems.id, source.id));
  expect((await complete(job)).body.continue).toBe(false);
  expect((await agent.post(endpoint).set(headers).send(second)).status).toBe(409);
  expect((await agent.get(`${endpoint}/${second.requestId}`)).body.result).toBeNull();
});
it("rejects a source linked while admission waits for its card lock", async () => {
  const { agent, headers, endpoint, card } = await setup(), input = body();
  const [channel] = await getDb().select().from(channels).where(eq(channels.slug, "opportunities"));
  const [source] = await getDb().insert(contentItems).values({ channelId: channel.id, kind: "notice", title: "새로 연결한 원문" }).returning();
  const connection = await getPool().connect();
  try {
    await connection.query("BEGIN");
    await connection.query("UPDATE studio_cards SET source_item_id = $1 WHERE id = $2", [source.id, card.id]);
    const pending = agent.post(endpoint).set(headers).send(input).then(response => response);
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      // Read statistics in an autocommit session; PG16 can cache pg_stat_activity
      // for the duration of the row-lock transaction on `connection`.
      const blocked = await getPool().query("SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%studio_cards%' LIMIT 1");
      if (blocked.rowCount) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await connection.query("COMMIT");
    const result = await pending;
    expect(waiting).toBe(true);
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body.error).toContain("연결된 원문이 바뀌었습니다");
    expect(await getDb().select().from(jobs).where(eq(jobs.dedupeKey, `codex-writer:${card.id}:${input.requestId}`))).toHaveLength(0);
  } finally { await connection.query("ROLLBACK"); connection.release(); }
});
it("expires a lost lease without requeueing or executing it twice", async () => {
  const { agent, headers, endpoint } = await setup(), input = body();
  await agent.post(endpoint).set(headers).send(input); const job = (await claim()).body.job;
  await getDb().update(jobs).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, job.jobId));
  expect((await complete(job)).status).toBe(409);
  expect((await claim()).body.job).toBeNull();
  expect((await agent.get(`${endpoint}/${input.requestId}`)).body.status).toBe("failed");
  expect((await agent.post(endpoint).set(headers).send(input)).body.status).toBe("failed");
});
it("blocks ordinary API generation while Codex is active and cancels it when moved to trash", async () => {
  const { agent, headers, endpoint, card } = await setup(), input = body();
  await agent.post(endpoint).set(headers).send(input); const job = (await claim()).body.job;
  const competingId = randomUUID();
  expect((await agent.post(`/api/studio/cards/${card.id}/generate`).set(headers).send({ version: 1, kind: "text", textTarget: "fill", requestId: competingId })).status).toBe(409);
  expect(await getDb().select().from(studioRequests).where(eq(studioRequests.requestId, competingId))).toHaveLength(0);
  const moved = await agent.post(`/api/studio/cards/${card.id}/trash`).set(headers).send({ version: 1 });
  expect(moved.body.cancelledJobs).toBe(1); expect((await complete(job)).status).toBe(409);
});
it("honors the global stop and rejects unbound or foreign job reads", async () => {
  const { agent, headers, endpoint } = await setup(), input = body();
  await getDb().update(appSettings).set({ value: true }).where(eq(appSettings.key, "global_stop"));
  expect((await agent.post(endpoint).set(headers).send(input)).status).toBe(409);
  expect((await claim()).body.job).toBeNull();
  await getDb().update(appSettings).set({ value: false }).where(eq(appSettings.key, "global_stop"));
  const queued = await agent.post(endpoint).set(headers).send(input);
  await getDb().update(jobs).set({ requestedBy: "another-operator" }).where(eq(jobs.id, queued.body.jobId));
  expect((await agent.get(`${endpoint}/${input.requestId}`)).status).toBe(404);
  expect((await agent.post(`${endpoint}/${input.requestId}/cancel`).set(headers).send({})).status).toBe(404);
});
