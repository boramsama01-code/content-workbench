import { recordStudioBlobRead } from "../services/studioReadTelemetry";
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { canvaStudioSyncBindSchema, canvaStudioSyncCheckSchema } from "../../shared/canvaStudioSync";
import { studioImages } from "../../shared/schema";
import { getDb } from "../db";
import { actorOf } from "../auth";
import { ah, HttpError, intParam, parse } from "./util";
import { bindCanvaStudioSync, checkCanvaStudioSync, getCanvaStudioSync } from "../services/canvaStudioSync";

export const canvaStudioSyncRoutes = Router();
canvaStudioSyncRoutes.get("/studio/cards/:id/canva-sync", ah(async (req, res) => { res.set("Cache-Control", "no-store").json(await getCanvaStudioSync(getDb(), intParam(req.params.id))); }));
canvaStudioSyncRoutes.put("/studio/cards/:id/canva-sync", ah(async (req, res) => { res.json(await bindCanvaStudioSync(getDb(), intParam(req.params.id), parse(canvaStudioSyncBindSchema, req.body), actorOf(req))); }));
canvaStudioSyncRoutes.post("/studio/cards/:id/canva-sync/check", ah(async (req, res) => {
  const input = parse(canvaStudioSyncCheckSchema, req.body); res.json(await checkCanvaStudioSync(getDb(), intParam(req.params.id), input.version));
}));
canvaStudioSyncRoutes.get("/studio/cards/:id/canva-sync/proof/:proofId", ah(async (req, res) => {
  const [proof] = await getDb().select({ bytes: studioImages.bytes }).from(studioImages).where(and(eq(studioImages.id, intParam(req.params.proofId)), eq(studioImages.cardId, intParam(req.params.id)), eq(studioImages.model, "canva-pdf-proof"), eq(studioImages.mimeType, "application/pdf")));
  recordStudioBlobRead("canva-proof", proof?.bytes);
  if (!proof) throw new HttpError(404, "이 콘텐츠의 Canva PDF 기록을 찾을 수 없습니다.");
  res.type("application/pdf").set("Cache-Control", "private, no-store").set("X-Content-Type-Options", "nosniff").send(proof.bytes);
}));
