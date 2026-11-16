// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyEditorialVoiceProfile } from "../shared/editorialVoice";
const mocked = vi.hoisted(() => ({ api: vi.fn(), guard: { setDirty: vi.fn() } }));
vi.mock("../client/src/api", () => ({ api: mocked.api }));
vi.mock("../client/src/state", () => ({ useDirtyGuard: () => mocked.guard }));
const { SnsVoiceMemory } = await import("../client/src/SnsVoiceMemory");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); mocked.api.mockResolvedValue(emptyEditorialVoiceProfile()); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async (enabled: boolean) => { await act(async () => root.render(createElement(SnsVoiceMemory, { channelKey: "highscoop", currentText: "지금 선택한 실제 문구", enabled }))); };
async function setFirst(value: string) { await act(async () => { const node = host.querySelector("textarea")!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); }); }
it("does not fetch or learn while disabled, and only saves after the explicit memory button", async () => {
  await render(false); expect(mocked.api).not.toHaveBeenCalled();
  await render(true); expect(mocked.api).toHaveBeenCalledTimes(1);
  await setFirst("제목의 좋은 비유는 그대로 유지해 주세요.");
  expect(mocked.api).toHaveBeenCalledTimes(1);
  const pick = [...host.querySelectorAll("button")].find(button => button.textContent === "현재 문구를 사례로 가져오기")!;
  await act(async () => pick.click()); expect(mocked.api).toHaveBeenCalledTimes(1);
  mocked.api.mockResolvedValueOnce({ ...emptyEditorialVoiceProfile(), profileRevision: 1 });
  const save = [...host.querySelectorAll("button")].find(button => button.textContent === "다음 글에도 이 기준 기억")!;
  await act(async () => save.click());
  expect(mocked.api.mock.calls[1]).toMatchObject(["/studio/editorial-voice/highscoop/feedback", { method: "POST", body: { expectedRevision: 0, rule: "제목의 좋은 비유는 그대로 유지해 주세요.", approvedText: "지금 선택한 실제 문구" } }]);
  expect(host.textContent).toContain("v1에 저장했습니다");
});
it("keeps an unsaved correction when the workbench is closed and opened again", async () => {
  await render(true); await setFirst("아직 저장하지 않은 내 교정 기준");
  await render(false); await render(true);
  expect(host.querySelector("textarea")!.value).toBe("아직 저장하지 않은 내 교정 기준");
  expect(mocked.guard.setDirty.mock.calls.some(call => call[1] === true)).toBe(true);
});
