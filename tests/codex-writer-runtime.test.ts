import { expect, it, vi } from "vitest";
import { CODEX_WRITER_EFFORT, CODEX_WRITER_MODEL, CODEX_WRITER_OUTPUT_SCHEMA, type CodexWriterClaim } from "../shared/codexWriter";
import { codexArgs, isolatedCodexEnv, writeAndReview, WriterRuntimeError, type Invoker } from "../local-writer/codexRuntime";

const aspects = ["source", "conditions", "voice", "flow", "scope"] as const;
const claim = (): CodexWriterClaim => ({ jobId: 1, leaseId: "6ea08ccf-9483-4e72-a966-39337f7f03c1", cardId: 1, requestId: "9b27a82d-b3a3-44d5-9968-7b33cf4ed9ce", task: "carousel_plan",
  prompt: "원래 근거: 제공한 행사일만 사용. 사용자가 확정한 제목: 빛을 들어요. 마지막 질문만 수정.", model: CODEX_WRITER_MODEL, effort: CODEX_WRITER_EFFORT, outputSchema: CODEX_WRITER_OUTPUT_SCHEMA });
const draft = (copy = "확정 표현을 유지한 문구") => ({ hooks: [], sections: [{ label: "본문", text: copy }], finalCopy: copy, checks: ["제공 자료의 시제 확인"] });
const review = (status: "ready" | "needs_revision" | "needs_source" = "ready") => ({ passed: status === "ready", status,
  issues: status === "ready" ? [] : [status === "needs_source" ? "행사일 근거가 필요합니다." : "마지막 질문만 더 구체적으로 고쳐 주세요."],
  checks: aspects.map(aspect => ({ aspect, status: status === "ready" || aspect !== (status === "needs_source" ? "source" : "scope") ? "pass" : status === "needs_source" ? "not_checked" : "revise", detail: `${aspect} 제공 자료 대조` })) });
const answer = (value: unknown) => ({ value, usage: { inputTokens: 10, outputTokens: 5 } });

