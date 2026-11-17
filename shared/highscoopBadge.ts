import savedContract from '../assets/branding/highscoop-badge-contract.json';

export type HighScoopBadgeContract = {
  version: 1;
  brand: 'HighScoop';
  shape: 'capsule';
  cornerRadiusRatio: 0.5;
  pptxAdjustment: 50000;
  svgTemplate: string;
};

const invalidContract = () => new Error('하이스쿱 카테고리 뱃지는 양 끝이 반원인 알약 모양이어야 합니다. 공통 뱃지 설정을 확인하기 전에는 내보낼 수 없습니다.');

/** Reject the old rounded-rectangle settings before an export can reuse them. */
export function assertHighScoopBadgeContract(value: unknown): asserts value is HighScoopBadgeContract {
  if (!value || typeof value !== 'object') throw invalidContract();
  const contract = value as Partial<HighScoopBadgeContract>;
  if (contract.version !== 1 || contract.brand !== 'HighScoop' || contract.shape !== 'capsule'
    || contract.cornerRadiusRatio !== 0.5 || contract.pptxAdjustment !== 50000
    || typeof contract.svgTemplate !== 'string') throw invalidContract();
  const rectangles = [...contract.svgTemplate.matchAll(/<rect\b([^>]*)\/?\s*>/g)];
  if (rectangles.length !== 1) throw invalidContract();
  const attributes = rectangles[0][1];
  for (const [attribute, placeholder] of [['width', 'width'], ['height', 'height'], ['rx', 'radius'], ['ry', 'radius'], ['fill', 'color']]) {
    if (!new RegExp(`(?:^|\\s)${attribute}="\\{\\{${placeholder}\\}\\}"(?:\\s|/|$)`).test(attributes)) throw invalidContract();
  }
  if (!contract.svgTemplate.includes('data-highscoop-badge="capsule"')
    || !contract.svgTemplate.includes('viewBox="0 0 {{width}} {{height}}"')) throw invalidContract();
}

assertHighScoopBadgeContract(savedContract);
export const HIGHSCOOP_BADGE_CONTRACT: Readonly<HighScoopBadgeContract> = savedContract;

export function highScoopBadgeGeometry(width: number, height: number) {
  assertHighScoopBadgeContract(HIGHSCOOP_BADGE_CONTRACT);
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0 || width < height) {
    throw new Error('카테고리 뱃지는 양수 크기의 가로 알약 모양이어야 합니다.');
  }
  return {width, height, radius: height * HIGHSCOOP_BADGE_CONTRACT.cornerRadiusRatio, pptxAdjustment: HIGHSCOOP_BADGE_CONTRACT.pptxAdjustment};
}

/** A real SVG capsule survives imports without relying on CSS border-radius. */
export function createHighScoopBadgeSvg({width, height, color}: {width: number; height: number; color: string}) {
  const geometry = highScoopBadgeGeometry(width, height);
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('카테고리 뱃지 색상을 확인해 주세요.');
  const values = {width: String(width), height: String(height), radius: String(geometry.radius), color};
  return HIGHSCOOP_BADGE_CONTRACT.svgTemplate.replace(/\{\{(width|height|radius|color)\}\}/g, (_, key: keyof typeof values) => values[key]);
}
