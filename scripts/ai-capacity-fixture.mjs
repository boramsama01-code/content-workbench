// Public configuration only. Synthetic browser fixtures never infer a provider
// balance from key availability or make account/paid API requests.
export function aiCapacityFixture(url, channels, ai) {
  const channelId = Number(url.searchParams.get("channelId"));
  const channel = channels.find(value => value.id === channelId) ?? {};
  const settings = channel.effectiveAiSettings ?? channel.aiSettings ?? {};
  const defaults = { gemini: "gemini-4-argon", openai: "gpt-6.1-sol", anthropic: "claude-fixture", image: "gpt-image-2.5-sunburst", ...channel.aiDefaultModels };
  const savedAnalysis = settings.summary ?? { provider: "gemini", model: defaults.gemini };
  const provider = url.searchParams.get("analysisProvider") ?? savedAnalysis.provider;
  const model = (provider === savedAnalysis.provider ? savedAnalysis.model : "") || defaults[provider];
  const image = settings.image ?? { provider: "openai", model: defaults.image };
  return {
    channelId,
    analysis: { provider, model, keyConfigured: !!(channel.aiAvailability?.[provider] ?? ai.text?.[provider]) },
    image: { provider: "openai", model: image.model || defaults.image, keyConfigured: !!ai.image },
    studioDailyImageLimit: null, providerRemainingTokens: null, providerRemainingImages: null, latestFailure: null,
  };
}
