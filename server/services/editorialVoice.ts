import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { appSettings, channels } from "../../shared/schema";
import { channelSlug } from "../../shared/channelKeys";
import { buildEditorialVoicePrompt, editorialVoiceProfileSchema, emptyEditorialVoiceProfile,
  type EditorialVoiceProfile, type editorialVoiceFeedbackSchema, type editorialVoiceReplaceSchema } from "../../shared/editorialVoice";
import type { z } from "zod";
import type { DB } from "../db";
import { HttpError } from "../routes/util";
import { audit } from "../audit";

const key = (channelId: number) => `sns_voice_profile:${channelId}`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
type Receipt = { requestId: string; inputHash: string; revision: number };
async function storedProfile(db: DB, channelId: number) {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key(channelId)));
  const stored = row?.value as { profile?: unknown; receipts?: Receipt[] } | undefined;
  const parsed = editorialVoiceProfileSchema.safeParse(stored?.profile);
  if (stored?.profile !== undefined && !parsed.success) throw new HttpError(409, "저장된 문체 설정을 읽을 수 없습니다. 설정을 확인해 주세요.");
  return { profile: parsed.success ? parsed.data : emptyEditorialVoiceProfile(), receipts: Array.isArray(stored?.receipts) ? stored.receipts : [] };
}
export async function loadEditorialVoiceSnapshot(db: DB, channelId: number) {
  const { profile } = await storedProfile(db, channelId), prompt = buildEditorialVoicePrompt(profile);
  return { profile, prompt, hash: sha(prompt), revision: profile.profileRevision };
}
async function channelFor(db: DB, channelKey: string, lock = false) {
  const query = db.select().from(channels).where(eq(channels.slug, channelSlug(channelKey)));
  const [channel] = await (lock ? query.for("update") : query);
  if (!channel) throw new HttpError(404, "채널을 찾을 수 없습니다.");
  return channel;
}
export async function getEditorialVoice(db: DB, channelKey: string) {
  const channel = await channelFor(db, channelKey);
  return (await loadEditorialVoiceSnapshot(db, channel.id)).profile;
}
async function updateVoice(db: DB, channelKey: string, actor: string, operation: "feedback" | "replace", input: z.infer<typeof editorialVoiceFeedbackSchema> | z.infer<typeof editorialVoiceReplaceSchema>) {
  const inputHash = sha(JSON.stringify({ operation, ...input }));
  return db.transaction(async tx => {
    const dbtx = tx as unknown as DB, channel = await channelFor(dbtx, channelKey, true), stored = await storedProfile(dbtx, channel.id);
    const prior = stored.receipts.find(receipt => receipt.requestId === input.requestId);
    if (prior) {
      if (prior.inputHash !== inputHash) throw new HttpError(409, "같은 저장 요청 ID에 다른 내용을 사용할 수 없습니다.");
      return stored.profile;
    }
    if (stored.profile.profileRevision !== input.expectedRevision) throw new HttpError(409, "다른 곳에서 문체 설정을 수정했습니다. 최신 기준을 불러온 뒤 다시 저장해 주세요.", { currentRevision: stored.profile.profileRevision });
    let rules = stored.profile.rules, examples = stored.profile.examples;
    if (operation === "replace") {
      const replacement = input as z.infer<typeof editorialVoiceReplaceSchema>;
      rules = replacement.rules; examples = replacement.examples;
    } else {
      const feedback = input as z.infer<typeof editorialVoiceFeedbackSchema>;
      if (feedback.rule) rules = [...rules, { id: randomUUID(), text: feedback.rule }];
      if (feedback.approvedText) examples = [...examples, { id: randomUUID(), genre: feedback.genre, role: feedback.role, approvedText: feedback.approvedText, rejectedText: feedback.rejectedText ?? "", explanation: feedback.explanation ?? "" }];
      if (rules.length > 16 || examples.length > 12) throw new HttpError(409, "기억할 기준은 16개, 사례는 12개까지 보관합니다. 오래된 항목을 지운 뒤 저장해 주세요.");
    }
    const profile: EditorialVoiceProfile = { schemaVersion: 1, profileRevision: stored.profile.profileRevision + 1, rules, examples, updatedAt: new Date().toISOString() };
    const receipts = [...stored.receipts, { requestId: input.requestId, inputHash, revision: profile.profileRevision }].slice(-100);
    const value = { profile, receipts };
    await tx.insert(appSettings).values({ key: key(channel.id), value }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
    await audit(tx, { actor, action: "save_editorial_voice", entity: "channel", entityId: channel.id, channelId: channel.id,
      detail: { revision: profile.profileRevision, ruleCount: rules.length, exampleCount: examples.length, operation } });
    return profile;
  });
}
export const saveEditorialVoiceFeedback = (db: DB, channelKey: string, input: z.infer<typeof editorialVoiceFeedbackSchema>, actor: string) => updateVoice(db, channelKey, actor, "feedback", input);
export const replaceEditorialVoice = (db: DB, channelKey: string, input: z.infer<typeof editorialVoiceReplaceSchema>, actor: string) => updateVoice(db, channelKey, actor, "replace", input);
