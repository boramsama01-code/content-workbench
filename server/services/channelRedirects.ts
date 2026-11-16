import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { appSettings, channels } from "../../shared/schema";
import { channelSlug } from "../../shared/channelKeys";

export async function channelRedirects(db: DB): Promise<Record<string, number>> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, "channel_redirects"));
  const value = row?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, id]) => /^\d+$/.test(key) && Number.isSafeInteger(id) && Number(id) > 0)) as Record<string, number>;
}
export function canonicalChannelId(id: number, redirects: Record<string, number>): number {
  const visited = new Set<number>();
  while (redirects[id] && redirects[id] !== id) {
    if (visited.has(id)) throw new Error("채널 통합 경로가 순환합니다.");
    visited.add(id); id = redirects[id];
  }
  return id;
}
export async function resolveCanonicalChannelId(db: DB, id: number): Promise<number> {
  return canonicalChannelId(id, await channelRedirects(db));
}
export async function studioChannelRecord(db: DB, key: string, lock: "share" | "update" = "share") {
  const [original] = await db.select().from(channels).where(eq(channels.slug, channelSlug(key)));
  if (!original) return undefined;
  const id = await resolveCanonicalChannelId(db, original.id);
  const [channel] = await db.select().from(channels).where(eq(channels.id, id)).for(lock);
  return channel;
}
export async function ownedChannelLineage(db: DB, id: number): Promise<number[]> {
  const redirects = await channelRedirects(db);
  return [id, ...Object.keys(redirects).map(Number).filter(source => source !== id && canonicalChannelId(source, redirects) === id)];
}
