import { Router } from "express";
import { z } from "zod";
import { snsEditorialDraftRequestSchema } from "../../shared/snsEditorialDraft";
import { actorOf } from "../auth";
import { getDb } from "../db";
import { ah, intParam, parse } from "./util";
import { cancelSnsEditorialDraft, runSnsEditorialDraft } from "../services/snsEditorial";

/** Mounted inside studioRoutes, behind the existing operator session and CSRF middleware. */
export const snsEditorialRoutes = Router();
snsEditorialRoutes.post("/studio/cards/:id/editorial-draft", ah(async (req, res) => {
  const input = parse(snsEditorialDraftRequestSchema, req.body), cardId = intParam(req.params.id);
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  req.once("aborted", abort); res.once("close", abort);
  try { res.json(await runSnsEditorialDraft(getDb(), cardId, input, actorOf(req), controller.signal)); }
  finally { req.off("aborted", abort); res.off("close", abort); }
}));
snsEditorialRoutes.post("/studio/cards/:id/editorial-draft/:requestId/cancel", ah(async (req, res) => {
  const requestId = parse(z.string().uuid(), req.params.requestId);
  parse(z.object({}).strict(), req.body ?? {});
  res.json(await cancelSnsEditorialDraft(getDb(), intParam(req.params.id), requestId, actorOf(req)));
}));
