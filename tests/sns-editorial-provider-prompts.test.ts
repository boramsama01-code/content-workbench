import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const controlled = vi.hoisted(() => ({ capture: vi.fn(), load: vi.fn(), image: vi.fn() }));
vi.mock("../server/services/familyEvidence", async original => ({
  ...await original<typeof import("../server/services/familyEvidence")>(),
  captureFamilySourceSnapshot: controlled.capture,
  loadFamilyEvidence: controlled.load,
  putFamilyEvidence: async (_db: unknown, value: any) => value.payload,
  createFamilyEvidenceSet: async (_db: unknown, item: any, snapshot: any, analysis: any, research: any, sources: any[]) => ({
    evidenceSetId: "voice-unit-evidence", sourceSnapshotId: snapshot.id, sourceAnalysisId: analysis.sourceAnalysisId,
    resourceResearchId: research?.resourceResearchId ?? null, itemId: item.id, channelId: item.channelId,
    createdAt: new Date().toISOString(), facts: analysis.facts, resources: research?.verifiedResources ?? [],
    sourceIds: [...snapshot.sources, ...sources].map(value => value.id),
  }),
}));
vi.mock("../server/services/familyEditorialImage", () => ({ generateFamilyCoverArtwork: controlled.image }));

import type { DB } from "../server/db";
import type { Channel, ContentItem } from "../shared/schema";
import { defaultChannelRoleSettings } from "../shared/channelAi";
import { emptyPayload } from "../shared/payloads";
import { SNS_EDITORIAL_VERSION } from "../shared/snsEditorial";
import { extractNotice, generateCardCopy, LlmBudget } from "../server/services/llm";
import { generateNewsCardCopy } from "../server/services/newsEditorial";
import { familyExecutionPlan, proposeFamilyDialogue, type FamilyGenerateInput } from "../server/services/familyEditorial";
import { editorialCopy, editorialSource, editorialSummary, openaiEditorialResponse } from "./fixtures/newsEditorial";
import { familyEvidenceFixture } from "./fixtures/familyEvidence";
import { familyDialogueCardFixture, familyDialogueMetadataFixture } from "./fixtures/familyDialogueCard";
import { createFamilyProviderMock } from "./fixtures/familyProvider";

const response = (data: unknown, name: string) => new Response(JSON.stringify({
  status: "completed", model: "voice-unit", output: [{ type: "function_call", name, arguments: JSON.stringify(data) }],
  usage: { input_tokens: 10, output_tokens: 20 },
}));
const cardCopy = () => ({ version: 1, templateKey: "set:n03-mint", cover: { title: "원문에서 확인한 사건", subtitle: "조건과 이유를 함께 살펴봐요" },
  pages: Array.from({ length: 4 }, (_, i) => ({ id: `body-${i + 1}`, title: `이야기 ${i + 1}`, subtitle: "확인된 조건", body: "확인한 사실을 구체적인 말로 설명해요." })) });

const rows: any[] = [];
const empty = () => { const query: any = { where: () => query, orderBy: () => query, limit: () => query, then: (resolve: any) => Promise.resolve([]).then(resolve) }; return query; };
// Unit receipt sink only. These tests inspect actual provider requests, without a database or paid calls.
const db = {
  select: () => ({ from: () => empty() }),
  insert: () => ({ values: (value: any) => { rows.push(value); const pending: any = { onConflictDoNothing: () => pending, returning: async () => [{ id: value.id }], then: (resolve: any) => Promise.resolve(undefined).then(resolve) }; return pending; } }),
  update: () => ({ set: (value: any) => ({ where: async () => { const pending = [...rows].reverse().find(row => row.status === "running"); if (pending) Object.assign(pending, value); } }) }),
} as unknown as DB;

function familyFixture(saved = false) {
  const aiSettings = defaultChannelRoleSettings(); aiSettings.editorial = { additionalResourcesAutoSearch: false, visitScope: "off" };
  aiSettings.roleModels.article_analysis = { provider: "gemini", model: "gemini-analysis-unit" };
  for (const role of ["card_copy", "caption", "editorial_review"] as const) aiSettings.roleModels[role] = { provider: "openai", model: `gpt-${role}-unit` };
  const channel = { id: 2, slug: "current-dialogue", name: "알리고당", audience: "중학생과 부모", editorialGuide: "", version: 7, aiSettings, budget: { llmCallsPerRun: 12 } } as Channel;
  const item = { id: 1, channelId: 2, version: 4, currentRevisionId: 30, kind: "science_dialogue", title: "확인한 전망" } as ContentItem;
  const revision = { id: 30, payload: saved ? { cardCopy: familyDialogueCardFixture(), ...familyDialogueMetadataFixture() } : {} };
  const input: FamilyGenerateInput = { version: 4, requestId: randomUUID(), formatId: "family_dialogue_8", templateKey: "set:n03", scope: "all", baseRevision: 30 };
  return { channel, item, revision, input, plan: familyExecutionPlan(channel, 30) };
}

