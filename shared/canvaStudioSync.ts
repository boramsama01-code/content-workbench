import { z } from "zod";
import { canvaDesignIdFromInput } from "./canvaReconciliation";

export const CANVA_STUDIO_SYNC_MAX_PAGES = 20;
export const canvaStudioSyncPhases = ["idle", "checking", "exporting", "synced", "conflict", "needs_text_review", "result_unknown", "failed"] as const;
export type CanvaStudioSyncPhase = typeof canvaStudioSyncPhases[number];
export type CanvaStudioSyncBinding = {
  designId: string; editUrl: string | null; enabled: boolean; lastDesignUpdatedAt: number | null;
  lastStudioVersion: number; discovered?: boolean;
};
export type CanvaStudioSyncState = {
  binding: CanvaStudioSyncBinding | null; phase: CanvaStudioSyncPhase; cardVersion: number;
  jobId?: number; latestText?: string; pageCount?: number; message: string;
  canonicalMapping?: "not_mapped"; textStatus?: "extracted" | "partial" | "unavailable";
  lastCheckedAt?: string; pdfProofUrl?: string;
};
const designInput = z.string().trim().min(1).max(8192).transform((value, ctx) => {
  const id = canvaDesignIdFromInput(value);
  if (!id) { ctx.addIssue({ code: "custom", message: "Canva 디자인 링크 또는 ID를 확인해 주세요." }); return z.NEVER; }
  return id;
});
export const canvaStudioSyncBindSchema = z.object({ version: z.number().int().positive(), designId: designInput, enabled: z.boolean(), requestId: z.string().uuid() }).strict();
export const canvaStudioSyncCheckSchema = z.object({ version: z.number().int().positive(), requestId: z.string().uuid() }).strict();
export type CanvaStudioSyncBind = z.infer<typeof canvaStudioSyncBindSchema>;
