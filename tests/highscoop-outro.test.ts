import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { HIGHSCOOP_CLOSING_COPY, HIGHSCOOP_CLOSING_LAYOUT } from "../shared/highscoopClosing";
import { highscoopOutroTheme } from "../shared/highscoopOutro";
import { planCarousel, cardCopyFromPayload, renderCarouselPages } from "../server/services/cardCarousel";
import { layoutHighscoopClosing } from "../server/services/highscoopClosing";

const copy = { version: 1, templateKey: "set:r01-blue", cover: { title: "우리의 다음 도전", subtitle: "신청하기 전에 살펴봐요" }, pages: [
  { id: "body-1", title: "참여 대상", subtitle: "대상을 확인해요", body: "중학교 재학생이 참여할 수 있습니다." },
  { id: "body-2", title: "지원 방법", subtitle: "직접 확인해요", body: "공식 공고에서 접수 방법을 확인합니다." },
  { id: "body-3", title: "일정", subtitle: "신청 전에", body: "공식 공고의 날짜와 시간을 확인합니다." },
  { id: "body-4", title: "직접 쓴 마지막 제목", subtitle: "내가 정한 안내", body: "마지막 장에 직접 쓴 문구입니다. 제출 전 서류를 다시 확인하세요." },
] };
const input = { kind: "notice", channelName: "HighScoop", channelSlug: "opportunities", accent: "#2457A6", sourceOrg: "주관 기관", checkedDate: "2026-11-05", payload: { title: "우주 체험 캠프", category: "캠프·체험", cardCopy: copy } };
const style = { layout: "minimal" as const, collection: "r01-blue" };

describe("HighScoop approved closing cards", () => {
  it("keeps category selection and leaves other brands' pages unchanged", () => {
    expect(highscoopOutroTheme("고등입시", input.payload)).toBe("high_admission");
    expect(highscoopOutroTheme("전국대회", input.payload)).toBe("competition");
    const other = planCarousel({ ...input, channelName: "다른 채널", channelSlug: "custom-school-notice" }, style);
    expect(other.highscoopClosing).toBeUndefined(); expect(other.count).toBe(5);
    expect(other.pages.at(-1)?.blocks[0].text).toBe(copy.pages[3].body);
  });

  it("appends the common card after the real last page without changing the saved manuscript", async () => {
    const before = structuredClone(input), plan = planCarousel({ ...input, subcategory: "고등입시" }, style);
    expect(plan.count).toBe(6); expect(plan.highscoopClosing?.appended).toBe(true);
    expect(plan.pages.at(-2)).toMatchObject({ title: copy.pages[3].title, subtitle: copy.pages[3].subtitle, badge: "05 / 06" });
    expect(plan.pages.at(-2)?.blocks[0].text).toBe(copy.pages[3].body);
    const pages = await renderCarouselPages(plan, style, null, "");
    expect(pages).toHaveLength(plan.count);
    expect(pages[4].altText).toContain(copy.pages[3].body);
    expect(pages[5].title).toBe(HIGHSCOOP_CLOSING_COPY.title);
    expect(pages[5].altText).toBe(HIGHSCOOP_CLOSING_COPY.altText);
    expect(pages[5].altText).not.toContain(copy.pages[3].body);
    expect(await sharp(pages[5].bytes).metadata()).toMatchObject({ width: 1080, height: 1350, format: "jpeg" });
    expect(input).toEqual(before);
  });

  it("keeps the reference layout and wording fixed when only the bottom accent changes", () => {
    const blue = layoutHighscoopClosing("#2457A6"), coral = layoutHighscoopClosing("#FF493B");
    expect(blue.textRuns).toEqual(coral.textRuns);
    expect(blue.colors.background).toBe(HIGHSCOOP_CLOSING_LAYOUT.background);
    expect(blue.colors.ink).toBe(coral.colors.ink);
    expect(blue.svg.replace(blue.colors.accent, coral.colors.accent)).toBe(coral.svg);
    const text = blue.textRuns.map(run => run.text).join("\n");
    for (const value of [HIGHSCOOP_CLOSING_COPY.follow, HIGHSCOOP_CLOSING_COPY.introductionText, HIGHSCOOP_CLOSING_COPY.handle, HIGHSCOOP_CLOSING_COPY.actionText]) expect(text).toContain(value);
  });

  it("continues long source instructions, retains the last paragraph and excludes the synthetic closing from editable copy", () => {
    const long = "원문의 모든 조건을 그대로 보존하고 마지막 제출 사항까지 확인합니다. ".repeat(16).trim();
    const source = { ...input, payload: { title: "캠프 안내", audience: "중학생", key_details: long, uncertainties: "추가 서류와 시간을 원문에서 확인하세요." } };
    const plan = planCarousel(source, style);
    expect(plan.count).toBeGreaterThan(6); expect(plan.count).toBeLessThanOrEqual(11);
    expect(plan.pages.flatMap(page => page.blocks).filter(block => block.field === "key_details").map(block => block.text).join("").replace(/\s/g, "")).toBe(long.replace(/\s/g, ""));
    expect(JSON.stringify(plan.pages.slice(0, -1))).toContain("추가 서류와 시간을 원문에서 확인하세요.");
    const editable = cardCopyFromPayload(source, style, "set:r01-blue");
    expect(editable.pages).toHaveLength(plan.count - 2);
    expect(JSON.stringify(editable)).not.toContain(HIGHSCOOP_CLOSING_COPY.description);
    const replanned = planCarousel({ ...source, payload: { ...source.payload, cardCopy: editable } }, style);
    expect(replanned.count).toBe(plan.count);
    expect(replanned.pages.filter(page => page.title === HIGHSCOOP_CLOSING_COPY.title)).toHaveLength(1);
  });
});
