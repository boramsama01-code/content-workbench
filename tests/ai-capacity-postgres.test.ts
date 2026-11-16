import crypto from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { login, resetDb, setTestEnv } from "./helpers";
import { defaultChannelAiSettings } from "../shared/channelAi";
setTestEnv();
const { createApp } = await import("../server/app");
const { getDb, closeDb } = await import("../server/db");
const { channels, jobs } = await import("../shared/schema");
let app: ReturnType<typeof createApp>;
const fetch = vi.fn(() => { throw new Error("Capacity lookup must never call a provider"); });
beforeAll(async () => {
  await resetDb(); app = createApp();
  vi.stubEnv("GEMINI_API_KEY", "private-gemini-key"); vi.stubEnv("OPENAI_API_KEY", "private-openai-key"); vi.stubEnv("OPENAI_MODEL", "gpt-default-override"); vi.stubGlobal("fetch", fetch);
});
afterAll(async () => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await closeDb(); });
async function fixture() {
  const { agent, csrf } = await login(app);
  const response = await agent.post("/api/channels").set("x-csrf-token", csrf).send({ name: "용량 확인", slug: `capacity-${crypto.randomUUID()}` });
  expect(response.status).toBe(201);
  const settings = defaultChannelAiSettings();
  settings.summary = { provider: "gemini", model: "gemini-channel-analysis" }; settings.image = { provider: "openai", model: "gpt-image-channel-image" };
  await getDb().update(channels).set({ aiSettings: settings }).where(eq(channels.id, response.body.id));
  return { agent, id: response.body.id as number };
}
it("requires operator authentication and validates channel/provider without any provider request", async () => {
  expect((await request(app).get("/api/studio/ai-capacity?channelId=1")).status).toBe(401);
  const { agent } = await fixture();
  expect((await agent.get("/api/studio/ai-capacity?channelId=0")).status).toBe(400);
  expect((await agent.get("/api/studio/ai-capacity?channelId=99999999")).status).toBe(404);
  expect((await agent.get("/api/studio/ai-capacity?channelId=1&analysisProvider=other")).status).toBe(400);
});
it("returns channel models, honors temporary analysis selection, and never invents balances", async () => {
  const f = await fixture();
  const response = await f.agent.get(`/api/studio/ai-capacity?channelId=${f.id}&analysisProvider=openai`);
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.body).toMatchObject({ channelId: f.id, analysis: { provider: "openai", model: "gpt-default-override", keyConfigured: true }, image: { provider: "openai", model: "gpt-image-channel-image", keyConfigured: true }, studioDailyImageLimit: null, providerRemainingTokens: null, providerRemainingImages: null });
  expect(JSON.stringify(response.body)).not.toMatch(/private-|API_KEY|requestHash/);
  const normal = await f.agent.get(`/api/studio/ai-capacity?channelId=${f.id}`);
  expect(normal.body.analysis.model).toBe("gemini-channel-analysis");
});
it("isolates recent failure metadata by channel and active model without exposing raw errors", async () => {
  const first = await fixture(), other = await fixture();
  const add = (channelId: number, model: string, error: string) => getDb().insert(jobs).values({ channelId, type: "source_generate", status: "failed", payload: { configuration: { summary: { provider: "gemini", model } } }, lastError: error });
  await add(first.id, "gemini-channel-analysis", "Gemini HTTP 429: 사용 한도 초과 private-error");
  await add(first.id, "gemini-old-model", "Gemini HTTP 429: 사용 한도 초과 private-stale-error");
  await add(other.id, "gemini-channel-analysis", "Gemini HTTP 503: private-other-channel-error");
  const response = await first.agent.get(`/api/studio/ai-capacity?channelId=${first.id}`);
  expect(response.body.latestFailure).toMatchObject({ provider: "gemini", model: "gemini-channel-analysis", kind: "quota" });
  expect(JSON.stringify(response.body)).not.toContain("private-");
  const override = await first.agent.get(`/api/studio/ai-capacity?channelId=${first.id}&analysisProvider=openai`);
  expect(override.body.latestFailure).toBeNull();
});
it("finds an image failure even if a newer analysis failure exists", async () => {
  const f = await fixture();
  await getDb().insert(jobs).values({ channelId: f.id, type: "card_render", status: "failed", payload: { configuration: { image: { provider: "openai", model: "gpt-image-channel-image" } } }, lastError: "OpenAI API 크레딧 부족" });
  await getDb().insert(jobs).values({ channelId: f.id, type: "source_generate", status: "failed", payload: { configuration: { summary: { provider: "gemini", model: "gemini-channel-analysis" } } }, lastError: "Gemini HTTP 429: 사용 한도 초과" });
  const combined = await f.agent.get(`/api/studio/ai-capacity?channelId=${f.id}`);
  expect(combined.body.latestFailure.provider).toBe("gemini");
  const imageOnly = await f.agent.get(`/api/studio/ai-capacity?channelId=${f.id}&imageOnly=1`);
  expect(imageOnly.body.latestFailure).toMatchObject({ provider: "openai", model: "gpt-image-channel-image", kind: "quota" });
});
