import { resolveDiscovery, type DiscoverySettings } from "./domain";

type ChannelMode = { slug?: string; contentType: string; budget?: { discovery?: Partial<DiscoverySettings> | null } };
export const HIGHSCOOP_NEWS_CATEGORY = "뉴스";

/** The persisted channel stays HighScoop; the category selects its editorial workflow. */
export function supportsHighscoopNews(channel: Pick<ChannelMode, "slug"> | string): boolean {
  const slug = typeof channel === "string" ? channel : channel.slug;
  return !!slug && ["opportunities", "highscoop", "highway"].includes(slug);
}
export function isHighscoopNewsCategory(channel: Pick<ChannelMode, "slug"> | string, subcategory?: string | null): boolean {
  return supportsHighscoopNews(channel) && subcategory === HIGHSCOOP_NEWS_CATEGORY;
}
export function channelCollectionKind(channel: Pick<ChannelMode, "slug" | "contentType">, subcategory?: string | null): string {
  return isHighscoopNewsCategory(channel, subcategory) ? "current_dialogue" : channel.contentType;
}

/** Enabling news for an admissions channel is explicit; consolidation carries over its existing setting. */
export function channelDiscoverySettings(channel: ChannelMode): DiscoverySettings | null {
  if (!supportsHighscoopNews(channel)) return resolveDiscovery(channel.contentType, channel.budget?.discovery);
  const stored = channel.budget?.discovery;
  return resolveDiscovery("current_dialogue", stored ?? { enabled: false, autoDraft: false });
}
