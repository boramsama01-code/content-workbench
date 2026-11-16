/** Approved HighScoop closing page, based on the user's Canva page 9.
 * Keep wording, logo, cream background and red search icon fixed. Only the
 * bottom CTA fill follows the content category. Dimensions are 1080 × 1350.
 */
export const HIGHSCOOP_CLOSING_VERSION = 'highscoop-closing-2026-11-16';

const follow = '아이의 잠재력을 발견하는 영재교육의 모든 것';
const introductionText = '영재교육원 10년차 엄마가 떠먹여 드려요';
const actionText = '영재교육 관련 궁금한 내용이 있다면 댓글/DM 남겨주세요';
export const HIGHSCOOP_CLOSING_COPY = {
  title: 'HighScoop 채널 소개',
  follow,
  introductionText,
  introduction: `${introductionText} 🍨`,
  description: `${follow}\n${introductionText} 🍨`,
  handle: '@highscoop.official',
  actionText,
  action: `💡 ${actionText}`,
  altText: 'HighScoop 로고 아래 영재교육 소개와 계정 검색창이 있는 크림색 마무리 카드. 하단 색상 바에는 궁금한 내용을 댓글·DM으로 남겨달라는 안내가 있습니다.',
} as const;

export const HIGHSCOOP_CLOSING_LAYOUT = {
  width: 1080,
  height: 1350,
  background: '#FFF9F2',
  ink: '#171717',
  searchAccent: '#FF493B',
  logoPath: 'assets/branding/highscoop-magazine-color.png',
  icecreamPath: 'assets/branding/highscoop-closing-icecream.png',
  lightbulbPath: 'assets/branding/highscoop-closing-lightbulb.png',
  logo: { x: 100, y: 180.043, width: 880, height: 296.914 },
  description: { x: 80, y: 558, width: 920, height: 86.814, fontSize: 34, lineHeight: 43.407 },
  follow: { x: 80, y: 558, width: 920, height: 43.407, fontSize: 34, lineHeight: 43.407 },
  introduction: { x: 235.658, y: 601.407, width: 568.684, height: 43.407, fontSize: 34, lineHeight: 43.407 },
  icecream: { x: 814.342, y: 607.407, width: 30, height: 30 },
  search: { x: 228.9, y: 895.4, width: 624.4, height: 86.5, radius: 43.25, stroke: '#DADADA' },
  searchIcon: { x: 259.2, y: 921.5, width: 34, height: 34, radius: 11.5, strokeWidth: 3.5 },
  handle: { x: 312.636, y: 918.569, width: 493.976, height: 36.692, fontSize: 34, lineHeight: 36.692 },
  action: { x: 64, y: 1151, width: 952, height: 94, radius: 47, fontSize: 30, color: '#FFFFFF' },
  actionText: { x: 200.491, y: 1172.622, width: 752, height: 39.092, fontSize: 30, lineHeight: 39.092 },
  lightbulb: { x: 170.491, y: 1177.622, width: 26, height: 26 },
} as const;

export function isHighScoopClosingBrand(brand?: { id: string }): boolean {
  return !brand || brand.id === 'highscoop';
}

/** White bold CTA copy must remain readable on pastel category colors. A
 * darker shade of the same hue changes only the permitted bottom-bar fill. */
export function highScoopClosingAccent(value?: string): string {
  const source = /^#[0-9a-f]{6}$/i.test(value ?? '') ? value!.toUpperCase() : '#FF493B';
  const rgb = [1, 3, 5].map(at => parseInt(source.slice(at, at + 2), 16));
  const luminance = (channels: number[]) => channels.reduce((sum, byte, index) => {
    const channel = byte / 255;
    return sum + (channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index];
  }, 0);
  let shade = rgb;
  for (let factor = 1; 1.05 / (luminance(shade) + .05) < 3; factor *= .96) {
    shade = rgb.map(channel => Math.round(channel * factor * .96));
  }
  return `#${shade.map(channel => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
