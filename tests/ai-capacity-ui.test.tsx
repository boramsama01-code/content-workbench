// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AiCapacityPanel } from "../client/src/AiCapacityPanel";
import type { AiCapacity } from "../shared/aiCapacity";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../client/src/api", () => ({ api: mocks.api }));
vi.mock("../client/src/ui", () => ({ GuardedLink: ({ href, children }: { href: string; children: React.ReactNode }) => createElement("a", { href }, children) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root, client: QueryClient;
const capacity = (channelId = 3, model = "gpt-image-channel"): AiCapacity => ({ channelId, analysis: { provider: "openai", model: "gpt-analysis-selected", keyConfigured: true }, image: { provider: "openai", model, keyConfigured: true }, studioDailyImageLimit: null, providerRemainingTokens: null, providerRemainingImages: null, latestFailure: null });
beforeEach(() => {
  mocks.api.mockReset(); mocks.api.mockImplementation(async (path: string) => capacity(Number(new URL(path, "https://studio.example").searchParams.get("channelId"))));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
async function render(channelId = 3, plannedImages = 2) {
  await act(async () => { root.render(createElement(QueryClientProvider, { client }, createElement(AiCapacityPanel, { channelId, analysisProvider: "openai", showAnalysis: true, plannedImages }))); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
async function input(label: string, value: string) {
  const id = [...host.querySelectorAll("label")].find(node => node.textContent?.startsWith(label))?.htmlFor;
  const element = document.getElementById(id!) as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
}
it("shows resolved model and unknown account remainder without promising availability", async () => {
  await render();
  expect(host.textContent).toContain("gpt-image-channel");
  expect(host.textContent).toContain("gpt-analysis-selected");
  expect(host.textContent).toContain("공급자 계정에서 확인 필요");
  expect(host.textContent).toContain("키 연결만으로 잔액·한도·생성 가능 여부가 확인되지는 않습니다");
  expect(host.textContent).toContain("2장 · 1024");
  expect(mocks.api.mock.calls[0][0]).toBe("/studio/ai-capacity?channelId=3&analysisProvider=openai");
});
it("calculates only after two explicit inputs and clears stale prices when channel/model changes", async () => {
  await render();
  const values = [...host.querySelectorAll("input")].map(input => input.value);
  expect(values).toEqual(["", ""]);
  await input("사용할 예산", "0.30");
  expect(host.querySelector("output")?.textContent).toContain("0보다 큰");
  await input("예상 이미지", "0.10");
  expect(host.querySelector("output")?.textContent).toBe("입력 예산 기준 약 3장 · 이번 2장 예상 $0.2");
  await render(4, 1);
  expect([...host.querySelectorAll("input")].map(input => input.value)).toEqual(["", ""]);
  expect(host.querySelector("output")?.textContent).toContain("모두 입력");
  await render(3, 2);
  expect([...host.querySelectorAll("input")].map(input => input.value)).toEqual(["", ""]);
  await render(4, 1);
  await input("사용할 예산", "1"); await input("예상 이미지", "0.1");
  await act(async () => client.setQueryData(["ai-capacity", 4, "openai", "analysis-image"], capacity(4, "gpt-image-new-model")));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect([...host.querySelectorAll("input")].map(input => input.value)).toEqual(["", ""]);
});
it("keeps zero budget distinct from an unknown provider remainder and rejects zero unit price", async () => {
  await render(); await input("사용할 예산", "0"); await input("예상 이미지", "0.1");
  expect(host.querySelector("output")?.textContent).toContain("약 0장");
  expect(host.textContent).toContain("공급자 계정에서 확인 필요");
  await input("예상 이미지", "0");
  expect(host.querySelector("output")?.textContent).toContain("0보다 큰");
});
