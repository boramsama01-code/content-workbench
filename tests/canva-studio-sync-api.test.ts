import { randomUUID } from "node:crypto";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { login, resetDb, setTestEnv } from "./helpers";
setTestEnv();
const mocked = vi.hoisted(() => ({ principal: vi.fn(), design: vi.fn(), pages: vi.fn(), submit: vi.fn(), poll: vi.fn(), download: vi.fn() }));
vi.mock("../server/services/canvaRest", async original => ({ ...await original<object>(), getCanvaPrincipal: mocked.principal, getCanvaDesign: mocked.design, getCanvaLibraryPages: mocked.pages, submitCanvaStudioSyncExport: mocked.submit, getCanvaLibraryExportJob: mocked.poll }));
vi.mock("../server/services/notionCanva", async original => ({ ...await original<object>(), downloadNotionCanvaExport: mocked.download }));
const { createApp } = await import("../server/app");
const { getDb, closeDb } = await import("../server/db");
const { appSettings, channels, contentItems, contentRevisions, jobs, studioCards, studioImages, studioRevisions } = await import("../shared/schema");
const { CanvaRestError } = await import("../server/services/canvaRest");
const { bindCanvaStudioSync, checkCanvaStudioSync, getCanvaStudioSync, advanceEnabledCanvaStudioSync } = await import("../server/services/canvaStudioSync");
const { extractCanvaStudioPdf } = await import("../server/services/canvaStudioSyncFiles");
let app: ReturnType<typeof createApp>, png: Buffer;

