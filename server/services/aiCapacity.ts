import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { DB } from "../db";
import { jobs, type Channel } from "../../shared/schema";
import type { AiProvider } from "../../shared/aiProviders";
import type { AiCapacity } from "../../shared/aiCapacity";
import { channelAiAvailability, channelAiSelection } from "./channelAi";

type FailureRow = { error: string | null; configuration: unknown; ai: unknown; at: Date };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Return categories only. Prompt text, upstream errors and credentials never leave this service. */
export function capacityFailure(row: FailureRow): AiCapacity["latestFailure"] {
  const error = row.error ?? "";
  const provider: AiProvider | null = /Gemini/i.test(error) ? "gemini" : /OpenAI/i.test(error) ? "openai" : /Claude|Anthropic/i.test(error) ? "anthropic" : null;
  if (!provider) return null;
  const configuration = record(row.configuration), roles = record(record(configuration.familyPlan).roles);
  const candidates = [record(row.ai), ...Object.values(configuration).map(record), ...Object.values(roles).map(record)]
    .filter(value => value.provider === provider && typeof value.model === "string").map(value => value.model as string);
  const models = [...new Set(candidates)];
  const kind = /짧은 시간|분당|속도 제한|rate.?limit/i.test(error) ? "rate_limit" :
    /할당량|사용 한도|잔액|크레딧|quota|billing|한도 0/i.test(error) ? "quota" :
    /연결|API 키|권한|HTTP (?:401|403)/i.test(error) ? "connection" : "other";
  return { provider, model: models.length === 1 ? models[0] : null, kind, at: row.at.toISOString() };
}

export async function channelAiCapacity(db: DB, channel: Channel, analysisProvider?: AiProvider, imageOnly = false): Promise<AiCapacity> {
  const availability = channelAiAvailability();
  const analysis = channelAiSelection(channel, "summary", { provider: analysisProvider });
  const image = channelAiSelection(channel, "image");
  const failures = await db.select({ error: jobs.lastError, configuration: sql<unknown>`${jobs.payload}->'configuration'`, ai: sql<unknown>`${jobs.payload}->'ai'`, at: jobs.createdAt })
    .from(jobs).where(and(eq(jobs.channelId, channel.id), isNotNull(jobs.lastError), gte(jobs.createdAt, new Date(Date.now() - 24 * 3600_000))))
    .orderBy(desc(jobs.id)).limit(20);
  const latestFailure = failures.map(capacityFailure).find(failure => failure && (imageOnly ? [image] : [analysis, image]).some(selection => selection.provider === failure.provider && (failure.model === null || selection.model === failure.model))) ?? null;
  return {
    channelId: channel.id, analysis: { ...analysis, keyConfigured: availability[analysis.provider] }, image: { ...image, keyConfigured: availability[image.provider] },
    studioDailyImageLimit: null, providerRemainingTokens: null, providerRemainingImages: null, latestFailure,
  };
}
