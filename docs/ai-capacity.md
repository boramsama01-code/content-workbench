# AI image capacity and provider selection

Manual image creation has no Studio-wide daily image, token, or dollar allowance. Per-operation request reservations still bound the work of one explicitly requested generation; they are not an account balance and must not be removed to bypass an upstream rejection.

## Source analysis and image creation are separate

Images use the channel's OpenAI image model. Source analysis can use Gemini, OpenAI, or Claude. A rejected analysis can stop an initial full-deck workflow before its image request starts.

The temporary provider selected by the source-generation form must be applied to both the legacy summary selection and the family workflow's `article_analysis` role. Resolve the model through the existing role override logic, so changing providers never retains another provider's model ID. Persist the selected execution plan in the operation receipt. Other roles and saved channel settings remain independent.

## What the capacity panel knows

The authenticated, read-only panel resolves the selected analysis model and the channel image model. Key availability means only that a key is configured. It does not establish sufficient credits, quota, or model access. Recent failure categories are historical observations, not a live provider health check. Raw upstream messages, prompts, and credentials are not returned.

The existing integration does not retrieve an authoritative account-wide remaining balance or total remaining tokens/images. Such fields stay unknown (`null`); do not render them as zero or unlimited. OpenAI response rate-limit headers describe a rate window, not a prepaid balance. An organization usage report describes consumption, not a guaranteed remaining image count. No generated requests are sent just to refresh this panel.

The optional calculator requires the operator to enter both an available image budget in USD and an expected cost per image for the displayed model. It uses decimal arithmetic and is explicitly a manual estimate. It does not deduct credits, change billing, enforce a spending cap, or guarantee generation. Empty or invalid inputs produce no estimate. Image edits, references, text generation, actual token consumption, and other applications can change total cost. No unverified per-image price is supplied automatically.

## Gemini limit messages

Treat a confirmed zero model allocation, an identified daily quota, and a billing/credit restriction separately. A zero allocation can reject the first request of the day; a countdown does not fix zero allocation or missing credits. Unknown 429 responses remain unknown. Only explicitly temporary rejected requests can be retried within the existing request budget and deadline. Never switch providers automatically or replay an ambiguous paid request.

Official references checked 2026-11-16:

- [Gemini project rate limits](https://aistudio.google.com/docs/rate-limits)
- [OpenAI rate limits](https://developers.openai.com/api/docs/guides/rate-limits)
- [OpenAI image usage API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/images)
- [GPT-Image-2.5 Sunburst pricing and token-consumption limits](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