/** Real selectable PDF text with correct xref offsets, not a mocked parser result. */
function pdf(count = 11, empty = false) {
  const fontId = 3 + count * 2, objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${count} >>`);
  for (let i = 0; i < count; i++) {
    const stream = empty ? "" : `BT /F1 24 Tf 40 1200 Td (Updated Canva page ${i + 1}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1080 1350] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let text = "%PDF-1.4\n", offsets = [0];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const start = Buffer.byteLength(text); text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  text += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(`${text}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
}
function configure(count = 11, updatedAt = 100) {
  mocked.principal.mockResolvedValue({ userId: "user", teamId: "team" });
  mocked.design.mockResolvedValue({ id: "Dworking01", title: "실제 수정 디자인", owner: { userId: "user", teamId: "team" }, pageCount: count, updatedAt, editUrl: "https://www.canva.com/design/Dworking01/edit", viewUrl: null });
  mocked.pages.mockResolvedValue(Array.from({ length: count }, (_, i) => ({ id: `p${i + 1}`, pageNumber: i + 1, width: 1080, height: 1350, thumbnailUrl: null })));
  mocked.submit.mockImplementation(async (_db, _id, _count, format) => ({ id: `${format}-receipt`, status: "success", result: { urls: [] } }));
  mocked.poll.mockImplementation(async (_db, id) => ({ id, status: "success", result: { urls: id === "pdf-receipt" ? ["https://document-export.canva.com/proof.pdf"] : Array.from({ length: count }, (_, i) => `https://document-export.canva.com/page-${i + 1}.png`) } }));
  mocked.download.mockImplementation(async url => String(url).endsWith(".pdf") ? pdf(count) : png);
}
async function setup() {
  const auth = await login(app), headers = { "x-csrf-token": auth.csrf };
  const created = await auth.agent.post("/api/studio/cards").set(headers).send({ title: "기존 제목", channel: "highscoop", format: "카드뉴스", script: "원래 Studio 문구", caption: "사용자가 확정한 캡션" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { ...auth, headers, card: created.body, endpoint: `/api/studio/cards/${created.body.id}/canva-sync` };
}
async function bind(id: number, version = 1) { return bindCanvaStudioSync(getDb(), id, { version, designId: "Dworking01", enabled: true, requestId: randomUUID() }, "admin"); }

beforeAll(async () => { await resetDb(); app = createApp(); png = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#e2e8ee" } }).png().toBuffer(); });
afterAll(async () => { await closeDb(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await getDb().delete(appSettings).where(like(appSettings.key, "studio_canva_sync:%"));
  // Only records owned by this integration suite are cleared; resetDb targets its isolated test database.
  await getDb().delete(appSettings).where(eq(appSettings.key, "global_stop"));
  await getDb().insert(appSettings).values({ key: "global_stop", value: false });
  configure();
});

it("uses real PDF text for eleven pages and distinguishes PDFs without a text layer", async () => {
  const text = await extractCanvaStudioPdf(pdf(), 11);
  expect(text.pages).toHaveLength(11); expect(text.text).toContain("Updated Canva page 11"); expect(text.textStatus).toBe("extracted");
  const empty = await extractCanvaStudioPdf(pdf(2, true), 2);
  expect(empty).toMatchObject({ text: "", textStatus: "unavailable", pages: ["", ""] });
});

it("requires the operator session and CSRF and keeps discovered designs disabled", async () => {
  const f = await setup();
  expect((await request(app).get(f.endpoint)).status).toBe(401);
  expect((await f.agent.put(f.endpoint).send({ version: 1, designId: "Dworking01", enabled: true, requestId: randomUUID() })).status).toBe(403);
  expect((await f.agent.get(f.endpoint)).body.binding).toBeNull();
  expect(mocked.submit).not.toHaveBeenCalled();
});

it("imports eleven real PNG pages and the actual PDF text as a new Studio revision without rewriting caption or old revisions", async () => {
  const f = await setup();
  const connected = await bind(f.card.id); expect(connected.binding?.enabled).toBe(true);
  const state = await checkCanvaStudioSync(getDb(), f.card.id, 1);
  expect(state, JSON.stringify(state)).toMatchObject({ phase: "synced", pageCount: 11, cardVersion: 2, canonicalMapping: "not_mapped", textStatus: "extracted" });
  expect(state.latestText).toContain("Updated Canva page 11");
  const [card] = await getDb().select().from(studioCards).where(eq(studioCards.id, f.card.id));
  expect(card.content.finishedDeck?.pages).toHaveLength(11); expect(card.content.script).toContain("Updated Canva page 11");
  expect(card.content.title).toBe("기존 제목"); expect(card.content.caption).toBe("사용자가 확정한 캡션");
  const revisions = await getDb().select().from(studioRevisions).where(eq(studioRevisions.cardId, f.card.id)).orderBy(studioRevisions.id);
  expect(revisions).toHaveLength(2); expect(revisions[0].snapshot.script).toBe("원래 Studio 문구");
  expect((await f.agent.get(state.pdfProofUrl!)).status).toBe(200);
  const eleventh = await f.agent.get(`/api/studio/cards/${f.card.id}/export.png`).query({ page: 10, preview: 1, version: 2 });
  expect(eleventh.status, JSON.stringify(eleventh.body)).toBe(200); expect(eleventh.headers["content-type"]).toMatch(/image\/png/);
  expect(mocked.submit).toHaveBeenCalledTimes(2);
  await checkCanvaStudioSync(getDb(), f.card.id, 2);
  expect(mocked.submit).toHaveBeenCalledTimes(2);
});

it("also updates a linked source revision and output while preserving its unmapped canonical copy", async () => {
  const f = await setup(), [channel] = await getDb().select().from(channels).where(eq(channels.slug, "opportunities"));
  const [source] = await getDb().insert(contentItems).values({ channelId: channel.id, kind: "notice", origin: "manual", title: "연결된 원고" }).returning();
  const originalPayload = { cardCopy: { preserved: "승인된 기존 구조" }, sourceEvidence: "기존 근거" };
  const [revision] = await getDb().insert(contentRevisions).values({ contentItemId: source.id, revisionNo: 1, author: "operator", payload: originalPayload }).returning();
  await getDb().update(contentItems).set({ currentRevisionId: revision.id }).where(eq(contentItems.id, source.id));
  await getDb().update(studioCards).set({ sourceItemId: source.id, importedMeta: { sourceWorkspace: true } }).where(eq(studioCards.id, f.card.id));
  await bind(f.card.id); const state = await checkCanvaStudioSync(getDb(), f.card.id, 1);
  expect(state.phase).toBe("synced");
  const [updated] = await getDb().select().from(contentItems).where(eq(contentItems.id, source.id));
  expect(updated.version).toBe(source.version + 1); expect(updated.reviewStatus).toBe("review_required"); expect(updated.currentRevisionId).not.toBe(revision.id);
  const [latest] = await getDb().select().from(contentRevisions).where(eq(contentRevisions.id, updated.currentRevisionId!));
  expect(latest.payload.cardCopy).toEqual(originalPayload.cardCopy);
  expect(latest.payload.canvaSyncSnapshot).toMatchObject({ canonicalMapping: "not_mapped", latestText: expect.stringContaining("Updated Canva page 11") });
  const reply = await f.agent.get(`/api/studio/cards/${f.card.id}`);
  expect(reply.body.card.sourceOutput.pages).toHaveLength(11); expect(reply.body.card.sourceOutput.stale).toBe(false);
});

it("does not overwrite a concurrent Studio edit during Canva downloads", async () => {
  const f = await setup(); await bind(f.card.id);
  let changed = false;
  mocked.download.mockImplementation(async url => {
    if (!changed) { changed = true; const [card] = await getDb().select().from(studioCards).where(eq(studioCards.id, f.card.id)); await getDb().update(studioCards).set({ version: 2, content: { ...card.content, script: "동시에 저장한 최신 원고" } }).where(eq(studioCards.id, f.card.id)); }
    return String(url).endsWith(".pdf") ? pdf() : png;
  });
  const state = await checkCanvaStudioSync(getDb(), f.card.id, 1);
  expect(state.phase).toBe("conflict");
  const [card] = await getDb().select().from(studioCards).where(eq(studioCards.id, f.card.id)); expect(card.content.script).toBe("동시에 저장한 최신 원고"); expect(card.content.finishedDeck).toBeNull();
  expect(await getDb().select().from(studioImages).where(eq(studioImages.cardId, f.card.id))).toHaveLength(0);
});

it("keeps an unknown export submission durable and never repeats its POST on another check or worker tick", async () => {
  const f = await setup(); await bind(f.card.id);
  mocked.submit.mockRejectedValue(new CanvaRestError("응답 미확정", 504, "result_unknown", true));
  const first = await checkCanvaStudioSync(getDb(), f.card.id, 1); expect(first.phase).toBe("result_unknown");
  await checkCanvaStudioSync(getDb(), f.card.id, 1); await checkCanvaStudioSync(getDb(), f.card.id, 1);
  expect(mocked.submit).toHaveBeenCalledOnce();
  const [job] = await getDb().select().from(jobs).where(eq(jobs.id, first.jobId!)); expect(job.result).toMatchObject({ phase: "png_submitting" });
  expect(job.status).toBe("failed"); expect(job.leaseOwner).toBeNull(); expect(job.leaseExpiresAt).toBeNull();
});

it("does not export until explicitly enabled, rejects another card's design, and honors the global stop", async () => {
  const a = await setup(), b = await setup(); await bind(a.card.id);
  await expect(bind(b.card.id)).rejects.toThrow("다른 Studio");
  await getDb().update(appSettings).set({ value: true }).where(eq(appSettings.key, "global_stop"));
  await checkCanvaStudioSync(getDb(), a.card.id, 1);
  expect(mocked.submit).not.toHaveBeenCalled();
  const key = `studio_canva_sync:${a.card.id}`; const [row] = await getDb().select().from(appSettings).where(eq(appSettings.key, key));
  await getDb().update(appSettings).set({ value: { ...(row.value as object), enabled: false } }).where(eq(appSettings.key, key));
  expect((await getCanvaStudioSync(getDb(), a.card.id)).binding?.enabled).toBe(false);
});

it("serializes simultaneous browser/worker checks into one pair of export receipts and one new revision", async () => {
  const f = await setup(); await bind(f.card.id);
  await Promise.all([checkCanvaStudioSync(getDb(), f.card.id), checkCanvaStudioSync(getDb(), f.card.id)]);
  for (let i = 0; i < 3; i++) if ((await getCanvaStudioSync(getDb(), f.card.id)).phase !== "synced") await checkCanvaStudioSync(getDb(), f.card.id);
  expect((await getCanvaStudioSync(getDb(), f.card.id)).phase).toBe("synced");
  expect(mocked.submit).toHaveBeenCalledTimes(2);
  expect(await getDb().select().from(studioRevisions).where(eq(studioRevisions.cardId, f.card.id))).toHaveLength(2);
});

it("detects a second Canva save between exports and imports only the latest consistent save", async () => {
  const f = await setup(); await bind(f.card.id);
  let first = true;
  mocked.submit.mockImplementation(async (_db, _id, _count, format) => {
    if (first) { first = false; configure(11, 101); }
    return { id: `${format}-receipt`, status: "success", result: { urls: [] } };
  });
  const stale = await checkCanvaStudioSync(getDb(), f.card.id, 1);
  expect(stale.phase).toBe("checking"); expect(stale.cardVersion).toBe(1);
  const latest = await checkCanvaStudioSync(getDb(), f.card.id, 1);
  expect(latest.phase).toBe("synced"); expect(latest.binding?.lastDesignUpdatedAt).toBe(101);
  expect(mocked.submit).toHaveBeenCalledTimes(3);
});

it("advances an enabled binding through the background worker without a browser and supports twenty pages", async () => {
  configure(20);
  const f = await setup(); await bind(f.card.id);
  const tick = await advanceEnabledCanvaStudioSync(getDb(), { limit: 1 });
  expect(tick.checked).toBe(1); expect(tick.results[0]).toMatchObject({ phase: "synced", pageCount: 20 });
  const [card] = await getDb().select().from(studioCards).where(eq(studioCards.id, f.card.id));
  expect(card.content.finishedDeck?.pages).toHaveLength(20);
});

it("preserves a concurrent source revision even when the Studio card version itself did not change", async () => {
  const f = await setup(), [channel] = await getDb().select().from(channels).where(eq(channels.slug, "opportunities"));
  const [source] = await getDb().insert(contentItems).values({ channelId: channel.id, kind: "notice", origin: "manual", title: "source" }).returning();
  const [revision] = await getDb().insert(contentRevisions).values({ contentItemId: source.id, revisionNo: 1, author: "operator", payload: { unchanged: true } }).returning();
  await getDb().update(contentItems).set({ currentRevisionId: revision.id }).where(eq(contentItems.id, source.id));
  await getDb().update(studioCards).set({ sourceItemId: source.id }).where(eq(studioCards.id, f.card.id));
  await bind(f.card.id);
  let changed = false;
  mocked.download.mockImplementation(async url => { if (!changed) { changed = true; await getDb().update(contentItems).set({ version: 2 }).where(eq(contentItems.id, source.id)); } return String(url).endsWith(".pdf") ? pdf() : png; });
  expect((await checkCanvaStudioSync(getDb(), f.card.id, 1)).phase).toBe("conflict");
  const [latest] = await getDb().select().from(contentItems).where(eq(contentItems.id, source.id)); expect(latest.currentRevisionId).toBe(revision.id);
  const [card] = await getDb().select().from(studioCards).where(eq(studioCards.id, f.card.id)); expect(card.version).toBe(1); expect(card.content.finishedDeck).toBeNull();
});

it("keeps a concurrent disable effective while files are downloading", async () => {
  const f = await setup(); await bind(f.card.id);
  let disabled = false;
  mocked.download.mockImplementation(async url => {
    if (!disabled) { disabled = true; await bindCanvaStudioSync(getDb(), f.card.id, { version: 1, designId: "Dworking01", enabled: false, requestId: randomUUID() }, "admin"); }
    return String(url).endsWith(".pdf") ? pdf() : png;
  });
  const state = await checkCanvaStudioSync(getDb(), f.card.id, 1);
  expect(state.binding?.enabled).toBe(false); expect(state.cardVersion).toBe(1);
  const [card] = await getDb().select().from(studioCards).where(eq(studioCards.id, f.card.id)); expect(card.content.finishedDeck).toBeNull();
});

it("resumes a known export receipt after an ambiguous response without submitting that format again", async () => {
  const f = await setup(); await bind(f.card.id);
  mocked.submit.mockRejectedValueOnce(new CanvaRestError("접수 기록은 있으나 응답 불완전", 502, "invalid_response", true, "known-png-receipt"));
  await checkCanvaStudioSync(getDb(), f.card.id, 1);
  const state = await checkCanvaStudioSync(getDb(), f.card.id);
  expect(state.phase).toBe("synced");
  expect(mocked.submit.mock.calls.map(call => call[3])).toEqual(["png", "pdf"]);
});

it("releases a stopped job when the Studio version changes between export ticks", async () => {
  const f = await setup(); await bind(f.card.id);
  mocked.submit.mockResolvedValue({ id: "pending-png", status: "in_progress" });
  const pending = await checkCanvaStudioSync(getDb(), f.card.id, 1, 0);
  await getDb().update(studioCards).set({ version: 2 }).where(eq(studioCards.id, f.card.id));
  const state = await checkCanvaStudioSync(getDb(), f.card.id);
  expect(state.phase).toBe("conflict");
  const [job] = await getDb().select().from(jobs).where(eq(jobs.id, pending.jobId!));
  expect(job.status).toBe("cancelled"); expect(job.leaseOwner).toBeNull(); expect(job.leaseExpiresAt).toBeNull();
  expect(mocked.submit).toHaveBeenCalledOnce();
});

it("recovers an interrupted unreceipted POST as terminal unknown without retaining a busy job", async () => {
  const f = await setup(); await bind(f.card.id);
  mocked.submit.mockResolvedValue({ id: "pending-png", status: "in_progress" });
  const pending = await checkCanvaStudioSync(getDb(), f.card.id, 1, 0);
  const [before] = await getDb().select().from(jobs).where(eq(jobs.id, pending.jobId!));
  await getDb().update(jobs).set({ result: { ...before.result, phase: "png_submitting", pngJobId: undefined }, status: "running", leaseOwner: "expired-worker", leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, before.id));
  expect((await checkCanvaStudioSync(getDb(), f.card.id)).phase).toBe("result_unknown");
  const [job] = await getDb().select().from(jobs).where(eq(jobs.id, before.id));
  expect(job.status).toBe("failed"); expect(job.leaseOwner).toBeNull(); expect(job.leaseExpiresAt).toBeNull();
  await advanceEnabledCanvaStudioSync(getDb()); expect(mocked.submit).toHaveBeenCalledOnce();
});

it("accepts alt-text proposals for all twenty saved pages without widening the per-page text limit", async () => {
  const { importedProposalSchema } = await import("../server/services/importedCarousel");
  expect(importedProposalSchema.safeParse({ caption: "기존 캡션", altTexts: Array.from({ length: 20 }, () => "카드뉴스에 안내 문구가 적혀 있습니다.") }).success).toBe(true);
  expect(importedProposalSchema.safeParse({ caption: "기존 캡션", altTexts: Array.from({ length: 21 }, () => "카드뉴스에 안내 문구가 적혀 있습니다.") }).success).toBe(false);
  expect(importedProposalSchema.safeParse({ caption: "기존 캡션", altTexts: ["가".repeat(126)] }).success).toBe(false);
});
