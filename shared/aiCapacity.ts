import type { AiProvider } from "./aiProviders";
import { collectionUsesArt } from "./cardDesigns";
import { readingImageSlot, readingProfileForTemplateKey } from "./readingCardProfiles";

export type AiCapacitySelection = { provider: AiProvider; model: string; keyConfigured: boolean };
export type AiCapacity = {
  channelId: number;
  analysis: AiCapacitySelection;
  image: AiCapacitySelection;
  studioDailyImageLimit: null;
  providerRemainingTokens: null;
  providerRemainingImages: null;
  latestFailure: { provider: AiProvider; model: string | null; kind: "quota" | "rate_limit" | "connection" | "other"; at: string } | null;
};

/** Maximum new cover requests, including a source that already has an empty revision. */
export function sourceImageRequestLimit(input: { kind: string; hasSavedCopy: boolean; hasRevision: boolean; hasArticleBody: boolean; templateKey: string }): number {
  const profile = readingProfileForTemplateKey(input.templateKey);
  const family = !input.hasSavedCopy && (input.kind === "notice" ? !!profile : input.hasArticleBody);
  if (family) return !profile || readingImageSlot(profile, "cover")?.kind === "artwork" ? 1 : 0;
  if (profile || input.hasRevision) return 0;
  return input.templateKey.startsWith("set:") && !collectionUsesArt(input.templateKey.slice(4)) ? 0 : 1;
}

/** Decimal arithmetic prevents 0.30 / 0.10 from losing an image to floating point rounding. */
export function estimateImageCapacity(availableUsd: string, imageUsd: string, plannedImages: number): { images: number; requestUsd: number } | null {
  const money = (value: string): bigint | null => {
    const text = value.trim();
    if (!/^\d{1,10}(?:\.\d{1,8})?$/.test(text)) return null;
    const [whole, fraction = ""] = text.split(".");
    const amount = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
    return amount <= 1_000_000_000n * 100_000_000n ? amount : null;
  };
  const available = money(availableUsd), unit = money(imageUsd);
  if (available === null || unit === null || unit <= 0n || !Number.isSafeInteger(plannedImages) || plannedImages < 0 || plannedImages > 1000) return null;
  const images = available / unit;
  if (images > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { images: Number(images), requestUsd: Number(unit * BigInt(plannedImages)) / 100_000_000 };
}
