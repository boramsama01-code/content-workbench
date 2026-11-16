import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import sharp from "sharp";
import { extractText, getDocumentProxy } from "unpdf";
import { CANVA_STUDIO_SYNC_MAX_PAGES } from "../../shared/canvaStudioSync";
import { HttpError } from "../routes/util";

export const syncSha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export async function decodeStudioCanvaPngs(downloads: Buffer[], count: number): Promise<Buffer[]> {
  if (count < 1 || count > CANVA_STUDIO_SYNC_MAX_PAGES) throw new HttpError(422, "Canva 동기화는 1~20장을 지원합니다.");
  let entries: Array<{ page: number; bytes: Buffer }> = [];
  if (downloads.length === count && downloads.every(bytes => bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))) entries = downloads.map((bytes, i) => ({ page: i + 1, bytes }));
  else if (downloads.length === 1 && downloads[0].subarray(0, 2).toString() === "PK") {
    let total = 0, unsafe = false;
    const files = unzipSync(downloads[0], { filter: file => {
      if (!/\.png$/i.test(file.name)) return false;
      total += file.originalSize;
      if (file.originalSize > 20 * 1024 * 1024 || total > 100 * 1024 * 1024 || /(^|\/)\.\.(\/|$)/.test(file.name)) { unsafe = true; return false; }
      return true;
    } });
    if (unsafe) throw new HttpError(422, "Canva 출력 파일이 저장 한도를 초과합니다.");
    entries = Object.entries(files).map(([name, bytes]) => ({ page: Number(/(?:^|\D)(\d+)\.png$/i.exec(name)?.[1] ?? 0), bytes: Buffer.from(bytes) }));
  }
  if (entries.length !== count || new Set(entries.map(e => e.page)).size !== count || entries.some(e => e.page < 1 || e.page > count)) throw new HttpError(422, "Canva 출력 이미지의 장수·순서를 확인할 수 없습니다.");
  entries.sort((a, b) => a.page - b.page);
  for (const entry of entries) {
    const m = await sharp(entry.bytes, { limitInputPixels: 40_000_000 }).metadata();
    if (m.format !== "png" || !m.width || !m.height) throw new HttpError(422, "Canva PNG 이미지 형식을 확인할 수 없습니다.");
  }
  return entries.map(e => e.bytes);
}

/** Read actual PDF text, not OCR guesses or the old Studio manuscript. */
export async function extractCanvaStudioPdf(bytes: Buffer, expectedPages: number) {
  if (bytes.length > 100 * 1024 * 1024 || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new HttpError(422, "Canva PDF 원본을 확인할 수 없습니다.");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    if (pdf.numPages !== expectedPages) throw new HttpError(422, "Canva PDF와 이미지의 페이지 수가 다릅니다.");
    const result = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(result.text) ? result.text : [result.text]).map(text => text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").normalize("NFC").trim());
    if (pages.length !== expectedPages || pages.some(text => text.length > 30000) || pages.join("\n").length > 200000) throw new HttpError(422, "Canva PDF 텍스트의 페이지·길이 한도를 확인해 주세요.");
    const nonempty = pages.filter(page => page.length > 0).length;
    const text = nonempty ? pages.map((page, i) => `${i + 1}장\n${page}`).join("\n\n") : "";
    return { pages, text, textStatus: nonempty === 0 ? "unavailable" as const : nonempty === expectedPages ? "extracted" as const : "partial" as const, pdfSha256: syncSha(bytes), textSha256: syncSha(text) };
  } finally { await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.(); }
}
