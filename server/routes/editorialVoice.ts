import { Router } from "express";
import { z } from "zod";
import { editorialVoiceFeedbackSchema, editorialVoiceReplaceSchema } from "../../shared/editorialVoice";
import { getDb } from "../db";
import { actorOf } from "../auth";
import { ah, parse } from "./util";
import { getEditorialVoice, replaceEditorialVoice, saveEditorialVoiceFeedback } from "../services/editorialVoice";

/** Mount behind the existing operator session + CSRF middleware. */
export const editorialVoiceRoutes = Router();
const channelKey = (value: unknown) => parse(z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/), value);
editorialVoiceRoutes.get("/studio/editorial-voice/:channelKey", ah(async (req, res) => { res.set("Cache-Control", "no-store").json(await getEditorialVoice(getDb(), channelKey(req.params.channelKey))); }));
editorialVoiceRoutes.post("/studio/editorial-voice/:channelKey/feedback", ah(async (req, res) => {
  res.set("Cache-Control", "no-store").json(await saveEditorialVoiceFeedback(getDb(), channelKey(req.params.channelKey), parse(editorialVoiceFeedbackSchema, req.body), actorOf(req)));
}));
editorialVoiceRoutes.put("/studio/editorial-voice/:channelKey", ah(async (req, res) => {
  res.set("Cache-Control", "no-store").json(await replaceEditorialVoice(getDb(), channelKey(req.params.channelKey), parse(editorialVoiceReplaceSchema, req.body), actorOf(req)));
}));
