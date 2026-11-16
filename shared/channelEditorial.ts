import { isHighscoopNewsCategory, supportsHighscoopNews } from "./channelContentMode";

export const HIGHSCOOP_NEWS_TEMPLATE = "set:n03";
export function isNewsContentKind(kind?: string | null): boolean {
  return kind === "current_dialogue" || kind === "science_dialogue";
}

/** The channel remains one brand while a news item keeps its own editorial format. */
export function contentTemplateForItem(
  channel: { slug?: string; name?: string; cardTemplate?: string | null },
  item: { kind?: string; subcategory?: string | null; cardCopy?: unknown },
  explicitTemplate?: string | null,
): string {
  if (explicitTemplate?.trim()) return explicitTemplate;
  const saved = item.cardCopy && typeof item.cardCopy === "object" && !Array.isArray(item.cardCopy)
    ? (item.cardCopy as { templateKey?: unknown }).templateKey : null;
  if (typeof saved === "string" && saved.trim()) return saved;
  if (supportsHighscoopNews(channel) && (isNewsContentKind(item.kind) || isHighscoopNewsCategory(channel, item.subcategory))) return HIGHSCOOP_NEWS_TEMPLATE;
  return channel.cardTemplate || "builtin:classic";
}
