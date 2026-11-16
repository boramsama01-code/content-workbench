import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import sharp from "sharp";
import type { DB } from "../db";
import { appSettings, canvaLibraryDesigns, canvaMasters, canvaRenderJobs, contentItems, contentRevisions, jobs, mediaAssets, notionSyncLinks, studioCards, studioImages, studioRevisions } from "../../shared/schema";
import { type CanvaStudioSyncBind, type CanvaStudioSyncState, type CanvaStudioSyncPhase, CANVA_STUDIO_SYNC_MAX_PAGES } from "../../shared/canvaStudioSync";
import { studioContentSchema } from "../../shared/studio";
import { CANVA_READING_MASTERS } from "../../shared/canvaMasterCatalog";
import { HttpError } from "../routes/util";
import { audit } from "../audit";
import { createRevision } from "../content";
import { getSetting } from "../seed";
import { assertStudioActive, loadStudioCard } from "./studio";
import { invalidateStudioPublication, lockStudioPublication } from "./studioPublicationState";
import * as rest from "./canvaRest";
import { downloadNotionCanvaExport } from "./notionCanva";
import { decodeStudioCanvaPngs, extractCanvaStudioPdf, syncSha } from "./canvaStudioSyncFiles";

const PREFIX = "studio_canva_sync:", JOB_TYPE = "studio_canva_sync";
type Stored = {
  kind: "studio_canva_binding"; cardId: number; generation: string; designId: string; editUrl: string | null; principal: string;
  enabled: boolean; lastDesignUpdatedAt: number | null; lastStudioVersion: number; sourceVersion: number | null; sourceRevisionId: number | null;
  phase: CanvaStudioSyncPhase; jobId?: number; message: string; lastCheckedAt?: string; latestText?: string; pageCount?: number;
  textStatus?: "extracted" | "partial" | "unavailable"; pdfProofId?: number;
};
type SyncWork = {
  phase: "png_submit" | "png_submitting" | "png_poll" | "pdf_submit" | "pdf_submitting" | "pdf_poll" | "download";
  generation: string; designId: string; designUpdatedAt: number; pageCount: number; pagesHash: string;
  pngJobId?: string; pdfJobId?: string;
};
const settingKey = (cardId: number) => `${PREFIX}${cardId}`;
const principalKey = (value: rest.CanvaPrincipal) => `${value.teamId}:${value.userId}`;
const workOf = (job: typeof jobs.$inferSelect) => job.result as unknown as SyncWork;
async function stored(db: DB, id: number): Promise<Stored | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, settingKey(id)));
  if (!row) return null;
  const value = row.value as Stored;
  if (value?.kind !== "studio_canva_binding" || value.cardId !== id || typeof value.designId !== "string" || !Number.isInteger(value.lastStudioVersion)) throw new HttpError(409, "Canva 연결 기록을 확인할 수 없습니다. 기존 원고는 보존했습니다.");
  return value;
}
async function put(db: DB, value: Stored) {
  await db.insert(appSettings).values({ key: settingKey(value.cardId), value }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}
// Remote I/O can outlive a disable/rebind. Never restore a superseded binding.
async function putCurrent(db: DB, value: Stored) {
  await db.update(appSettings).set({ value, updatedAt: new Date() }).where(and(eq(appSettings.key, settingKey(value.cardId)), sql`${appSettings.value}->>'generation' = ${value.generation}`));
}
async function stopJob(db: DB, id: number, status: "cancelled" | "failed", message: string) {
  await db.update(jobs).set({ status, lastError: message, finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null }).where(and(eq(jobs.id, id), inArray(jobs.status, ["queued", "running"])));
}
async function sourceState(db: DB, card: typeof studioCards.$inferSelect) {
  if (!card.sourceItemId) return null;
  const [source] = await db.select().from(contentItems).where(eq(contentItems.id, card.sourceItemId));
  return source ?? null;
}
function dto(value: Stored | null, cardVersion: number): CanvaStudioSyncState {
  return { binding: value ? { designId: value.designId, editUrl: value.editUrl, enabled: value.enabled, lastDesignUpdatedAt: value.lastDesignUpdatedAt, lastStudioVersion: value.lastStudioVersion } : null,
    phase: value?.phase ?? "idle", cardVersion, message: value?.message ?? "이 콘텐츠용 Canva 디자인을 연결하면 저장된 변경을 가져올 수 있습니다.",
    ...(value?.jobId ? { jobId: value.jobId } : {}), ...(value?.latestText !== undefined ? { latestText: value.latestText } : {}),
    ...(value?.pageCount ? { pageCount: value.pageCount } : {}), ...(value?.textStatus ? { textStatus: value.textStatus, canonicalMapping: "not_mapped" as const } : {}),
    ...(value?.lastCheckedAt ? { lastCheckedAt: value.lastCheckedAt } : {}), ...(value?.pdfProofId ? { pdfProofUrl: `/api/studio/cards/${value.cardId}/canva-sync/proof/${value.pdfProofId}` } : {}),
  };
}

export async function getCanvaStudioSync(db: DB, cardId: number): Promise<CanvaStudioSyncState> {
  const card = await loadStudioCard(db, cardId), value = await stored(db, cardId);
  if (value) return dto(value, card.version);
  const source = await sourceState(db, card);
  let design = source?.canvaDesign;
  if (!design && card.sourceItemId) {
    const [link] = await db.select().from(notionSyncLinks).where(eq(notionSyncLinks.contentItemId, card.sourceItemId)).limit(1);
    if (link?.canva.designId) design = { designId: link.canva.designId, editUrl: link.canva.editUrl ?? null, viewUrl: null, revisionId: source?.currentRevisionId ?? 0, createdAt: "" };
    if (!design) {
      const [job] = await db.select().from(canvaRenderJobs).where(and(eq(canvaRenderJobs.contentItemId, card.sourceItemId), sql`${canvaRenderJobs.designId} is not null`)).orderBy(desc(canvaRenderJobs.id)).limit(1);
      if (job?.designId) design = { designId: job.designId, editUrl: job.editUrl, viewUrl: null, revisionId: job.sourceRevisionId, createdAt: "" };
    }
  }
  return { ...dto(null, card.version), ...(design ? { binding: { designId: design.designId, editUrl: design.editUrl, enabled: false, discovered: true, lastDesignUpdatedAt: null, lastStudioVersion: card.version }, message: "기존 Canva 작업을 찾았습니다. 연결을 켜면 이 디자인의 저장된 변경을 가져옵니다." } : {}) };
}

async function inspectDesign(db: DB, id: string) {
  const [principal, design, pages] = await Promise.all([rest.getCanvaPrincipal(db), rest.getCanvaDesign(db, id), rest.getCanvaLibraryPages(db, id)]);
  if (principalKey(principal) !== principalKey(design.owner)) throw new HttpError(422, "연결한 Canva 계정·팀이 소유한 작업용 디자인만 동기화할 수 있습니다.");
  if (design.updatedAt === null || !design.pageCount || design.pageCount > CANVA_STUDIO_SYNC_MAX_PAGES || pages.length !== design.pageCount || pages.some(page => !page.width || !page.height)) throw new HttpError(422, "Canva 디자인은 크기를 확인할 수 있는 1~20장이어야 합니다.");
  return { design, pages, principal: principalKey(principal), pagesHash: syncSha(JSON.stringify(pages.map(({ id, pageNumber, width, height }) => ({ id, pageNumber, width, height })))) };
}

export async function bindCanvaStudioSync(db: DB, cardId: number, input: CanvaStudioSyncBind, actor: string) {
  const receiptKey = `${PREFIX}bind:${input.requestId}`, inputHash = syncSha(JSON.stringify({ cardId, input, actor }));
  const [receipt] = await db.select().from(appSettings).where(eq(appSettings.key, receiptKey));
  if (receipt) {
    if ((receipt.value as { inputHash?: string }).inputHash !== inputHash) throw new HttpError(409, "다른 Canva 연결에 사용한 요청 ID입니다.");
    return getCanvaStudioSync(db, cardId);
  }
  const previous = await stored(db, cardId);
  const inspected = !input.enabled && previous?.designId === input.designId ? null : await inspectDesign(db, input.designId);
  return db.transaction(async raw => {
    const tx = raw as unknown as DB, card = await lockStudioPublication(tx, cardId); assertStudioActive(card);
    if (card.version !== input.version) throw new HttpError(409, "Studio 원고가 바뀌었습니다. 최신 저장본에서 연결해 주세요.");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${receiptKey}, 0))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`studio-canva-design:${input.designId}`}, 0))`);
    const [again] = await tx.select().from(appSettings).where(eq(appSettings.key, receiptKey));
    if (again) { if ((again.value as { inputHash: string }).inputHash !== inputHash) throw new HttpError(409, "같은 요청 ID의 연결 내용이 다릅니다."); return getCanvaStudioSync(tx, cardId); }
    const [master] = await tx.select({ id: canvaMasters.id }).from(canvaMasters).where(eq(canvaMasters.sourceId, input.designId)).limit(1);
    const [library] = await tx.select({ id: canvaLibraryDesigns.id }).from(canvaLibraryDesigns).where(eq(canvaLibraryDesigns.sourceId, input.designId)).limit(1);
    if (master || library || CANVA_READING_MASTERS.some(value => value.sourceId === input.designId)) throw new HttpError(422, "공용 템플릿 대신 이 콘텐츠용 Canva 사본을 연결해 주세요.");
    const [other] = await tx.select({ key: appSettings.key }).from(appSettings).where(and(like(appSettings.key, `${PREFIX}%`), sql`${appSettings.value}->>'kind' = 'studio_canva_binding'`, sql`${appSettings.value}->>'designId' = ${input.designId}`, sql`${appSettings.value}->>'cardId' <> ${String(cardId)}`)).limit(1);
    if (other) throw new HttpError(409, "다른 Studio 콘텐츠에 연결된 Canva 디자인입니다.");
    const source = await sourceState(tx, card), current = await stored(tx, cardId);
    const [foreign] = await tx.select({ id: canvaRenderJobs.id }).from(canvaRenderJobs).where(and(eq(canvaRenderJobs.designId, input.designId), ...(card.sourceItemId ? [sql`${canvaRenderJobs.contentItemId} <> ${card.sourceItemId}`] : []))).limit(1);
    if (foreign) throw new HttpError(409, "다른 원고에 연결된 Canva 디자인입니다. 이 콘텐츠용 사본을 연결해 주세요.");
    if (current?.jobId) await tx.update(jobs).set({ status: "cancelled", finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null }).where(and(eq(jobs.id, current.jobId), inArray(jobs.status, ["queued", "running"])));
    const value: Stored = { kind: "studio_canva_binding", cardId, generation: randomUUID(), designId: input.designId,
      editUrl: inspected?.design.editUrl ?? previous?.editUrl ?? null, principal: inspected?.principal ?? previous?.principal ?? "", enabled: input.enabled,
      lastDesignUpdatedAt: input.enabled ? null : previous?.lastDesignUpdatedAt ?? null, lastStudioVersion: card.version,
      sourceVersion: source?.version ?? null, sourceRevisionId: source?.currentRevisionId ?? null,
      phase: "idle", message: input.enabled ? "연결했습니다. Canva의 현재 저장본을 확인해 가져옵니다." : "Canva 변경 자동 반영을 껐습니다. 기존 원고와 이미지는 유지합니다." };
    await put(tx, value); await tx.insert(appSettings).values({ key: receiptKey, value: { inputHash, cardId } });
    await audit(tx, { actor, action: "bind_canva_sync", entity: "studio_card", entityId: cardId, detail: { designId: input.designId, enabled: input.enabled } });
    return dto(value, card.version);
  });
}

function unchanged(value: Stored, card: typeof studioCards.$inferSelect, source: Awaited<ReturnType<typeof sourceState>>) {
  return card.version === value.lastStudioVersion && !card.trashedAt && (source?.version ?? null) === value.sourceVersion && (source?.currentRevisionId ?? null) === value.sourceRevisionId;
}

/** One bounded durable state-machine step; PNG/PDF POST receipts are never blindly repeated. */
export async function checkCanvaStudioSync(db: DB, cardId: number, version?: number, remainingSteps = 2): Promise<CanvaStudioSyncState> {
  let value = await stored(db, cardId), card = await loadStudioCard(db, cardId);
  if (!value?.enabled) return getCanvaStudioSync(db, cardId);
  if (version !== undefined && card.version !== version) throw new HttpError(409, "Studio 원고가 바뀌었습니다. 최신 저장본으로 확인해 주세요.");
  if (await getSetting(db, "global_stop", false)) return { ...dto(value, card.version), message: "전체 작업이 정지돼 Canva 확인을 시작하지 않았습니다." };
  if (["conflict", "result_unknown", "failed"].includes(value.phase)) return dto(value, card.version);
  if (!value.jobId) {
    let inspected: Awaited<ReturnType<typeof inspectDesign>>;
    try { inspected = await inspectDesign(db, value.designId); }
    catch (error) { return failBinding(db, value, card.version, error); }
    const admitted = await db.transaction(async raw => {
      const tx = raw as unknown as DB, fresh = await lockStudioPublication(tx, cardId), binding = await stored(tx, cardId);
      if (!binding?.enabled || binding.generation !== value!.generation) return null;
      if (binding.jobId) return null; // Another browser/worker admitted this exact change while metadata was read.
      const source = await sourceState(tx, fresh);
      if (!unchanged(binding, fresh, source)) { await put(tx, { ...binding, phase: "conflict", message: "Studio에서도 원고가 바뀌어 자동으로 덮어쓰지 않았습니다. 현재 내용을 저장·확인한 뒤 Canva 연결을 다시 켜 주세요." }); return null; }
      if (inspected.principal !== binding.principal) throw new HttpError(409, "Canva 연결 계정·팀이 바뀌었습니다. 다시 연결해 주세요.");
      if (inspected.design.updatedAt === binding.lastDesignUpdatedAt) { await put(tx, { ...binding, lastCheckedAt: new Date().toISOString() }); return null; }
      const [busy] = await tx.select({ id: jobs.id }).from(jobs).where(and(inArray(jobs.type, ["studio_generate", "studio_editorial_draft", "studio_codex_draft"]), inArray(jobs.status, ["queued", "running"]), sql`${jobs.payload}->>'cardId' = ${String(cardId)}`)).limit(1);
      if (busy) { await put(tx, { ...binding, lastCheckedAt: new Date().toISOString(), message: "다른 원고 작성이 끝난 뒤 Canva 변경을 확인합니다." }); return null; }
      const work: SyncWork = { phase: "png_submit", generation: binding.generation, designId: binding.designId, designUpdatedAt: inspected.design.updatedAt!, pageCount: inspected.pages.length, pagesHash: inspected.pagesHash };
      const [job] = await tx.insert(jobs).values({ type: JOB_TYPE, requestedBy: "canva-sync", maxAttempts: 1,
        dedupeKey: `canva-sync:${cardId}:${binding.generation}:${work.designUpdatedAt}`, payload: { cardId, sourceVersion: binding.sourceVersion, sourceRevisionId: binding.sourceRevisionId, studioVersion: binding.lastStudioVersion }, result: work as unknown as Record<string, unknown> }).returning();
      await put(tx, { ...binding, jobId: job.id, phase: "exporting", pageCount: work.pageCount, lastCheckedAt: new Date().toISOString(), message: "Canva 저장 변경을 확인했습니다. 이미지와 실제 PDF 문구를 가져옵니다." });
      return job.id;
    });
    if (!admitted) return getCanvaStudioSync(db, cardId);
    value = (await stored(db, cardId))!;
  }
  const owner = randomUUID();
  const claimed = await db.transaction(async raw => {
    const tx = raw as unknown as DB, fresh = await lockStudioPublication(tx, cardId), binding = await stored(tx, cardId);
    if (!binding?.enabled || binding.generation !== value!.generation || !binding.jobId) return null;
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, binding.jobId)).for("update");
    if (!job || job.status === "cancelled" || job.status === "succeeded") return null;
    if (job.leaseOwner && job.leaseExpiresAt && job.leaseExpiresAt > new Date()) return null;
    if (!unchanged(binding, fresh, await sourceState(tx, fresh))) { const message = "Studio 원고가 변경돼 가져온 결과를 현재 원고에 덮어쓰지 않았습니다."; await stopJob(tx, job.id, "cancelled", message); await put(tx, { ...binding, phase: "conflict", message }); return null; }
    const work = workOf(job);
    if (["png_submitting", "pdf_submitting"].includes(work.phase)) { const message = "Canva 내보내기 접수 결과를 확인하지 못했습니다. 중복 내보내기를 시작하지 않았습니다."; await stopJob(tx, job.id, "failed", message); await put(tx, { ...binding, phase: "result_unknown", message }); return null; }
    const [leased] = await tx.update(jobs).set({ status: "running", attempts: 1, leaseOwner: owner, leaseExpiresAt: new Date(Date.now() + 5 * 60000), startedAt: job.startedAt ?? new Date() }).where(eq(jobs.id, job.id)).returning();
    return { job: leased, binding };
  });
  if (!claimed) return getCanvaStudioSync(db, cardId);
  const job = claimed.job; let work = workOf(job); const initialPhase = work.phase;
  async function progress(next: SyncWork) {
    const rows = await db.update(jobs).set({ result: next as unknown as Record<string, unknown> }).where(and(eq(jobs.id, job.id), eq(jobs.leaseOwner, owner), eq(jobs.status, "running"))).returning({ id: jobs.id });
    if (!rows.length) throw new HttpError(409, "Canva 동기화가 중단됐습니다. 기존 원고는 유지합니다.");
    work = next;
  }
  try {
    const inspected = await inspectDesign(db, work.designId);
    if (inspected.principal !== claimed.binding.principal || inspected.design.updatedAt !== work.designUpdatedAt || inspected.pagesHash !== work.pagesHash) throw new HttpError(409, "Canva가 가져오는 동안 다시 수정됐습니다. 이미지와 문구를 섞지 않고 최신 저장본을 다시 확인합니다.");
    if (work.phase === "png_submit" || work.phase === "pdf_submit") {
      if (await getSetting(db, "global_stop", false)) throw new HttpError(409, "전체 작업이 정지돼 새 Canva 내보내기를 시작하지 않았습니다.");
      const format = work.phase === "png_submit" ? "png" : "pdf";
      await progress({ ...work, phase: format === "png" ? "png_submitting" : "pdf_submitting" });
      const exported = await rest.submitCanvaStudioSyncExport(db, work.designId, work.pageCount, format);
      await progress({ ...work, phase: exported.status === "success" ? format === "png" ? "pdf_submit" : "download" : format === "png" ? "png_poll" : "pdf_poll", ...(format === "png" ? { pngJobId: exported.id } : { pdfJobId: exported.id }) });
      if (exported.status === "failed") throw new HttpError(422, "Canva 내보내기를 완료하지 못했습니다.");
    } else if (work.phase === "png_poll" || work.phase === "pdf_poll") {
      const result = await rest.getCanvaLibraryExportJob(db, work.phase === "png_poll" ? work.pngJobId! : work.pdfJobId!);
      if (result.status === "failed") throw new HttpError(422, "Canva 내보내기를 완료하지 못했습니다.");
      if (result.status === "success") await progress({ ...work, phase: work.phase === "png_poll" ? "pdf_submit" : "download" });
    } else if (work.phase === "download") {
      const [pngJob, pdfJob] = await Promise.all([rest.getCanvaLibraryExportJob(db, work.pngJobId!), rest.getCanvaLibraryExportJob(db, work.pdfJobId!)]);
      if (pngJob.status !== "success" || pdfJob.status !== "success" || !pngJob.result?.urls.length || pdfJob.result?.urls.length !== 1) throw new HttpError(422, "Canva 이미지·PDF 출력 결과를 확인할 수 없습니다.");
      const files: Buffer[] = []; let total = 0;
      for (const url of pngJob.result.urls) { const bytes = await downloadNotionCanvaExport(url); total += bytes.length; if (total > 100 * 1024 * 1024) throw new HttpError(422, "Canva 전체 이미지가 100MB를 초과합니다."); files.push(bytes); }
      const pngs = await decodeStudioCanvaPngs(files, work.pageCount), pdf = await downloadNotionCanvaExport(pdfJob.result.urls[0]);
      const text = await extractCanvaStudioPdf(pdf, work.pageCount), after = await inspectDesign(db, work.designId);
      if (after.principal !== inspected.principal || after.design.updatedAt !== work.designUpdatedAt || after.pagesHash !== work.pagesHash) throw new HttpError(409, "Canva 저장 버전이 바뀌어 이전 출력은 적용하지 않았습니다. 다음 확인에서 최신 저장본을 가져옵니다.");
      for (let i = 0; i < pngs.length; i++) { const m = await sharp(pngs[i]).metadata(); if (m.width !== after.pages[i].width || m.height !== after.pages[i].height) throw new HttpError(422, "Canva 실제 PNG와 디자인 페이지 크기가 다릅니다."); }
      await applyOutput(db, cardId, job.id, owner, claimed.binding, work, pngs, pdf, text);
    }
  } catch (error) {
    const current = await stored(db, cardId);
    if (current?.generation === claimed.binding.generation && current.jobId === job.id) {
      const unknown = error instanceof rest.CanvaRestError && error.outcomeUnknown;
      const changed = error instanceof HttpError && error.status === 409 && /Canva.*(?:다시|버전)/.test(error.message);
      const message = error instanceof HttpError || error instanceof rest.CanvaRestError ? error.message : "Canva 동기화를 완료하지 못했습니다. 기존 원고·이미지는 유지했습니다.";
      if (unknown && error instanceof rest.CanvaRestError && error.jobId && /submitting$/.test(work.phase)) {
        await progress({ ...work, phase: work.phase === "png_submitting" ? "png_poll" : "pdf_poll", ...(work.phase === "png_submitting" ? { pngJobId: error.jobId } : { pdfJobId: error.jobId }) });
        await putCurrent(db, { ...current, message: "저장된 Canva 작업 ID로 결과를 다시 확인합니다. 새 내보내기를 만들지 않았습니다." });
      } else if (unknown || /submitting$/.test(work.phase) && !(error instanceof rest.CanvaRestError && !error.outcomeUnknown)) { await stopJob(db, job.id, "failed", message); await putCurrent(db, { ...current, phase: "result_unknown", message }); }
      else if (changed) { await stopJob(db, job.id, "cancelled", message); await putCurrent(db, { ...current, jobId: undefined, phase: "checking", message }); }
      else if (error instanceof rest.CanvaRestError && !error.outcomeUnknown && !/submitting$/.test(work.phase) && ["provider_unavailable", "rate_limited", "result_unknown"].includes(error.code)) await putCurrent(db, { ...current, phase: "exporting", message });
      else { await stopJob(db, job.id, "failed", message); await putCurrent(db, { ...current, phase: "failed", message }); }
    }
  } finally { await db.update(jobs).set({ leaseOwner: null, leaseExpiresAt: null }).where(and(eq(jobs.id, job.id), eq(jobs.leaseOwner, owner))); }
  const state = await getCanvaStudioSync(db, cardId);
  // Advance only a changed durable phase. Never spin on an in-progress GET or repeat an unreceipted POST.
  return remainingSteps > 0 && state.phase === "exporting" && work.phase !== initialPhase
    ? checkCanvaStudioSync(db, cardId, state.cardVersion, remainingSteps - 1) : state;
}

async function failBinding(db: DB, value: Stored, version: number, error: unknown) {
  const message = error instanceof HttpError || error instanceof rest.CanvaRestError ? error.message : "Canva 연결을 확인하지 못했습니다. 기존 원고는 유지합니다.";
  const transient = error instanceof rest.CanvaRestError && ["provider_unavailable", "rate_limited", "result_unknown"].includes(error.code);
  await putCurrent(db, { ...value, phase: transient ? "checking" : "failed", message });
  return getCanvaStudioSync(db, value.cardId);
}

async function applyOutput(db: DB, cardId: number, jobId: number, owner: string, expected: Stored, work: SyncWork, pngs: Buffer[], pdf: Buffer, text: Awaited<ReturnType<typeof extractCanvaStudioPdf>>) {
  const jpegPages: Buffer[] = [];
  for (const [i, png] of pngs.entries()) {
    const raw = await sharp(png).flatten({ background: "#ffffff" }).jpeg({ quality: 94, chromaSubsampling: "4:4:4" }).toBuffer();
    const comment = Buffer.from(`canva-sync:${cardId}:${jobId}:${i}`), marker = Buffer.alloc(4); marker.writeUInt16BE(0xfffe); marker.writeUInt16BE(comment.length + 2, 2);
    jpegPages.push(Buffer.concat([raw.subarray(0, 2), marker, comment, raw.subarray(2)]));
  }
  await db.transaction(async raw => {
    const tx = raw as unknown as DB, card = await lockStudioPublication(tx, cardId), binding = await stored(tx, cardId), source = await sourceState(tx, card);
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
    if (!binding?.enabled || binding.generation !== expected.generation || binding.jobId !== jobId || job?.leaseOwner !== owner || job.status !== "running" || !job.leaseExpiresAt || job.leaseExpiresAt <= new Date()) throw new HttpError(409, "중단되거나 만료된 Canva 결과는 적용하지 않았습니다.");
    if (await getSetting(tx, "global_stop", false)) throw new HttpError(409, "전체 작업이 정지돼 Canva 결과를 적용하지 않았습니다.");
    if (!unchanged(binding, card, source)) { await put(tx, { ...binding, phase: "conflict", message: "Studio 원고도 바뀌어 Canva 결과를 자동으로 덮어쓰지 않았습니다." }); await tx.update(jobs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(jobs.id, jobId)); return; }
    await invalidateStudioPublication(tx, card);
    // The existing card-owned binary store permits MIME types; a negative slot
    // and distinct model keep this proof out of image panels and finished decks.
    const [proof] = await tx.insert(studioImages).values({ cardId, panelIndex: -1, model: "canva-pdf-proof", mimeType: "application/pdf", bytes: pdf }).returning({ id: studioImages.id });
    const snapshot = { designId: work.designId, designUpdatedAt: work.designUpdatedAt, pngExportJobId: work.pngJobId, pdfExportJobId: work.pdfJobId,
      pdfSha256: text.pdfSha256, textSha256: text.textSha256, textPages: text.pages, latestText: text.text, textStatus: text.textStatus, canonicalMapping: "not_mapped", pdfProofId: proof.id, importedAt: new Date().toISOString() };
    const pages = [];
    for (const [i, bytes] of pngs.entries()) { const [image] = await tx.insert(studioImages).values({ cardId, panelIndex: i, bytes, mimeType: "image/png", model: "canva-native-sync" }).returning({ id: studioImages.id }); pages.push({ imageId: image.id, name: `Canva ${i + 1}장`, altText: "" }); }
    const script = text.textStatus === "unavailable" ? "[확인 필요] Canva 최신 PDF에서 문구를 추출하지 못했습니다. Canva 이미지와 PDF 원본을 대조해 주세요. 이전 Studio 원고는 이 버전의 확인된 문구로 사용하지 않습니다." : text.text.length <= 24000 ? text.text : `${text.text.slice(0, 23800)}\n\n[전체 Canva 원고는 동기화 기록에 보관했습니다. 이 편집칸은 앞부분만 표시합니다.]`;
    const content = studioContentSchema.parse({ ...card.content, script, format: "카드뉴스", stage: "review", finishedDeck: { pages } });
    let revisionId = source?.currentRevisionId ?? null, sourceVersion = source?.version ?? null, outputAssetId: number | undefined;
    if (source) {
      const [old] = source.currentRevisionId ? await tx.select().from(contentRevisions).where(eq(contentRevisions.id, source.currentRevisionId)) : [];
      const revision = await createRevision(tx, { contentItemId: source.id, author: "operator", payload: { ...(old?.payload ?? {}), canvaSyncSnapshot: snapshot,
        rendererProvider: "canva", canvaExport: { kind: "studio_canva_sync", designId: work.designId, canonicalMapping: "not_mapped", designUpdatedAt: work.designUpdatedAt },
        dependencies: { ...(old?.payload.dependencies as Record<string, unknown> ?? {}), render: "current", caption: "needs_review", review: "needs_review" } }, note: "Canva 저장 변경 동기화 · 실제 PDF 문구와 원본 이미지 보관, 기존 편집 필드 자동 매핑 안 됨" });
      revisionId = revision.id; sourceVersion = source.version + 1;
      const manifest: NonNullable<typeof mediaAssets.$inferInsert.carousel> = { version: 1, pages: [], cover: { kind: "upload", credit: "Canva 실제 저장본 · PDF 문구 별도 보관" }, rendererProvider: "canva" };
      for (const [i, bytes] of jpegPages.entries()) { const m = await sharp(bytes).metadata(); const [asset] = await tx.insert(mediaAssets).values({ channelId: source.channelId, contentItemId: source.id, revisionId: revision.id, kind: i === 0 ? "card" : "card_page", source: "canva", bytes, sha256: syncSha(bytes), mime: "image/jpeg", width: m.width!, height: m.height! }).returning({ id: mediaAssets.id, sha256: mediaAssets.sha256 }); manifest.pages.push({ ...asset, title: `Canva ${i + 1}장`, altText: "" }); }
      outputAssetId = manifest.pages[0].id; await tx.update(mediaAssets).set({ carousel: manifest }).where(eq(mediaAssets.id, outputAssetId));
      await tx.update(contentItems).set({ version: sourceVersion, reviewStatus: "review_required", publishStatus: "waiting", canvaDesign: { designId: work.designId, editUrl: binding.editUrl, viewUrl: null, revisionId: revision.id, createdAt: snapshot.importedAt } }).where(eq(contentItems.id, source.id));
    }
    const importedMeta = { ...card.importedMeta, canvaSyncSnapshot: snapshot, ...(outputAssetId ? { generatedAssetId: outputAssetId } : {}) };
    await tx.update(studioCards).set({ content, importedMeta, version: card.version + 1, updatedAt: new Date() }).where(eq(studioCards.id, cardId));
    await tx.insert(studioRevisions).values({ cardId, version: card.version + 1, snapshot: content, instruction: "Canva 저장본 자동 반영 · 실제 PDF 문구·원본 이미지, 구조 필드 자동 매핑 안 됨" });
    const phase = text.textStatus === "extracted" ? "synced" : "needs_text_review";
    await put(tx, { ...binding, jobId: undefined, phase, lastDesignUpdatedAt: work.designUpdatedAt, lastStudioVersion: card.version + 1, sourceVersion, sourceRevisionId: revisionId,
      latestText: text.text, textStatus: text.textStatus, pdfProofId: proof.id, pageCount: work.pageCount, lastCheckedAt: snapshot.importedAt,
      message: text.textStatus === "extracted" ? "Canva 저장 이미지와 실제 PDF 문구를 새 버전으로 반영했습니다. 기존 장별 편집 칸에는 자동 매핑하지 않았습니다." : "Canva 이미지를 반영했습니다. PDF에서 읽을 수 없는 문구가 있어 텍스트 대조가 필요합니다. 이전 원고를 확인된 Canva 문구로 취급하지 않습니다." });
    await tx.update(jobs).set({ status: "succeeded", result: { ...work, snapshot, studioVersion: card.version + 1, sourceRevisionId: revisionId }, finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null }).where(eq(jobs.id, jobId));
    await audit(tx, { actor: "canva-sync", action: "canva_saved_revision_synced", entity: "studio_card", entityId: cardId, detail: { jobId, designId: work.designId, designUpdatedAt: work.designUpdatedAt, version: card.version + 1, pageCount: work.pageCount, pdfSha256: text.pdfSha256, textStatus: text.textStatus, canonicalMapping: "not_mapped" } });
  });
}

/** Called by the authenticated local worker; only already-enabled bindings are advanced. */
export async function advanceEnabledCanvaStudioSync(db: DB, options: { limit?: number } = {}) {
  const limit = Math.max(1, Math.min(5, options.limit ?? 1));
  const rows = await db.select().from(appSettings).where(and(like(appSettings.key, `${PREFIX}%`), sql`${appSettings.value}->>'kind' = 'studio_canva_binding'`, sql`${appSettings.value}->>'enabled' = 'true'`, sql`${appSettings.value}->>'phase' not in ('conflict','result_unknown','failed')`)).orderBy(asc(appSettings.updatedAt)).limit(limit);
  const results = [];
  for (const row of rows) { const value = row.value as Stored; try { results.push({ cardId: value.cardId, ...await checkCanvaStudioSync(db, value.cardId) }); } catch (error) { results.push({ cardId: value.cardId, phase: "failed", message: error instanceof HttpError ? error.message : "Canva 자동 확인을 완료하지 못했습니다." }); } }
  return { checked: results.length, results };
}
