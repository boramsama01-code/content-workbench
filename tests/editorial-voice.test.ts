import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { buildEditorialVoicePrompt, editorialVoiceFeedbackSchema, emptyEditorialVoiceProfile } from "../shared/editorialVoice";

it("requires explicit useful feedback and bounds rules and approved examples", () => {
  const base = { expectedRevision: 0, requestId: randomUUID() };
  expect(editorialVoiceFeedbackSchema.safeParse(base).success).toBe(false);
  expect(editorialVoiceFeedbackSchema.safeParse({ ...base, rule: " " }).success).toBe(false);
  expect(editorialVoiceFeedbackSchema.safeParse({ ...base, rule: "기".repeat(401) }).success).toBe(false);
  expect(editorialVoiceFeedbackSchema.safeParse({ ...base, rejectedText: "거절한 문구만" }).success).toBe(false);
  expect(editorialVoiceFeedbackSchema.safeParse({ ...base, approvedText: "채택한 문구", explanation: "짧은 행동을 살림" }).success).toBe(true);
});
it("keeps whole recent correction pairs inside a 12000-character style-only prompt", () => {
  expect(buildEditorialVoicePrompt(emptyEditorialVoiceProfile())).toBe("");
  const examples = ["가", "나", "다"].map(character => ({ id: randomUUID(), genre: "news" as const, role: "body" as const,
    approvedText: character.repeat(6000), rejectedText: "추".repeat(3000), explanation: "이".repeat(1000) }));
  const prompt = buildEditorialVoicePrompt({ ...emptyEditorialVoiceProfile(), profileRevision: 3, examples });
  expect(prompt.length).toBeLessThanOrEqual(12000);
  expect(prompt).toContain(examples[2].approvedText); expect(prompt).toContain(examples[2].rejectedText);
  expect(prompt).not.toContain("가가"); expect(prompt).not.toContain("나나");
  expect(prompt).toContain("이번 글의 근거가 아니다"); expect(prompt).toContain("현재 요청의 확인된 사실·잠금 문구·수정 범위가 우선");
});
