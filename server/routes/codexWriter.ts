import { Router } from "express";
import { z } from "zod";
import { codexWriterCompleteSchema, codexWriterDeviceSchema, codexWriterFailSchema, codexWriterLeaseSchema, codexWriterRequestSchema } from "../../shared/codexWriter";
import { getDb } from "../db";
import { actorOf } from "../auth";
import { ah, intParam, parse } from "./util";
import { assertCodexWriterBearer, cancelCodexWriter, claimCodexWriter, codexWriterJob, codexWriterStatus, completeCodexWriter, failCodexWriter, heartbeatCodexJob, heartbeatCodexWriter, queueCodexWriter } from "../services/codexWriter";

/** Mount inside the ordinary operator-session + CSRF boundary. */
export const codexWriterOperatorRoutes = Router();
codexWriterOperatorRoutes.get("/studio/codex-writer/status", ah(async (_req, res) => { res.set("Cache-Control", "no-store").json(await codexWriterStatus(getDb())); }));
codexWriterOperatorRoutes.post("/studio/cards/:id/codex-draft", ah(async (req, res) => {
  res.status(202).set("Cache-Control", "no-store").json(await queueCodexWriter(getDb(), intParam(req.params.id), parse(codexWriterRequestSchema, req.body), actorOf(req)));
}));
codexWriterOperatorRoutes.get("/studio/cards/:id/codex-draft/:requestId", ah(async (req, res) => {
  res.set("Cache-Control", "no-store").json(await codexWriterJob(getDb(), intParam(req.params.id), parse(z.string().uuid(), req.params.requestId), actorOf(req)));
}));
codexWriterOperatorRoutes.post("/studio/cards/:id/codex-draft/:requestId/cancel", ah(async (req, res) => {
  parse(z.object({}).strict(), req.body ?? {});
  res.set("Cache-Control", "no-store").json(await cancelCodexWriter(getDb(), intParam(req.params.id), parse(z.string().uuid(), req.params.requestId), actorOf(req)));
}));

/** Dedicated, fixed worker surface; bearer auth applies only below this exact prefix. */
export const codexWriterWorkerRoutes = Router();
codexWriterWorkerRoutes.use("/codex-writer", (req, res, next) => {
  try { assertCodexWriterBearer(req.get("authorization")); res.set("Cache-Control", "no-store"); next(); } catch (error) { next(error); }
});
codexWriterWorkerRoutes.post("/codex-writer/heartbeat", ah(async (req, res) => { res.json(await heartbeatCodexWriter(getDb(), parse(codexWriterDeviceSchema, req.body))); }));
codexWriterWorkerRoutes.post("/codex-writer/claim", ah(async (req, res) => { parse(z.object({}).strict(), req.body ?? {}); res.json(await claimCodexWriter(getDb())); }));
codexWriterWorkerRoutes.post("/codex-writer/canva-sync-tick", ah(async (req, res) => {
  parse(z.object({}).strict(), req.body ?? {});
  const { advanceEnabledCanvaStudioSync } = await import("../services/canvaStudioSync");
  res.json(await advanceEnabledCanvaStudioSync(getDb(), { limit: 1 }));
}));
codexWriterWorkerRoutes.post("/codex-writer/jobs/:id/heartbeat", ah(async (req, res) => {
  const input = parse(codexWriterLeaseSchema, req.body); res.json(await heartbeatCodexJob(getDb(), intParam(req.params.id), input.leaseId, input.phase));
}));
codexWriterWorkerRoutes.post("/codex-writer/jobs/:id/complete", ah(async (req, res) => { res.json(await completeCodexWriter(getDb(), intParam(req.params.id), parse(codexWriterCompleteSchema, req.body))); }));
codexWriterWorkerRoutes.post("/codex-writer/jobs/:id/fail", ah(async (req, res) => { res.json(await failCodexWriter(getDb(), intParam(req.params.id), parse(codexWriterFailSchema, req.body))); }));
