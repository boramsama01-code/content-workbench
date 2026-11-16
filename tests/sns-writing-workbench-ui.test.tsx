// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { studioContentSchema, type StudioContent } from "../shared/studio";
import { SnsWritingWorkbench } from "../client/src/SnsWritingWorkbench";
import { activateDraftRecoveryScope } from "../client/src/draftRecovery";

vi.mock("../client/src/ChatGptLaunch", () => ({ ChatGptLaunch: ({ prompt, disabled }: { prompt: string; disabled: boolean }) =>
  createElement("div", {}, createElement("textarea", { "aria-label": "실제 작업 요청", readOnly: true, value: prompt }), createElement("button", { disabled }, "요청 보내기")) }));
const mocks = vi.hoisted(() => ({ guard: { setDirty: vi.fn() } }));
vi.mock("../client/src/state", () => ({ useDirtyGuard: () => mocks.guard }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, client: QueryClient;
const initial = (): StudioContent => studioContentSchema.parse({ title: "공중에서 우주선을 잡았다", channel: "highscoop", format: "릴스", script: "확인한 로켓 회수 장면입니다.", caption: "우주선을 공중에서 붙잡았어요. 어떻게 가능했을까요?", sourceLabel: "공식 발사 기록", memo: "공개하지 않은 기획 메모 7311" });
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); client = new QueryClient(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
async function render(content = initial(), disabled = false, recoveryKey?: string) { await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(SnsWritingWorkbench, { content, channelName: "HighScoop", disabled, recoveryKey })))); }
function field(label: string) {
  const node = [...host.querySelectorAll("label")].find(item => item.textContent?.startsWith(label));
  if (!node) throw new Error(`Missing field: ${label}`);
  return host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[id="${node.htmlFor}"]`)!;
}
async function input(label: string, value: string) {
  const node = field(label);
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
function request() { return host.querySelector<HTMLTextAreaElement>('textarea[aria-label="실제 작업 요청"]')!.value; }

describe("SNS writing workbench", () => {
  it("prepares a task from the latest current copy while keeping private planning notes opt-in", async () => {
    const content = initial(); await render(content);
    expect(field("무엇을 할까요?").querySelectorAll("option")).toHaveLength(13);
    expect(field("무엇을 할까요?").value).toBe("reel_script");
    expect(request()).toContain(content.script);
    expect(request()).toContain(content.caption);
    expect(request()).toContain(content.sourceLabel);
    expect(request()).not.toContain(content.memo);
    const memoToggle = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1];
    await act(async () => memoToggle.click()); expect(request()).toContain(content.memo);
    await act(async () => memoToggle.click()); expect(request()).not.toContain(content.memo);
    expect(content).toEqual(initial());
  });

  it("preserves custom instructions, topic and sources when changing between creation and DM draft tasks", async () => {
    await render();
    await input("주제", "게임을 좋아하는 아이의 관찰력");
    await input("누가 읽나요?", "게임 때문에 고민하는 부모");
    await input("확인한 사실·원문·분석 수치", "게임을 직접 관찰한 사례만 사용하세요.");
    await input("더 다듬고 싶은 점", "짧고 다정하게. 없는 경험은 쓰지 마세요.");
    await input("무엇을 할까요?", "dm_draft");
    expect(field("주제").value).toBe("게임을 좋아하는 아이의 관찰력");
    expect(field("누가 읽나요?").value).toBe("게임 때문에 고민하는 부모");
    expect(request()).toContain("게임을 직접 관찰한 사례만 사용하세요.");
    expect(request()).toContain("짧고 다정하게. 없는 경험은 쓰지 마세요.");
    await input("무엇을 할까요?", "carousel_plan");
    expect(field("확인한 사실·원문·분석 수치").value).toBe("게임을 직접 관찰한 사례만 사용하세요.");
  });

  it("uses updated unsaved source fields without resetting the operator's custom topic", async () => {
    const content = initial(); await render(content);
    await input("주제", "유지할 직접 쓴 주제");
    await render({ ...content, title: "제목의 최신 수정", script: "저장 전 최신 본문입니다.", caption: "수정한 캡션의 최신 첫 문장" });
    expect(field("주제").value).toBe("유지할 직접 쓴 주제");
    expect(request()).toContain("저장 전 최신 본문입니다.");
    expect(request()).toContain("제목의 최신 수정");
    expect(host.querySelector(".sns-caption-preview")?.textContent).toContain("수정한 캡션의 최신 첫 문장");
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(request()).not.toContain("저장 전 최신 본문입니다.");
  });

  it("shows a character-safe 125-character editorial preview and disables launch while another job owns the draft", async () => {
    const content = { ...initial(), caption: "😀".repeat(130) };
    await render(content, true);
    expect(host.querySelector(".sns-caption-preview")?.firstChild?.textContent).toBe("😀".repeat(125));
    expect(host.textContent).toContain("실제 표시 길이는 기기와 화면에 따라 달라집니다.");
    expect([...host.querySelectorAll("input,select")].every(node => (node as HTMLInputElement).disabled)).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
    expect(host.textContent).not.toContain("81.4");
  });

  it("retains oversized input and shows a recoverable warning instead of crashing or silently shortening the draft", async () => {
    const content = { ...initial(), script: "가".repeat(24000) }; await render(content);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("입력 내용은 유지했습니다");
    expect(request()).toBe("");
    expect(content.script).toHaveLength(24000);
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(request()).toContain("공중에서 우주선을 잡았다");
  });

  it("recovers task inputs after reopening without saving or re-including the private planning memo", async () => {
    const scope = "sns-workbench-recovery-001"; activateDraftRecoveryScope(scope); client.setQueryData(["me"], { user: "operator", recoveryScope: scope });
    await render(initial(), false, "studio:18");
    await input("주제", "복구할 주제"); await input("확인한 사실·원문·분석 수치", "복구할 직접 입력 근거");
    await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click());
    expect(JSON.stringify(localStorage)).not.toContain(initial().memo);
    await act(async () => root.unmount()); root = createRoot(host);
    await render(initial(), false, "studio:18");
    expect(host.querySelector('[aria-label="글쓰기 작업실 기기 복구본"]')).not.toBeNull();
    const restore = [...host.querySelectorAll("button")].find(node => node.textContent === "작업실 입력 복구")!;
    await act(async () => restore.click());
    expect(field("주제").value).toBe("복구할 주제");
    expect(field("확인한 사실·원문·분석 수치").value).toBe("복구할 직접 입력 근거");
    expect(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].checked).toBe(false);
    expect(request()).not.toContain(initial().memo);
    expect(mocks.guard.setDirty.mock.calls.some(([, dirty]) => dirty)).toBe(true);
  });
});