beforeEach(() => {
  rows.length = 0;
  controlled.capture.mockReset().mockResolvedValue(familyEvidenceFixture().snapshot);
  controlled.load.mockReset().mockResolvedValue(familyEvidenceFixture());
  controlled.image.mockReset().mockResolvedValue({ assetId: 991 });
  vi.stubEnv("OPENAI_API_KEY", "voice-test-key"); vi.stubEnv("GEMINI_API_KEY", "voice-test-key");
  vi.stubEnv("AI_PROVIDER", "openai");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("shared editorial voice reaches actual provider requests", () => {
  it("adds the HighScoop voice to selected-page copy while retaining the template schema and source-only extraction", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(cardCopy(), "submit_card_copy"))
      .mockResolvedValueOnce(response(emptyPayload("notice", "공고 원문 제목"), "submit_notice"));
    vi.stubGlobal("fetch", fetcher);
    const payload = { cardCopy: cardCopy(), title: "공고 원문 제목" }, before = structuredClone(payload);
    const result = await generateCardCopy({ kind: "notice", title: "공고 원문 제목", payload, channelSlug: "opportunities", templateKey: "set:n03-mint", selectedPage: 2, budget: new LlmBudget(1), provider: "openai" });
    expect(result.ok).toBe(true); expect(payload).toEqual(before);
    const request = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(request.instructions).toContain(SNS_EDITORIAL_VERSION);
    expect(request.instructions).toContain("HighScoop: 중고등학생과 부모");
    expect(request.instructions).toContain("이번 범위는 명시적으로 선택한 필드만");
    expect(request.instructions).not.toContain("HighScoop 제목 지침");
    expect(request.input).toContain("다른 카드의 문구는 유지한다");
    expect(request.tools[0].parameters.properties.pages.items.properties.body.maxLength).toBe(140);

    await extractNotice({ sources: [], sourceHint: null, now: new Date("2026-11-16T00:00:00Z"), budget: new LlmBudget(1), provider: "openai" });
    expect(JSON.parse(fetcher.mock.calls[1][1].body).instructions).not.toContain(SNS_EDITORIAL_VERSION);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("applies the shared voice to the eight-page news path without changing roles or returning new fields", async () => {
    const fetcher = vi.fn().mockResolvedValue(openaiEditorialResponse(editorialCopy())); vi.stubGlobal("fetch", fetcher);
    const result = await generateNewsCardCopy({ kind: "science_dialogue", title: "확인한 사건", payload: editorialSummary(), templateKey: "set:n03", sources: [editorialSource()], budget: new LlmBudget(1), provider: "openai" });
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error);
    expect(result.data.pages).toHaveLength(7);
    const request = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(request.instructions).toContain(SNS_EDITORIAL_VERSION);
    expect(request.instructions).toContain("뉴스: 사실의 의외성");
    expect(request.instructions).toContain("2장은 누가 무엇을 했거나 말했는지");
    expect(Object.keys(result.data)).not.toContain("hookCandidates");
  });

  it("keeps fact extraction and image planning free of writing tone, and applies it to plan/copy/caption/review", async () => {
    const mock = createFamilyProviderMock(); vi.stubGlobal("fetch", vi.fn(mock.fetch));
    const f = familyFixture(), before = structuredClone(f.revision.payload);
    const result = await proposeFamilyDialogue(db, f.item, f.channel, f.revision, f.input, f.plan);
    expect(result.copy?.pages).toHaveLength(8); expect(result.reviewFlags).toEqual([]);
    expect(f.revision.payload).toEqual(before);
    for (const stage of ["article_analysis", "image_brief"] as const) expect(JSON.stringify(mock.calls.find(call => call.stage === stage)?.body)).not.toContain(SNS_EDITORIAL_VERSION);
    for (const stage of ["editorial_plan", "card_copy", "caption", "editorial_review"] as const) expect(JSON.stringify(mock.calls.find(call => call.stage === stage)?.body)).toContain(SNS_EDITORIAL_VERSION);
    expect(mock.calls.find(call => call.stage === "caption")?.body.instructions).toContain("이번 범위는 캡션만");
    expect(mock.calls.find(call => call.stage === "editorial_review")?.body.instructions).toContain("이번 범위는 검토와 최소 수정");
  });

  it("applies the partial-edit voice only to the requested family field and retains all other pages", async () => {
    const mock = createFamilyProviderMock(); vi.stubGlobal("fetch", vi.fn(mock.fetch));
    const f = familyFixture(true), before = structuredClone(f.revision.payload), path = "pages.implication.fields.takeaway";
    const result = await proposeFamilyDialogue(db, f.item, f.channel, f.revision, { ...f.input, scope: "field", pageId: "implication", allowedFieldPaths: [path] }, f.plan);
    expect(mock.calls.map(call => call.stage)).toEqual(["partial_copy"]);
    expect(mock.calls[0].body.instructions).toContain(SNS_EDITORIAL_VERSION);
    expect(mock.calls[0].body.instructions).toContain("이번 범위는 명시적으로 선택한 필드만");
    expect(mock.calls[0].input.allowedFieldPaths).toEqual([path]);
    expect(result.copy?.pages.filter(page => page.id !== "implication")).toEqual((before as any).cardCopy.pages.filter((page: any) => page.id !== "implication"));
    expect(f.revision.payload).toEqual(before);
  });
});
