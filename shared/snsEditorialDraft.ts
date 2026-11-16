import { z } from "zod";
import { SNS_TASKS } from "./snsEditorial";
import type { SnsTaskId } from "./snsEditorial";
import type { ProviderExecution } from "./aiProvenance";

const taskIds = SNS_TASKS.map(task => task.id) as [SnsTaskId, ...SnsTaskId[]];
export const snsEditorialDraftRequestSchema = z.object({
  version: z.number().int().positive(), requestId: z.string().uuid(),
  provider: z.enum(["gemini", "openai", "anthropic"]).optional(),
  task: z.enum(taskIds), topic: z.string().trim().min(1).max(600),
  audience: z.string().trim().min(1).max(500), format: z.string().trim().min(1).max(100),
  // Compatibility only. The server always takes the channel from the saved card.
  channel: z.string().max(200).optional(),
  referenceText: z.string().max(24000), existingText: z.string().max(24000), instruction: z.string().max(8000),
}).strict();
export type SnsEditorialDraftRequest = z.infer<typeof snsEditorialDraftRequestSchema>;

export const snsEditorialDraftOutputSchema = z.object({
  hooks: z.array(z.object({ angle: z.string().trim().min(1).max(120), text: z.string().trim().min(1).max(600), reason: z.string().trim().min(1).max(600) }).strict()).max(3),
  sections: z.array(z.object({ label: z.string().trim().min(1).max(160), text: z.string().trim().min(1).max(5000) }).strict()).max(20),
  finalCopy: z.string().trim().max(20000), checks: z.array(z.string().trim().min(1).max(1200)).max(20),
}).strict().refine(result => !!result.finalCopy || result.sections.length > 0 || result.checks.length > 0, { message: "작성 결과가 비어 있습니다." });
export type SnsEditorialDraftOutput = z.infer<typeof snsEditorialDraftOutputSchema>;
export type SnsEditorialDraftReply = SnsEditorialDraftOutput & {
  task: SnsTaskId; promptVersion: string; provider: "gemini" | "openai" | "anthropic";
  model: string; provenance?: ProviderExecution; usage: { inputTokens: number; outputTokens: number };
  promptTrace: { toolName: string; inputSha256: string }; jobId: number; cardVersion: number;
};
