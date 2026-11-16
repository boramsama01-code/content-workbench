/** Actual source-generation routes and PostgreSQL receipts; all provider HTTP is mocked. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { channels, contentItems, contentRevisions, jobs, sourceDocuments } from "../shared/schema";
import { defaultChannelAiSettings, defaultChannelRoleSettings, type AiSelection } from "../shared/channelAi";
import type { AiExecutionPlan } from "../shared/aiProvenance";
import { emptyPayload } from "../shared/payloads";
import { login, resetDb, setTestEnv } from "./helpers";
import { createFamilyProviderMock } from "./fixtures/familyProvider";
import { editorialCopy, editorialSource, editorialSummary, geminiEditorialResponse, openaiEditorialResponse } from "./fixtures/newsEditorial";

setTestEnv();
const { getDb, closeDb } = await import("../server/db");
const { createApp } = await import("../server/app");
const { createRevision } = await import("../server/content");
let app: ReturnType<typeof createApp>;
const outbound = vi.fn();
beforeAll(async () => { await resetDb(); app = createApp(); });
beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", "isolated-choice-gemini"); vi.stubEnv("OPENAI_API_KEY", "isolated-choice-openai");
  vi.stubEnv("GEMINI_MODEL", "gemini-choice-default"); vi.stubEnv("OPENAI_MODEL", "gpt-choice-default");
  outbound.mockReset().mockImplementation(() => { throw new Error("Unexpected provider request in isolated choice test"); });
  vi.stubGlobal("fetch", outbound);
});
afterAll(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await closeDb(); });

async function fixture(settingsVersion: 1 | 2, savedCopy = false) {
  const summary = { provider: "gemini", model: "gemini-choice-saved" } as const;
  const copy = { provider: "openai", model: "gpt-choice-copy" } as const;
  const image = { provider: "openai", model: "gpt-image-choice" } as const;
  const aiSettings = settingsVersion === 1 ? { ...defaultChannelAiSettings(), summary, copy, image } : defaultChannelRoleSettings();
  if ("version" in aiSettings) {
    aiSettings.roleModels.article_analysis = summary; aiSettings.roleModels.card_copy = copy; aiSettings.roleModels.image_generation = image;
    aiSettings.editorial = { additionalResourcesAutoSearch: false, visitScope: "off" };
  }
  await getDb().update(channels).set({ aiSettings }).where(eq(channels.id, 2));
  const source = editorialSource(), url = `https://example.test/provider-choice/${randomUUID()}`;
  const [doc] = await getDb().insert(sourceDocuments).values({ normalizedUrl: url, originalUrl: url, kind: "news", title: source.title, fetchedText: source.text, fetchStatus: "ok" }).returning();
  const [created] = await getDb().insert(contentItems).values({ channelId: 2, primarySourceId: doc.id, kind: "science_dialogue", title: doc.title, relevance: "relevant" }).returning();
  const payload = { ...emptyPayload("science_dialogue", doc.title), ...(savedCopy ? { cardCopy: editorialCopy(doc.id) } : {}) };
  const revision = await createRevision(getDb(), { contentItemId: created.id, author: "operator", payload });
  const [item] = await getDb().select().from(contentItems).where(eq(contentItems.id, created.id));
  const { agent, csrf } = await login(app);
  return { agent, headers: { "x-csrf-token": csrf }, endpoint: `/api/channels/2/items/${item.id}`, item, revision, doc, payload, aiSettings, summary, copy, image };
}
async function savedResult(itemId: number, jobId: number) {
  const [item] = await getDb().select().from(contentItems).where(eq(contentItems.id, itemId));
  const [revision] = await getDb().select().from(contentRevisions).where(eq(contentRevisions.id, item.currentRevisionId!));
  const [job] = await getDb().select().from(jobs).where(eq(jobs.id, jobId));
  const configuration = job.payload.configuration as { summary: AiSelection; copy: AiSelection; familyPlan: AiExecutionPlan };
  return { revision, configuration };
}

describe.each([1, 2] as const)("source provider choice with v%s channel settings", settingsVersion => {
  it.each([undefined, "gemini", "openai"] as const)("uses the %s analysis choice in both the admitted plan and actual eight-page generation", async provider => {
    const f = await fixture(settingsVersion), mock = createFamilyProviderMock(); outbound.mockImplementation(mock.fetch);
    const response = await f.agent.post(`${f.endpoint}/generate`).set(f.headers).send({ version: f.item.version, requestId: randomUUID(), templateKey: "set:n03", ...(provider ? { provider } : {}) });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const expected = provider === "openai" ? { provider: "openai", model: "gpt-choice-default" } : f.summary;
    const { configuration, revision } = await savedResult(f.item.id, response.body.jobId);
    expect(configuration.summary).toEqual(expected);
    expect(configuration.familyPlan.roles.article_analysis).toMatchObject({ ...expected, requestedModel: expected.model });
    expect(configuration.copy).toEqual(f.copy);
    expect(configuration.familyPlan.roles.card_copy).toMatchObject(f.copy);
    expect(configuration.familyPlan.roles.image_generation).toMatchObject(f.image);
    expect(configuration.familyPlan.roles.resource_research.provider).toBe("gemini");
    const analysis = mock.calls.find(call => call.stage === "article_analysis")!;
    if (expected.provider === "openai") {
      expect(analysis.url).toBe("https://api.openai.com/v1/responses"); expect(analysis.body.model).toBe(expected.model);
    } else expect(analysis.url).toContain(`/models/${expected.model}:generateContent`);
    expect(mock.calls.find(call => call.stage === "card_copy")?.body.model).toBe(f.copy.model);
    expect(mock.calls.find(call => call.stage === "image_generation")?.body.model).toBe(f.image.model);
    expect(revision.payload.cardCopy).toMatchObject({ version: 2 });
    expect(revision.payload.aiWorkflow).toMatchObject({ summary: expected, copy: f.copy });
    const [channel] = await getDb().select().from(channels).where(eq(channels.id, 2));
    expect(channel.aiSettings).toEqual(f.aiSettings);
  });
});

it("finishes a GPT-selected draft when the channel's Gemini analysis connection is unavailable", async () => {
  const f = await fixture(2), mock = createFamilyProviderMock(); outbound.mockImplementation(mock.fetch);
  vi.stubEnv("GEMINI_API_KEY", "");
  const response = await f.agent.post(`${f.endpoint}/generate`).set(f.headers).send({ version: f.item.version, requestId: randomUUID(), templateKey: "set:n03", provider: "openai" });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(mock.calls.map(call => call.stage)).toContain("image_generation");
  expect(mock.calls.every(call => call.url.startsWith("https://api.openai.com/"))).toBe(true);
});

it.each([undefined, "openai"] as const)("preserves a legacy saved deck when refreshing its source with %s provider", async provider => {
  const f = await fixture(1, true), expected = provider === "openai" ? { provider: "openai", model: "gpt-choice-default" } : f.summary;
  outbound.mockImplementation(async (_url: unknown, init: RequestInit) => {
    const result = expected.provider === "openai" ? openaiEditorialResponse(editorialSummary("science_dialogue", f.doc.id), "submit_science") : geminiEditorialResponse(editorialSummary("science_dialogue", f.doc.id));
    const body = await result.json();
    if (expected.provider === "openai") body.model = JSON.parse(String(init.body)).model;
    else body.modelVersion = expected.model;
    return new Response(JSON.stringify(body));
  });
  const response = await f.agent.post(`${f.endpoint}/generate`).set(f.headers).send({ version: f.item.version, requestId: randomUUID(), templateKey: "set:n03", ...(provider ? { provider } : {}) });
  expect(response.status, JSON.stringify(response.body)).toBe(200); expect(outbound).toHaveBeenCalledOnce();
  const { configuration, revision } = await savedResult(f.item.id, response.body.jobId);
  expect(configuration.summary).toEqual(expected); expect(configuration.familyPlan.roles.article_analysis).toMatchObject(expected);
  expect(revision.payload.cardCopy).toEqual(f.payload.cardCopy); expect(revision.payload.aiWorkflow).toMatchObject({ summary: expected });
  if (expected.provider === "openai") expect(JSON.parse(outbound.mock.calls[0][1].body).model).toBe(expected.model);
  else expect(outbound.mock.calls[0][0]).toContain(`/models/${expected.model}:generateContent`);
});
