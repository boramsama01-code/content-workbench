import { z } from "zod";
import type { SnsTaskId } from "./snsEditorial";
import { snsEditorialDraftOutputSchema, snsEditorialDraftRequestSchema, type SnsEditorialDraftOutput } from "./snsEditorialDraft";

export const CODEX_WRITER_MODEL = "gpt-6.1-sol";
export const CODEX_WRITER_EFFORT = "ultra";
export const CODEX_WRITER_JOB_TYPE = "studio_codex_draft";
export const codexWriterRequestSchema = snsEditorialDraftRequestSchema;
export const codexWriterQualityReviewSchema = z.object({
  passed: z.boolean(), issues: z.array(z.string().trim().min(1).max(1200)).max(20),
  revisionsApplied: z.array(z.string().trim().min(1).max(1200)).max(20),
  status: z.enum(["ready", "needs_revision", "needs_source"]).optional(),
  checks: z.array(z.object({ aspect: z.enum(["source", "conditions", "voice", "flow", "scope"]), status: z.enum(["pass", "revise", "not_checked"]), detail: z.string().trim().min(1).max(1200) }).strict()).max(10).optional(),
}).strict().superRefine((value, context) => {
  if (!value.passed) return;
  if (value.status && value.status !== "ready") context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "검토 상태와 통과 여부가 다릅니다." });
  const checks = value.checks ?? [];
  if (checks.length !== 5 || new Set(checks.map(check => check.aspect)).size !== 5 || checks.some(check => check.status !== "pass")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["checks"], message: "자료·조건·말투·흐름·수정 범위를 각각 검토하고 모두 통과해야 합니다." });
  }
});
export type CodexWriterQualityReview = z.infer<typeof codexWriterQualityReviewSchema>;
export const codexWriterDeviceSchema = z.object({ deviceName: z.string().trim().min(1).max(100), model: z.literal(CODEX_WRITER_MODEL) }).strict();
export const codexWriterLeaseSchema = z.object({ leaseId: z.string().uuid(), phase: z.enum(["draft", "review", "revision"]).optional() }).strict();
export const codexWriterCompleteSchema = z.object({
  leaseId: z.string().uuid(), output: snsEditorialDraftOutputSchema, model: z.literal(CODEX_WRITER_MODEL),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).strict().optional(),
  qualityReview: codexWriterQualityReviewSchema,
}).strict();
export const codexWriterFailSchema = z.object({ leaseId: z.string().uuid(), reason: z.enum(["cancelled", "timeout", "invalid_output", "runtime_error"]).default("runtime_error") }).strict();
export type CodexWriterStatus = { configured: boolean; online: boolean; lastSeenAt: string | null; model: string; deviceName: string | null };
export type CodexWriterResult = SnsEditorialDraftOutput & {
  writer: "codex"; provider: "openai"; model: string; task: SnsTaskId; promptVersion: string;
  usage?: { inputTokens: number; outputTokens: number }; usageStatus: "known" | "usage_unknown";
  qualityReview?: CodexWriterQualityReview;
  promptTrace: { toolName: string; inputSha256: string }; jobId: number; cardVersion: number;
};
export type CodexWriterJobView = {
  jobId: number; requestId: string; cardVersion: number;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  phase: string | null; error: string | null; result: CodexWriterResult | null;
};
export type CodexWriterClaim = {
  jobId: number; leaseId: string; cardId: number; requestId: string; task: SnsTaskId;
  prompt: string; outputSchema: Record<string, unknown>; model: string; effort: string;
};
export const CODEX_WRITER_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object", additionalProperties: false,
  properties: {
    hooks: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, properties: { angle: { type: "string" }, text: { type: "string" }, reason: { type: "string" } }, required: ["angle", "text", "reason"] } },
    sections: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, text: { type: "string" } }, required: ["label", "text"] } },
    finalCopy: { type: "string" }, checks: { type: "array", maxItems: 20, items: { type: "string" } },
  }, required: ["hooks", "sections", "finalCopy", "checks"],
};
