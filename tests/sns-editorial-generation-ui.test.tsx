// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SnsEditorialGeneration, type SnsEditorialTarget } from "../client/src/SnsEditorialGeneration";
import { ApiError } from "../client/src/api";
import type { SnsEditorialInput } from "../shared/snsEditorial";
import type { SnsEditorialDraftReply } from "../shared/snsEditorialDraft";
import type { CodexWriterResult, CodexWriterJobView } from "../shared/codexWriter";

const mocks = vi.hoisted(() => ({ api: vi.fn(), guard: { setDirty: vi.fn() }, apply: vi.fn() }));
vi.mock("../client/src/api", async original => ({ ...await original<object>(), api: mocks.api }));
vi.mock("../client/src/state", () => ({ useDirtyGuard: () => mocks.guard }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root;
const input = (): SnsEditorialInput => ({ task: "reel_script", topic: "공중에서 로켓을 잡았다", audience: "중학생과 부모", format: "릴스", channel: "highscoop", referenceText: "공식 회수 장면", existingText: "현재 작성 중인 원고", instruction: "완료한 사건의 시제를 유지하세요." });
const proposal = (): SnsEditorialDraftReply => ({ hooks: [{ angle: "장면", text: "로켓을 공중에서 붙잡았다", reason: "확인된 장면을 먼저 보여줍니다." }], sections: [{ label: "첫 장면", text: "붙잡는 순간부터 보여 주세요." }], finalCopy: "확인한 회수 장면입니다. 이렇게 붙잡으면 무엇이 달라질까요?", checks: ["완료 시제와 발사체 명칭을 원문에 대조하세요."], task: "reel_script", provider: "gemini", model: "test-model", promptVersion: "test-v1", usage: { inputTokens: 10, outputTokens: 30 }, promptTrace: { toolName: "sns_editorial", inputSha256: "test" }, jobId: 41, cardVersion: 7 });
beforeEach(() => { vi.clearAllMocks(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
async function render(value = input(), target: SnsEditorialTarget = { id: 18, version: 7 }, active = false) { await act(async () => root.render(createElement(SnsEditorialGeneration, { input: value, target, disabled: false, active, onApply: { title: mocks.apply, script: mocks.apply, caption: mocks.apply } }))); }
function button(label: string) { const node = [...host.querySelectorAll("button")].find(value => value.textContent === label); if (!node) throw new Error(`Missing button: ${label}`); return node; }
async function click(label: string) { expect(button(label).disabled).toBe(false); await act(async () => button(label).click()); }
async function feedback(value: string) { const field = host.querySelector<HTMLTextAreaElement>('[aria-label="이 안에서 바꿀 점"]')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field,value); field.dispatchEvent(new Event("input", { bubbles:true })); }); }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const connected = () => ({ configured:true, online:true, lastSeenAt:"2026-11-16T03:00:00Z", model:"gpt-6.1-sol", deviceName:"작업용 PC" });
const codexResult = (): CodexWriterResult => { const { usage:_usage,...base } = proposal(); return { ...base, writer:"codex", provider:"openai", model:"gpt-6.1-sol", usageStatus:"usage_unknown", qualityReview:{ passed:true, issues:[], revisionsApplied:["첫 문장을 구체적인 장면으로 수정했습니다."] } }; };
const codexJob = (status: CodexWriterJobView["status"] = "queued"): CodexWriterJobView => ({ jobId:51, requestId:"00000000-0000-4000-8000-000000000051", cardVersion:7, status, phase:status === "running" ? "review" : null, error:null, result:status === "succeeded" ? codexResult() : null });
async function writer(value:"api"|"codex") { const field = host.querySelector<HTMLSelectElement>('[aria-label="작성 방식"]')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(field,value); field.dispatchEvent(new Event("change",{ bubbles:true })); }); }

