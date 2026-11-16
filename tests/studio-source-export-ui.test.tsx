// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StudioQuickExport } from "../client/src/pages/StudioExport";
import { studioContentSchema, type StudioCard } from "../shared/studio";
const mocks = vi.hoisted(() => ({ blob: vi.fn(), toast: vi.fn() }));
vi.mock("../client/src/api", async original => ({ ...await original<object>(), apiBlob: mocks.blob }));
vi.mock("../client/src/toast", () => ({ useToast: () => mocks.toast }));
vi.mock("../client/src/pages/StudioPublish", () => ({ StudioPublish: () => null }));
vi.mock("../client/src/pages/Design", () => ({ TemplatePicker: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root, client: QueryClient;
const card = (stale: boolean): StudioCard => ({ ...studioContentSchema.parse({ title: "카드", format: "카드뉴스" }), id: 4, version: 7, sourceItemId: 8, createdAt: "2026-11-16", updatedAt: "2026-11-16", sourceOutput: { assetId: 9, channelId: 2, itemId: 8, revisionId: 12, stale, pages: [{ id: 9, title: "표지" }], coverCredit: "" } });
beforeEach(() => { vi.clearAllMocks(); mocks.blob.mockRejectedValue(new Error("다운로드 경로 확인")); host = document.createElement("div"); document.body.append(host); root = createRoot(host); client = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
async function render(value: StudioCard) { await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(StudioQuickExport, { card: value })))); }
it("disables stale source download and binds a current source request to its revision", async () => {
  await render(card(true)); expect(host.querySelector("button")!.disabled).toBe(true);
  await render(card(false)); await act(async () => host.querySelector("button")!.click());
  expect(mocks.blob).toHaveBeenCalledWith("/channels/2/media/9/deck.zip?expectedRevision=12", "application/zip");
});
it("keeps a native Canva finished deck on its saved Studio version even with an old sourceOutput", async () => {
  await render({ ...card(true), finishedDeck: { pages: [{ imageId: 21, name: "Canva 1장", altText: "" }] } });
  expect(host.querySelector("button")!.disabled).toBe(false);
  await act(async () => host.querySelector("button")!.click());
  expect(mocks.blob).toHaveBeenCalledWith("/studio/cards/4/export.zip?version=7", "application/zip");
});