it("forwards only platform paths to the local Codex process, not bridge credentials or API keys", () => {
  const result = isolatedCodexEnv({ PATH: "C:/bin", USERPROFILE: "C:/Users/operator", SYSTEMROOT: "C:/Windows", TEMP: "C:/Temp", OPENAI_API_KEY: "private-api", CODEX_API_KEY: "private-codex-api", APP_SESSION_SECRET: "private-session", STUDIO_CODEX_WRITER_TOKEN_SHA256: "private-bridge", DATABASE_URL: "private-db", CODEX_HOME: "unreviewed-config-home", HTTPS_PROXY: "unreviewed-proxy" });
  expect(result).toEqual({ PATH: "C:/bin", USERPROFILE: "C:/Users/operator", SYSTEMROOT: "C:/Windows", TEMP: "C:/Temp" });
  expect(JSON.stringify(result)).not.toContain("private");
});
it("fixes the selected model and effort while disabling shell, apps, web search, hooks and agent tools", () => {
  const args = codexArgs("C:/isolated", "C:/isolated/schema.json", "C:/isolated/result.json");
  expect(args).toContain("--ignore-user-config"); expect(args).toContain("--ephemeral");
  expect(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2)).toEqual(["--sandbox", "read-only"]);
  expect(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2)).toEqual(["-m", CODEX_WRITER_MODEL]);
  expect(args).toContain(`model_reasoning_effort="${CODEX_WRITER_EFFORT}"`);
  for (const key of ["shell_tool", "apps", "multi_agent", "view_image", "hooks", "goals"]) expect(args).toContain(`features.${key}=false`);
  expect(args).toContain('web_search="disabled"'); expect(args.at(-1)).toBe("-");
  expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
});
it("runs a separate writer and five-aspect reviewer, then returns the reviewed proposal without extra calls", async () => {
  const invoke = vi.fn<Invoker>().mockResolvedValueOnce(answer(draft())).mockResolvedValueOnce(answer(review()));
  const phases: string[] = [];
  const result = await writeAndReview(claim(), invoke, new AbortController().signal, async phase => { phases.push(phase); });
  expect(invoke).toHaveBeenCalledTimes(2); expect(phases).toEqual(["draft", "review"]);
  expect(result.qualityReview).toMatchObject({ passed: true, status: "ready", revisionsApplied: [] });
  expect(new Set(result.qualityReview.checks?.map(check => check.aspect))).toEqual(new Set(aspects));
  expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  expect(invoke.mock.calls[1][0]).toContain(claim().prompt);
  expect(invoke.mock.calls[1][0]).toContain(draft().finalCopy);
  expect(invoke.mock.calls[1][0]).toContain("실세계 진위 확인과 제공 자료의 일치 검토를 구분");
});
it("asks for missing evidence instead of inventing facts or blindly rewriting until the review passes", async () => {
  const invoke = vi.fn<Invoker>().mockResolvedValueOnce(answer(draft())).mockResolvedValueOnce(answer(review("needs_source")));
  const result = await writeAndReview(claim(), invoke, new AbortController().signal, async () => {});
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(result.qualityReview).toMatchObject({ passed: false, status: "needs_source" });
  expect(result.output).toEqual(draft());
});
it("uses the same original facts and locked wording for one bounded correction and re-review", async () => {
  const invoke = vi.fn<Invoker>().mockResolvedValueOnce(answer(draft("초안"))).mockResolvedValueOnce(answer(review("needs_revision")))
    .mockResolvedValueOnce(answer(draft("교정한 문구"))).mockResolvedValueOnce(answer(review()));
  const phases: string[] = [];
  const result = await writeAndReview(claim(), invoke, new AbortController().signal, async phase => { phases.push(phase); });
  expect(invoke).toHaveBeenCalledTimes(4); expect(phases).toEqual(["draft", "review", "revision", "review"]);
  expect(invoke.mock.calls[2][0]).toContain(claim().prompt);
  expect(invoke.mock.calls[2][0]).toContain("마지막 질문만 더 구체적으로");
  expect(invoke.mock.calls[3][0]).toContain(claim().prompt);
  expect(result.output.finalCopy).toBe("교정한 문구"); expect(result.qualityReview.passed).toBe(true);
  expect(result.qualityReview.revisionsApplied).toHaveLength(1);
});
it("stops after four model runs when a correction still fails, preserving the failed-review state", async () => {
  const invoke = vi.fn<Invoker>().mockResolvedValueOnce(answer(draft())).mockResolvedValueOnce(answer(review("needs_revision")))
    .mockResolvedValueOnce(answer(draft("아직 검토할 문구"))).mockResolvedValueOnce(answer(review("needs_revision")));
  const result = await writeAndReview(claim(), invoke, new AbortController().signal, async () => {});
  expect(invoke).toHaveBeenCalledTimes(4);
  expect(result.qualityReview).toMatchObject({ passed: false, status: "needs_revision", revisionsApplied: [] });
});
it("rejects duplicate review aspects rather than calling five duplicate passes a complete review", async () => {
  const duplicate = { ...review(), checks: aspects.map(() => ({ aspect: "source", status: "pass", detail: "같은 항목 반복" })) };
  const invoke = vi.fn<Invoker>().mockResolvedValueOnce(answer(draft())).mockResolvedValueOnce(answer(duplicate));
  await expect(writeAndReview(claim(), invoke, new AbortController().signal, async () => {})).rejects.toMatchObject({ reason: "invalid_output" });
  expect(invoke).toHaveBeenCalledTimes(2);
});
it("rejects invalid structured output and performs no provider fallback or automatic retry", async () => {
  const invoke = vi.fn<Invoker>().mockResolvedValueOnce(answer({ ...draft(), algorithmScore: 100 }));
  await expect(writeAndReview(claim(), invoke, new AbortController().signal, async () => {})).rejects.toThrow();
  expect(invoke).toHaveBeenCalledOnce();
  const failed = vi.fn<Invoker>().mockRejectedValue(new WriterRuntimeError("timeout"));
  await expect(writeAndReview(claim(), failed, new AbortController().signal, async () => {})).rejects.toMatchObject({ reason: "timeout" });
  expect(failed).toHaveBeenCalledOnce();
});
it("honors cancellation between stages and rejects a model or effort changed by the claim payload", async () => {
  const controller = new AbortController(), invoke = vi.fn<Invoker>().mockResolvedValueOnce(answer(draft()));
  await expect(writeAndReview(claim(), invoke, controller.signal, async phase => { if (phase === "review") controller.abort(); })).rejects.toThrow();
  expect(invoke).toHaveBeenCalledOnce();
  const untouched = vi.fn<Invoker>();
  await expect(writeAndReview({ ...claim(), model: "different-model" }, untouched, new AbortController().signal, async () => {})).rejects.toMatchObject({ reason: "invalid_output" });
  expect(untouched).not.toHaveBeenCalled();
});