describe("in-app SNS writing proposals", () => {
  it.each([false,undefined])("keeps Codex copy available but blocks applying an unpassed or missing quality review (%s)",async passed => {
    const output = {...codexResult(),qualityReview:passed === undefined ? undefined : {passed,issues:["원문 조건 확인 필요"],revisionsApplied:[]}};
    mocks.api.mockImplementation(async (path:string) => path === "/studio/codex-writer/status" ? connected() : {...codexJob("succeeded"),result:output});
    await render(input(),{id:18,version:7},true);await click("스튜디오에서 제안 받기");
    expect(button("전체 원고에 반영").disabled).toBe(true);expect(button("제목에 반영").disabled).toBe(true);
    expect(button("최종 문구 복사").disabled).toBe(false);expect(host.textContent).toContain("수정·근거 확인이 필요합니다");
  });
  it("defaults to connected local Codex and polls queued work without making an API generation call", async () => {
    vi.useFakeTimers(); let polls = 0;
    mocks.api.mockImplementation(async (path:string,options?:{method?:string}) => {
      if (path === "/studio/codex-writer/status") return connected();
      if (path === "/studio/cards/18/codex-draft" && options?.method === "POST") return codexJob();
      if (path.startsWith("/studio/cards/18/codex-draft/")) return codexJob(++polls === 1 ? "running" : "succeeded");
      throw new Error(`Unexpected route ${path}`);
    });
    await render(input(),{ id:18,version:7 },true);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="작성 방식"]')!.value).toBe("codex");
    expect(host.textContent).toContain("한 작업에 최대 4회 작성·검토");
    expect(host.textContent).toContain("각 단계가 Codex 사용 한도에 반영됩니다");
    await click("스튜디오에서 제안 받기");
    expect(host.textContent).toContain("Codex 작업 대기 중");
    await act(async () => vi.advanceTimersByTimeAsync(3000)); expect(host.textContent).toContain("review");
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    const result = host.querySelector('[aria-label="글쓰기 제안 결과"]')!;
    expect(result.textContent).toContain("Codex · 이 PC · gpt-6.1-sol");
    expect(result.textContent).toContain("Codex 자체 검토 기록");
    expect(mocks.api.mock.calls.some(([path]) => path.endsWith("/editorial-draft"))).toBe(false);
    expect(mocks.api.mock.calls.find(([path,options]) => path.endsWith("/codex-draft") && options?.method === "POST")![1].body.provider).toBeUndefined();
    expect(mocks.apply).not.toHaveBeenCalled();
    await click("전체 원고에 반영"); expect(mocks.apply).toHaveBeenCalledWith(codexResult().finalCopy);
  });

  it("preserves a deliberate API selection when the Codex status arrives later", async () => {
    const status = deferred<ReturnType<typeof connected>>();
    mocks.api.mockImplementation((path:string) => path === "/studio/codex-writer/status" ? status.promise : Promise.resolve(proposal()));
    await render(input(),{ id:18,version:7 },true); await writer("api");
    await act(async () => status.resolve(connected()));
    expect(host.querySelector<HTMLSelectElement>('[aria-label="작성 방식"]')!.value).toBe("api");
    await click("스튜디오에서 제안 받기");
    expect(mocks.api.mock.calls.some(([path]) => path === "/studio/cards/18/editorial-draft")).toBe(true);
    expect(mocks.api.mock.calls.some(([path]) => path === "/studio/cards/18/codex-draft")).toBe(false);
  });

  it("shows an offline Codex worker and lets the operator explicitly choose API instead", async () => {
    mocks.api.mockImplementation(async (path:string) => path === "/studio/codex-writer/status" ? { ...connected(),online:false } : proposal());
    await render(input(),{ id:18,version:7 },true); await writer("codex");
    expect(button("스튜디오에서 제안 받기").disabled).toBe(true);
    expect(host.textContent).toContain("Codex 작업기가 연결되지 않았습니다");
    expect(mocks.api.mock.calls.filter(([,options]) => options?.method === "POST")).toHaveLength(0);
    await writer("api"); await click("스튜디오에서 제안 받기");
    expect(mocks.api.mock.calls.some(([path]) => path === "/studio/cards/18/editorial-draft")).toBe(true);
  });

  it("rechecks an uncertain Codex queue submission in the original writer mode with the exact body", async () => {
    let submissions = 0;
    mocks.api.mockImplementation(async (path:string) => {
      if (path === "/studio/codex-writer/status") return connected();
      if (path === "/studio/cards/18/codex-draft") { if (++submissions === 1) throw new ApiError(0,"큐 응답을 확인하지 못했습니다."); return codexJob("succeeded"); }
      throw new Error(`Unexpected route ${path}`);
    });
    await render(input(),{ id:18,version:7 },true); await click("스튜디오에서 제안 받기");
    const first = structuredClone(mocks.api.mock.calls.find(([path]) => path === "/studio/cards/18/codex-draft")![1].body);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="작성 방식"]')!.disabled).toBe(true);
    await click("같은 요청 결과 다시 확인");
    expect(mocks.api.mock.calls.filter(([path]) => path === "/studio/cards/18/codex-draft")[1][1].body).toEqual(first);
    expect(button("전체 원고에 반영").disabled).toBe(false);
  });

  it("cancels a queued Codex job through its own endpoint and stops subsequent polling", async () => {
    vi.useFakeTimers();
    mocks.api.mockImplementation(async (path:string) => path === "/studio/codex-writer/status" ? connected() : path.endsWith("/cancel") ? codexJob("cancelled") : codexJob());
    await render(input(),{ id:18,version:7 },true); await click("스튜디오에서 제안 받기");
    const request = mocks.api.mock.calls.find(([path]) => path === "/studio/cards/18/codex-draft")![1].body;
    await click("요청 중단"); await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(mocks.api.mock.calls.some(([path]) => path === `/studio/cards/18/codex-draft/${request.requestId}/cancel`)).toBe(true);
    expect(mocks.api.mock.calls.some(([path]) => path === `/studio/cards/18/codex-draft/${request.requestId}`)).toBe(false);
    expect(host.textContent).toContain("요청 중단을 확인했습니다");
    expect(host.querySelector('[aria-label="글쓰기 제안 결과"]')).toBeNull();
  });
  it("refines the previous proposal only after feedback and an explicit new request, while retaining the original fact bank", async () => {
    const first = { ...proposal(), finalCopy:"첫 번째 AI 편집 초안입니다." };
    const second = { ...proposal(), finalCopy:"두 번째로 다듬은 문구입니다." };
    const third = { ...proposal(), finalCopy:"세 번째로 다듬은 문구입니다." };
    mocks.api.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(third);
    await render(); await click("스튜디오에서 제안 받기");
    await click("이 훅으로 이어 다듬기"); await feedback("부모가 바로 이해할 구체적인 행동을 넣어 주세요.");
    expect(mocks.api).toHaveBeenCalledTimes(1); expect(mocks.apply).not.toHaveBeenCalled();
    await click("이 제안에서 이어 다듬기");
    const original = mocks.api.mock.calls[0][1].body, refined = mocks.api.mock.calls[1][1].body;
    expect(refined.requestId).not.toBe(original.requestId);
    expect(refined.referenceText).toBe(original.referenceText);
    expect(refined.existingText).toContain(original.existingText);
    expect(refined.existingText).toContain(first.finalCopy);
    expect(refined.existingText).toContain("사실 근거가 아님");
    expect(refined.instruction).toContain(original.instruction);
    expect(refined.instruction).toContain("부모가 바로 이해할 구체적인 행동");
    expect(refined.instruction).toContain(first.hooks[0].text);
    expect(button("전체 원고에 반영").disabled).toBe(false);
    expect(host.textContent).not.toContain("제안을 받은 뒤 입력이나 원고가 바뀌었습니다");
    await feedback("마지막 문장을 더 짧게 해 주세요."); await click("이 제안에서 이어 다듬기");
    const next = mocks.api.mock.calls[2][1].body;
    expect(next.referenceText).toBe(original.referenceText);
    expect(next.existingText).toContain(second.finalCopy);
    expect(next.existingText).not.toContain(first.finalCopy);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("rechecks an uncertain refinement with its exact body and original context signature", async () => {
    mocks.api.mockResolvedValueOnce(proposal()).mockRejectedValueOnce(new ApiError(0,"수정 결과 확인 불가",{ resultUnknown:true })).mockResolvedValueOnce({ ...proposal(), finalCopy:"다시 확인한 수정 결과" });
    await render(); await click("스튜디오에서 제안 받기"); await feedback("첫 문장을 살리고 뒤 설명을 짧게 해 주세요.");
    await click("이 제안에서 이어 다듬기");
    const request = structuredClone(mocks.api.mock.calls[1][1].body);
    await click("같은 요청 결과 다시 확인");
    expect(mocks.api.mock.calls[2][1].body).toEqual(request);
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="제안한 최종 문구"]')!.value).toBe("다시 확인한 수정 결과");
    expect(button("전체 원고에 반영").disabled).toBe(false);
    expect(host.textContent).not.toContain("제안을 받은 뒤 입력이나 원고가 바뀌었습니다");
  });

  it("blocks refinement when the editor context changes and keeps the feedback available", async () => {
    mocks.api.mockResolvedValue(proposal()); await render(); await click("스튜디오에서 제안 받기"); await feedback("유지할 수정 메모");
    await render({ ...input(), existingText:"생성 뒤 바뀐 실제 원고" });
    expect(button("이 제안에서 이어 다듬기").disabled).toBe(true);
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="이 안에서 바꿀 점"]')!.value).toBe("유지할 수정 메모");
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label:"combined draft", data:{ ...input(), existingText:"원".repeat(23000) }, result:{ ...proposal(), finalCopy:"안".repeat(3000) }, note:"유지할 수정 요청", expected:"24,000자" },
    { label:"combined instruction", data:{ ...input(), instruction:"지".repeat(7990) }, result:proposal(), note:"유지할 수정 요청", expected:"8,000자" },
  ])("keeps an oversized $label intact and stops before another provider request", async ({data,result,note,expected}) => {
    mocks.api.mockResolvedValue(result); await render(data); await click("스튜디오에서 제안 받기"); await feedback(note); await click("이 제안에서 이어 다듬기");
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(expected);
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="이 안에서 바꿀 점"]')!.value).toBe(note);
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="제안한 최종 문구"]')!.value).toBe(result.finalCopy);
  });
  it("keeps caption opening variants as copy choices instead of offering to overwrite the title", async () => {
    mocks.api.mockResolvedValue({ ...proposal(), task: "caption_review" });
    await render({ ...input(), task: "caption_review" });
    await click("스튜디오에서 제안 받기");
    expect([...host.querySelectorAll("button")].some(node => node.textContent === "제목에 반영")).toBe(false);
    expect(button("이 훅 복사").disabled).toBe(false);
    expect(button("캡션에 반영").disabled).toBe(false);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("deduplicates a double click and applies only after the operator chooses a specific result", async () => {
    const pending = deferred<SnsEditorialDraftReply>(); mocks.api.mockReturnValue(pending.promise);
    await render(); expect(mocks.api).not.toHaveBeenCalled();
    await act(async () => { button("스튜디오에서 제안 받기").click(); button("스튜디오에서 제안 받기").click(); });
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.api.mock.calls[0][1].body).toMatchObject({ version: 7, task: "reel_script", provider: "gemini", requestId: expect.any(String) });
    await act(async () => pending.resolve(proposal()));
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="제안한 최종 문구"]')!.value).toBe(proposal().finalCopy);
    await click("전체 원고에 반영"); expect(mocks.apply).toHaveBeenCalledWith(proposal().finalCopy);
  });

  it("keeps a late proposal visible but prevents applying it to a changed draft", async () => {
    const pending = deferred<SnsEditorialDraftReply>(); mocks.api.mockReturnValue(pending.promise);
    await render(); await click("스튜디오에서 제안 받기");
    await render({ ...input(), existingText: "생성 중 직접 수정한 원고" });
    await act(async () => pending.resolve(proposal()));
    expect(host.textContent).toContain("제안을 받은 뒤 입력이나 원고가 바뀌었습니다");
    expect(button("전체 원고에 반영").disabled).toBe(true);
    expect(button("제목에 반영").disabled).toBe(true);
    expect(button("최종 문구 복사").disabled).toBe(false);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("rechecks an uncertain response with the exact same request ID and input rather than making another paid request", async () => {
    mocks.api.mockRejectedValueOnce(new ApiError(0, "결과 확인 불가", { resultUnknown: true })).mockResolvedValueOnce(proposal());
    await render(); await click("스튜디오에서 제안 받기");
    const original = structuredClone(mocks.api.mock.calls[0][1].body);
    await render({ ...input(), topic: "사용자가 이후 변경한 주제", existingText: "새 원고" });
    await click("같은 요청 결과 다시 확인");
    expect(mocks.api.mock.calls[1][1].body).toEqual(original);
    expect(button("전체 원고에 반영").disabled).toBe(true);
    expect(host.textContent).toContain("최신 내용으로 다시 제안받으면");
  });

  it("loads the canonical Studio version for source cards only on an explicit generation click", async () => {
    mocks.api.mockImplementation(async (path: string) => path === "/studio/cards/18" ? { card: { id: 18, version: 24 } } : proposal());
    await render(input(), { id: 18, provider: "openai" }); expect(mocks.api).not.toHaveBeenCalled();
    await click("스튜디오에서 제안 받기");
    expect(mocks.api.mock.calls.map(call => call[0])).toEqual(["/studio/cards/18", "/studio/cards/18/editorial-draft"]);
    expect(mocks.api.mock.calls[1][1].body).toMatchObject({ version: 24, provider: "openai" });
  });

  it("cancels the same request and ignores a provider result that arrives after cancellation", async () => {
    const pending = deferred<SnsEditorialDraftReply>();
    mocks.api.mockImplementation((path: string) => path.endsWith("/cancel") ? Promise.resolve({ cancelled: true }) : pending.promise);
    await render(); await click("스튜디오에서 제안 받기");
    const sent = mocks.api.mock.calls[0][1]; await click("요청 중단");
    expect(sent.signal.aborted).toBe(true);
    expect(mocks.api.mock.calls[1][0]).toBe(`/studio/cards/18/editorial-draft/${sent.body.requestId}/cancel`);
    await act(async () => pending.resolve(proposal()));
    expect(host.querySelector('[aria-label="글쓰기 제안 결과"]')).toBeNull();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(host.textContent).toContain("요청 중단을 확인했습니다");
  });
});
