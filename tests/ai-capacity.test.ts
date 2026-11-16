import { describe, expect, it } from "vitest";
import { estimateImageCapacity, sourceImageRequestLimit } from "../shared/aiCapacity";
import { capacityFailure } from "../server/services/aiCapacity";

describe("manual image budget estimate", () => {
  it("requires both inputs and distinguishes zero budget from unknown", () => {
    expect(estimateImageCapacity("", "0.1", 2)).toBeNull();
    expect(estimateImageCapacity("1", "", 2)).toBeNull();
    expect(estimateImageCapacity("0", "0.1", 2)).toEqual({ images: 0, requestUsd: 0.2 });
  });
  it("floors decimal division exactly without losing affordable images", () => {
    expect(estimateImageCapacity("0.30", "0.10", 3)).toEqual({ images: 3, requestUsd: 0.3 });
    expect(estimateImageCapacity("0.29", "0.10", 3)).toEqual({ images: 2, requestUsd: 0.3 });
    expect(estimateImageCapacity("0.00000002", "0.00000001", 1)).toEqual({ images: 2, requestUsd: 0.00000001 });
  });
  it.each(["0", "-1", "NaN", "Infinity", "1e309", "0.000000001", "1000000001"])("rejects invalid unit price %s", unit => {
    expect(estimateImageCapacity("10", unit, 2)).toBeNull();
  });
  it.each(["-1", "NaN", "Infinity", "1e309", "0.000000001", "1000000001"])("rejects invalid budget %s", budget => {
    expect(estimateImageCapacity(budget, "1", 2)).toBeNull();
  });
  it("rejects unsafe image counts and invalid request sizes", () => {
    expect(estimateImageCapacity("1000000000", "0.00000001", 1)).toBeNull();
    expect(estimateImageCapacity("10", "1", -1)).toBeNull();
    expect(estimateImageCapacity("10", "1", NaN)).toBeNull();
  });
});

it("includes a cover for an article with an empty revision and preserves existing decks", () => {
  const source = { kind: "current_dialogue", hasSavedCopy: false, hasRevision: true, hasArticleBody: true, templateKey: "reading-ink-lime-v1" };
  expect(sourceImageRequestLimit(source)).toBe(1);
  expect(sourceImageRequestLimit({ ...source, hasSavedCopy: true })).toBe(0);
  expect(sourceImageRequestLimit({ ...source, hasArticleBody: false })).toBe(0);
  expect(sourceImageRequestLimit({ ...source, kind: "notice" })).toBe(1);
});

describe("safe failure metadata", () => {
  it("uses the provider named by the error rather than the requested writer", () => {
    const error = capacityFailure({ error: "Gemini HTTP 429: 프로젝트 사용 한도에 도달했습니다. secret-private-detail", configuration: {
      summary: { provider: "openai", model: "gpt-selected" }, familyPlan: { roles: { article_analysis: { provider: "gemini", model: "gemini-actual" } } },
    }, ai: null, at: new Date("2026-11-16T06:50:00Z") });
    expect(error).toEqual({ provider: "gemini", model: "gemini-actual", kind: "quota", at: "2026-11-16T06:50:00.000Z" });
    expect(JSON.stringify(error)).not.toContain("secret-private-detail");
  });
  it("does not invent a model when multiple models could have failed", () => {
    expect(capacityFailure({ error: "OpenAI HTTP 429", ai: null, configuration: { summary: { provider: "openai", model: "gpt-text" }, image: { provider: "openai", model: "gpt-image-x" } }, at: new Date() })).toMatchObject({ provider: "openai", model: null });
    expect(capacityFailure({ error: "generic private error", configuration: {}, ai: {}, at: new Date() })).toBeNull();
  });
});
