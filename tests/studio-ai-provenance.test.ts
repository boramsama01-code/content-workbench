import { beforeEach, expect, it, vi } from "vitest";
import { setTestEnv } from "./helpers";
import { SNS_CONTENT_FLOW_RULES, SNS_EDITORIAL_VERSION } from "../shared/snsEditorial";
setTestEnv();
const mock = vi.hoisted(() => ({ callTool: vi.fn() }));
vi.mock("../server/services/llm", async original => ({ ...await original<object>(), callTool: mock.callTool }));
const { generateStudioText, generateStudioCaption, generateStudioPanel } = await import("../server/services/studioAi");
const provenance = { provider: "gemini", requestedModel: "gemini-2.5-flash", actualModel: "gemini-2.5-flash-001", requestId: "provider-response-qa", usageStatus: "known", inputTokens: 34, outputTokens: 56, status: "completed" };
const options = { provider: "gemini" as const, model: "gemini-2.5-flash", directive: "사용자 원고를 유지해 주세요", content: { title: "QA", channel: "allligodang", format: "웹툰", panels: Array.from({ length: 4 }, () => ({ scene: "장면", dialogue: "대사" })) } };
beforeEach(() => mock.callTool.mockReset());
it.each([
  ["save_studio_draft", () => generateStudioText(options), { title: "QA", script: "원고", caption: "캡션", panels: options.content.panels }],
  ["save_studio_caption", () => generateStudioCaption(options), { caption: "캡션" }],
  ["save_studio_panel", () => generateStudioPanel({ ...options, panelIndex: 1 }), { scene: "장면", dialogue: "대사" }],
] as const)("%s forwards provider evidence and hashes the exact prompt inputs once", async (toolName, generate, data) => {
  mock.callTool.mockResolvedValue({ ok: true, data, model: provenance.actualModel, usage: { inputTokens: 34, outputTokens: 56 }, provenance });
  const originalContent = structuredClone(options.content);
  const result = await generate();
  expect(options.content).toEqual(originalContent);
  expect(result.provenance).toEqual(provenance);
  expect(result.promptTrace).toEqual({ toolName, inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(JSON.stringify(result.promptTrace)).not.toContain(options.directive);
  expect(mock.callTool).toHaveBeenCalledOnce();
  expect(mock.callTool.mock.calls[0][0]).toMatchObject({ provider: "gemini", model: "gemini-2.5-flash", maxAttempts: 1, toolName });
  expect(mock.callTool.mock.calls[0][0].system).toContain(SNS_EDITORIAL_VERSION);
  const request = mock.callTool.mock.calls[0][0];
  expect(request.system).toContain(SNS_CONTENT_FLOW_RULES);
  if (toolName === "save_studio_draft") {
    expect(JSON.parse(request.user).existing_content).toEqual(originalContent);
    expect(request.inputSchema.required).toEqual(["title", "script", "caption", "panels"]);
  }
  if (toolName === "save_studio_caption") {
    expect(request.system).toContain("이번 범위는 캡션만");
    expect(JSON.parse(request.user).content).toEqual(originalContent);
    expect(request.inputSchema.required).toEqual(["caption"]);
  }
  if (toolName === "save_studio_panel") {
    expect(request.system).toContain("선택한 필드만");
    expect(JSON.parse(request.user)).toMatchObject({ selected_panel: 2, content: originalContent });
    expect(request.inputSchema.required).toEqual(["scene", "dialogue"]);
  }
});
it("retains truncated response evidence on the safe failure and changes the hash with prompt edits", async () => {
  mock.callTool.mockResolvedValue({ ok: false, kind: "parse", error: "safe incomplete result", provenance: { ...provenance, status: "truncated" } });
  let first: any;
  try { await generateStudioText(options); } catch (error) { first = error; }
  expect(first).toMatchObject({ provenance: { ...provenance, status: "truncated" }, promptTrace: { toolName: "save_studio_draft" } });
  let second: any;
  try { await generateStudioText({ ...options, directive: "바뀐 사용자 지시" }); } catch (error) { second = error; }
  expect(second.promptTrace.inputSha256).not.toBe(first.promptTrace.inputSha256);
  expect(mock.callTool).toHaveBeenCalledTimes(2);
});
