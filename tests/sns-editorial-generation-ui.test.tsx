// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SnsEditorialGeneration, type SnsEditorialTarget } from "../client/src/SnsEditorialGeneration";
import { ApiError } from "../client/src/api";
import type { SnsEditorialInput } from "../shared/snsEditorial";
import type { SnsEditorialDraftReply } from "../shared/snsEditorialDraft";

const mocks = vi.hoisted(() => ({ api: vi.fn(), guard: { setDirty: vi.fn() }, apply: vi.fn() }));
vi.mock("../client/src/api", async original => ({ ...await original<object>(), api: mocks.api }));
vi.mock("../client/src/state", () => ({ useDirtyGuard: () => mocks.guard }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root;
const input = (): SnsEditorialInput => ({ task: "reel_script", topic: "공중에서 로켓을 잡았다", audience: "중학생과 부모", format: "릴스", channel: "highscoop", referenceText: "공식 회수 장면", existingText: "현재 작성 중인 원고", instruction: "완료한 사건의 시제를 유지하세요." });
const proposal = (): SnsEditorialDraftReply => ({ hooks: [{ angle: "장면", text: "로켓을 공중에서 붙잡았다", reason: "확인된 장면을 먼저 보여줍니다." }], sections: [{ label: "첫 장면", text: "붙잡는 순간부터 보여 주세요." }], finalCopy: "확인한 회수 장면입니다. 이렇게 붙잡으면 무엇이 달라질까요?", checks: ["완료 시제와 발사체 명칭을 원문에 대조하세요."], task: "reel_script", provider: "gemini", model: "test-model", promptVersion: "test-v1", usage: { inputTokens: 10, outputTokens: 30 }, promptTrace: { toolName: "sns_editorial", inputSha256: "test" }, jobId: 41, cardVersion: 7 });
beforeEach(() => { vi.clearAllMocks(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(value = input(), target: SnsEditorialTarget = { id: 18, version: 7 }) { await act(async () => root.render(createElement(SnsEditorialGeneration, { input: value, target, disabled: false, onApply: { title: mocks.apply, script: mocks.apply, caption: mocks.apply } }))); }
function button(label: string) { const node = [...host.querySelectorAll("button")].find(value => value.textContent === label); if (!node) throw new Error(`Missing button: ${label}`); return node; }
async function click(label: string) { expect(button(label).disabled).toBe(false); await act(async () => button(label).click()); }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe("in-app SNS writing proposals", () => {
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
