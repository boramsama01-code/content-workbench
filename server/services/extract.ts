/** Public article extraction. Never execute page scripts or bypass access restrictions. */
import * as cheerio from "cheerio";
import { extractText, getDocumentProxy } from "unpdf";
import { safeFetch, FetchFailure } from "./safeFetch";
import { sha256 } from "./text";
import { articleAccessProblem, articleHeadlines, articleHeadlineKey, decodeGoogleNewsUrl, googleArticleLink, isGoogleNewsUrl, matchesPrimaryArticleHeadline, publicArticleAlternate, publisherArticleLink, sameArticleAlternate, structuredArticleBody, type ArticleContext, type PublicArticleAlternate } from "./articleSource";
import { resolveGoogleNewsArticle } from "./googleNewsResolve";
import { decodePublicText, isPublicHtmlResponse } from "./publicTextResponse";
import { currentGenerationSignal } from "./generationContext";
import {GED_PDF_LIMITS,gedNoticeAttachments,isGedNoticePage} from './gedAttachments';
import type {SourceAttachment} from '../../shared/sourceAttachment';

export type Attachment = SourceAttachment;
export type ExtractResult =
  | { ok: true; finalUrl: string; title: string; text: string; hash: string; attachments: Attachment[]; contentKind: "html" | "pdf" }
  | { ok: false; status: "failed" | "unsupported" | "blocked"; error: string; attachments?: Attachment[]; finalUrl?: string };
const MAX_TEXT = 20_000;

/** Same public Naver blog post, in its readable mobile layout. */
export function preferReadableUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "blog.naver.com") {
      const m = u.pathname.match(/^\/([^/]+)\/(\d+)/);
      if (m) return `https://m.blog.naver.com/${m[1]}/${m[2]}`;
      const blogId = u.searchParams.get("blogId"), logNo = u.searchParams.get("logNo");
      if (blogId && logNo) return `https://m.blog.naver.com/${blogId}/${logNo}`;
    }
  } catch { /* invalid URL is rejected by safeFetch */ }
  return url;
}
function classifyAttachment(href: string, name: string): string | null {
  const h = (href + " " + name).toLowerCase();
  if (/\.pdf(\b|$|\?)/.test(h)) return "pdf";
  if (/\.hwpx(\b|$|\?)/.test(h)) return "hwpx";
  if (/\.hwp(\b|$|\?)/.test(h)) return "hwp";
  if (/\.(docx?|xlsx?|pptx?)(\b|$|\?)/.test(h)) return "office";
  if (/\.zip(\b|$|\?)/.test(h)) return "zip";
  if (/filedown|download|attach/i.test(href)) return "file";
  return null;
}
const cleanText = (s: string) => s.replace(/[ \t\u00a0]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

export function extractHtml(html: string, baseUrl: string, context: ArticleContext = {}): { title: string; text: string; attachments: Attachment[] } {
  const $ = cheerio.load(html);
  const structured = structuredArticleBody(html, baseUrl, context.title);
  const title = (articleHeadlines(html, baseUrl)[0] || structured.title || $("title").first().text() || "").trim();
  const attachments: Attachment[] = [];
  if (isGoogleNewsUrl(baseUrl) || articleAccessProblem(html, baseUrl)) return { title, text: "", attachments };
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href") || "", name = $(a).text().trim().slice(0, 200);
    // A named PDF whose href is only an anchor is not a file URL. GED and
    // supported onclick handlers are resolved separately from literal args.
    if(!href||/^\s*(?:#|javascript:|data:)/i.test(href))return;
    const kind = classifyAttachment(href, name);
    if (!kind) return;
    let abs: string;
    try { abs = new URL(href, baseUrl).toString(); } catch { return; }
    if (!/^https?:/.test(abs) || attachments.some(x => x.url === abs)) return;
    attachments.push({ url: abs, name: name || abs.split("/").pop() || "첨부", kind,
      status: kind === "pdf" ? "pending" : "manual_check",
      reason: kind === "pdf" ? undefined : `${kind.toUpperCase()} 파일은 자동 추출하지 않음 — 수동 확인 필요` });
  });
  // MCST's public download handler uses these literal arguments. Parse them;
  // never execute site JavaScript or mistake the HTML preview for the PDF.
  const base = new URL(baseUrl);
  if(isGedNoticePage(baseUrl))attachments.push(...gedNoticeAttachments(html,baseUrl));
  if (base.hostname.replace(/^www\./, "") === "mcst.go.kr" && /\/s_notice\/press\/pressView\.jsp$/.test(base.pathname)) {
    $('a[onclick*="file_download("]').each((_, a) => {
      const args = ($(a).attr("onclick") || "").match(/file_download\(\s*'([^']+)'\s*,\s*'([\w.-]+\.pdf)'\s*,\s*'(\d+)'\s*(?:,\s*'(\d*)'\s*)?\)/i);
      if (!args) return;
      let name: string;
      try { name = decodeURIComponent(args[1].replace(/\+/g, " ")); } catch { return; }
      const url = new URL("/servlets/eduport/front/upload/UplDownloadFile", baseUrl);
      url.search = new URLSearchParams({ pFileName: name, pRealName: args[2], pPath: args[3], pFlag: args[4] ?? "" }).toString();
      for (let i = attachments.length - 1; i >= 0; i--) if (new URL(attachments[i].url).searchParams.get("fn") === args[2]) attachments.splice(i, 1);
      if (!attachments.some(x => x.url === url.href)) attachments.push({ url: url.href, name, kind: "pdf", status: "pending" });
    });
  }
  // Education CMSs wrap the public article in a navigation/submission form.
  // Preserve the verified content node before removing form controls/chrome.
  const host = base.hostname.replace(/^www\./, "");
  const formBody = ["pen.go.kr", "ice.go.kr", "goe.go.kr", "cbe.go.kr"].includes(host) && /\/na\/ntt\/selectNttInfo\.do$/.test(base.pathname) ? ".bbsV_cont"
    : host === "dje.go.kr" && base.pathname === "/boardCnts/view.do" ? ".viewBox"
    : host === "sen.go.kr" && base.pathname === "/user/bbs/BD_selectBbs.do" ? ".bd-view__vcontent" : null;
  if (formBody) $(formBody).each((_, node) => { if ($(node).parents("form").length) $(node).appendTo("body"); });
  $("script,style,noscript,iframe,svg,header,footer,nav,form,aside,button,input,select,textarea,[hidden],[aria-hidden='true'],.related-news,.related-articles,.article-tools,.share-buttons,.advertisement").remove();
  $("br").replaceWith("\n");
  $("p,div,section,li,h1,h2,h3,h4,tr").append("\n");
  const selectors = [".bd-view__vcontent", ".bbsV_cont", ".viewBox", ".activity-detail-content [class*='ActivityDetailTabContent__StyledWrapper']", ".view_detail_area", ".prog_bord_view > .prog_contents", ".prog_bord_view .prog_contents", ".board_view.bd_noti", ".board_view > .view_body", "#dic_area", "#newsct_article", "#harmonyContainer", "#articletxt", "#cont_newstext", "#news_body_id", "#CmAdContent", ".se-main-container", "#postViewArea", "[itemprop='articleBody']",
    "#article-view-content-div", "#articleBodyContents", "#articleBody", "#article-body", "#article_body", "#article_content", "#articleContent", "#newsEndContents", "#news_content", "#newsContent", "#news_text", "#news_txt", "section.news_view", ".article-body", ".article_body", ".article_view", ".article_txt", ".article-text", ".article-content", ".article__body", ".news-article-body", ".news-text", ".news_body", "article",
    "[class*='board_view']", "[class*='bbs_view']", "[class*='view_cont']", "[class*='viewCont']"];
  let text = "";
  for (const selector of selectors) {
    let nodes = $(selector);
    if (selector === "article" && nodes.length > 1) {
      nodes = nodes.filter((_, el) => $(el).find("h1,[itemprop='headline']").toArray().some(heading => articleHeadlineKey($(heading).text()) === articleHeadlineKey(title)));
      if (nodes.length !== 1) continue;
    }
    const choices = nodes.toArray().map(el => cleanText($(el).text())).filter(t => t.length >= 80);
    if (choices.length) { text = choices.sort((a, b) => b.length - a.length)[0]; break; }
  }
  if (structured.text.length >= 80 && structured.text.length > text.length) text = structured.text;
  if (!text && $("article").length <= 1) {
    for (const selector of ["main", "#content", "body"]) {
      const node = $(selector).first();
      const paragraphs = node.find("p").toArray().map(el => cleanText($(el).text())).filter(t => t.length >= 30);
      if (paragraphs.join("\n").length >= 80) { text = paragraphs.join("\n"); break; }
      const t = cleanText(node.text());
      if (node.find("a").length === 0 && t.length >= 80) { text = t; break; }
    }
  }
  return { title, text: text.slice(0, MAX_TEXT), attachments: attachments.slice(0, 20) };
}

export async function extractPdf(buf: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  try{
    const { text } = await extractText(pdf, { mergePages: true });
    return (Array.isArray(text) ? text.join("\n") : text).replace(/[ \t]+/g, " ").trim().slice(0, MAX_TEXT);
  }finally{await (pdf as unknown as {destroy?:()=>Promise<void>}).destroy?.();}
}

/** Page-bound source proof for GED notices. Ordinary extraction keeps its
 * existing 20k contract; the dedicated notice workflow has an explicit cap. */
export async function extractPdfPages(buf:Buffer,maxText:number=GED_PDF_LIMITS.text) {
  const pdf=await getDocumentProxy(new Uint8Array(buf));
  try{
    if(!Number.isInteger(pdf.numPages)||pdf.numPages<1||pdf.numPages>GED_PDF_LIMITS.pages)throw new Error(`PDF가 자동 읽기 한도(${GED_PDF_LIMITS.pages}쪽)를 넘거나 페이지를 확인할 수 없습니다.`);
    const {text}=await extractText(pdf,{mergePages:false});
    const raw=Array.isArray(text)?text:[text];
    if(raw.length!==pdf.numPages)throw new Error('PDF 페이지와 추출된 텍스트 수가 다릅니다.');
    let remaining=Math.max(0,Math.min(GED_PDF_LIMITS.text,maxText)),truncated=false;
    const unreadablePages:number[]=[],pages:Array<{page:number;text:string}>=[];
    raw.forEach((value,index)=>{
      const normalized=value.replace(/[ \t]+/g,' ').trim();
      if(!normalized)unreadablePages.push(index+1);
      const selected=normalized.slice(0,remaining);
      if(selected.length<normalized.length)truncated=true;
      if(selected||!normalized)pages.push({page:index+1,text:selected});
      remaining-=selected.length;
    });
    return {pages,pageCount:pdf.numPages,truncated,unreadablePages};
  }finally{await (pdf as unknown as {destroy?:()=>Promise<void>}).destroy?.();}
}

async function readGedNotice(attachments:Attachment[],finalUrl:string,title:string,fetchImpl:typeof safeFetch,context:ArticleContext,deadline:number):Promise<ExtractResult> {
  const parts:string[]=[];let length=0,downloads=0;
  const markPending=(reason:string)=>attachments.filter(item=>item.kind==='pdf'&&item.status==='pending').forEach(item=>{item.reason=reason;});
  for(const attachment of attachments){
    if(attachment.kind!=='pdf'||attachment.status!=='pending')continue;
    if(downloads>=GED_PDF_LIMITS.files){markPending(`PDF ${GED_PDF_LIMITS.files}개 자동 읽기 한도에 도달했습니다. 나머지는 원본 확인이 필요합니다.`);break;}
    if(GED_PDF_LIMITS.text-length<512){markPending('첨부 전체의 텍스트 한도에 도달했습니다. 나머지는 원본 확인이 필요합니다.');break;}
    const remaining=deadline-Date.now();
    if(remaining<=0){markPending('원문 확인 시간 한도에 도달했습니다. 다시 확보하거나 원본을 확인해 주세요.');break;}
    if(context.takeExtraCall&&!context.takeExtraCall()){markPending('이번 수집의 원문 호출 한도에 도달했습니다. 다시 확보하거나 원본을 확인해 주세요.');break;}
    currentGenerationSignal()?.throwIfAborted();downloads++;
    try{
      const document=await fetchImpl(attachment.url,{allowedHosts:['ged.kedi.re.kr'],maxBytes:GED_PDF_LIMITS.bytes,timeoutMs:Math.min(12_000,remaining),accept:'application/pdf'});
      if(new URL(document.finalUrl).hostname!=='ged.kedi.re.kr'||document.body.subarray(0,5).toString()!=='%PDF-')throw new Error('GED 공식 PDF 응답이 아닙니다. 로그인·오류 페이지를 원문으로 사용하지 않았습니다.');
      if(document.body.length>GED_PDF_LIMITS.bytes)throw new Error('PDF가 자동 읽기 크기 한도를 넘습니다.');
      const proof=await extractPdfPages(document.body,GED_PDF_LIMITS.text-length);
      currentGenerationSignal()?.throwIfAborted();
      if(Date.now()>=deadline)throw new Error('첨부 PDF 확인 시간 한도를 초과했습니다. 다시 확보해 주세요.');
      attachment.pdfSha256=sha256(document.body);attachment.pageCount=proof.pageCount;
      attachment.unreadablePages=proof.unreadablePages;attachment.truncated=proof.truncated;
      const selected:Array<{page:number;text:string}>=[];
      for(const page of proof.pages){
        if(!page.text){selected.push(page);continue;}
        const heading=`[첨부 PDF: ${attachment.name} · ${page.page}쪽]\n`,separator=parts.length?2:0;
        const available=Math.max(0,GED_PDF_LIMITS.text-length-heading.length-separator);
        const content=page.text.slice(0,available);
        if(content.length<page.text.length)attachment.truncated=true;
        if(!content)break;
        const part=heading+content;parts.push(part);length+=part.length+separator;
        selected.push({page:page.page,text:content});
      }
      attachment.pages=selected;
      const extracted=selected.map(page=>page.text).join('\n');
      attachment.textSha256=sha256(extracted);
      if(extracted.trim().length<50){attachment.status='manual_check';attachment.reason='텍스트가 없는 PDF 또는 스캔본일 수 있습니다. 이미지 문자는 자동 확인으로 처리하지 않았습니다.';}
      else{
        attachment.status='ok';delete attachment.reason;
        const issues=[...(attachment.truncated?['텍스트 한도로 PDF 일부만 읽었습니다.']:[]),...(proof.unreadablePages.length?[`${proof.unreadablePages.join(', ')}쪽은 텍스트를 읽지 못해 원본 확인이 필요합니다.`]:[])];
        if(issues.length)attachment.reason=issues.join(' ');
      }
    }catch(error){
      currentGenerationSignal()?.throwIfAborted();attachment.status='failed';attachment.reason=error instanceof Error?error.message:'PDF 추출 실패';
    }
  }
  const primary=attachments.find(item=>item.role==='primary');
  const text=parts.join('\n\n');
  if(primary?.kind==='pdf'&&primary.status==='ok'&&text.trim().length>=50)return {ok:true,finalUrl,title,text,hash:sha256(text),attachments,contentKind:'pdf'};
  return {ok:false,status:'unsupported',error:primary&&primary.kind!=='pdf'?'GED 모집요강의 주 첨부가 자동 읽기를 지원하지 않는 형식입니다. 첨부 상태를 확인해 주세요.':'GED 모집요강 PDF 본문을 자동 확보하지 못했습니다. 첨부 상태를 확인하거나 원문을 다시 확보해 주세요.',attachments,finalUrl};
}
function failure(e: unknown): ExtractResult {
  if (e instanceof FetchFailure) {
    // Keep the failed stage and redirect reason; do not turn every Google 302 into a publisher denial.
    if (e.kind === "redirect") return { ok: false, status: "unsupported", error: e.message };
    if (e.kind === "blocked") return { ok: false, status: "blocked", error: e.message };
    const restricted = [401, 402, 403, 429].includes(e.status ?? 0);
    return { ok: false, status: restricted ? "blocked" : "failed", error: restricted
      ? `원문 접근 제한(${e.status ? `HTTP ${e.status}` : e.message}) — 로그인·구독·봇 검증·호출 제한은 우회하지 않습니다. 원문을 직접 확인해 주세요.`
      : e.message };
  }
  return { ok: false, status: "failed", error: "원문 조회 실패 — 원문 주소와 연결 상태를 확인해 주세요." };
}

/** Bounded page/URL-lookup/feed requests, all using the shared deadline and caller budget. */
export async function fetchAndExtract(url: string, fetchImpl = safeFetch, context: ArticleContext = {}): Promise<ExtractResult> {
  let target = preferReadableUrl(decodeGoogleNewsUrl(url) || url);
  const visited = new Set<string>(), deadline = Date.now() + 24_000;
  let alternate: PublicArticleAlternate | null = null;
  for (let hop = 0; hop < 3; hop++) {
    currentGenerationSignal()?.throwIfAborted();
    if (visited.has(target)) return { ok: false, status: "failed", error: "원문 연결이 반복되어 중단했습니다." };
    if (Date.now() >= deadline) return { ok: false, status: "failed", error: "원문 확인 시간 한도를 초과했습니다." };
    if (hop > 0 && context.takeExtraCall && !context.takeExtraCall()) return { ok: false, status: "failed", error: "이번 수집의 원문 호출 한도에 도달했습니다. 원문 다시 확보를 눌러 확인해 주세요." };
    visited.add(target);
    let res;
    try { res = await fetchImpl(target, { timeoutMs: Math.min(12_000, deadline - Date.now()), ...(alternate ? { allowedHosts: alternate.allowedHosts } : {}) }); }
    catch (e) { return failure(e); }
    const ct = res.contentType.toLowerCase();
    if (ct.includes("pdf") || res.body.subarray(0, 5).toString() === "%PDF-") {
      if (alternate) return { ok: false, status: "unsupported", error: "공개 대체 페이지가 PDF로 응답해 같은 기사인지 확인하지 못했습니다. 첨부 원문을 직접 확인해 주세요.", finalUrl: url };
      try {
        const text = await extractPdf(res.body);
        if (text.length < 50) return { ok: false, status: "unsupported", error: "텍스트가 없는 PDF(스캔본 가능성) — 수동 확인 필요" };
        return { ok: true, finalUrl: res.finalUrl, title: "", text, hash: sha256(text), attachments: [], contentKind: "pdf" };
      } catch { return { ok: false, status: "unsupported", error: "PDF 텍스트 추출 실패 — 수동 확인 필요" }; }
    }
    const html = decodePublicText(res.body, ct);
    if (!isPublicHtmlResponse(ct, html)) return { ok: false, status: "unsupported", error: `지원하지 않는 형식(${ct.split(";")[0]}) — 수동 확인 필요`, finalUrl: res.finalUrl };
    const restriction = articleAccessProblem(html, res.finalUrl);
    if (restriction) return { ok: false, status: "blocked", error: restriction, finalUrl: res.finalUrl };
    if (alternate && !sameArticleAlternate(html, res.finalUrl, alternate)) return { ok: false, status: "unsupported", error: "공개 대체 페이지가 같은 기사인지 확인하지 못해 본문을 저장하지 않았습니다. 원문을 직접 확인하거나 본문을 붙여넣어 주세요.", finalUrl: url };
    if (/^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:rss|feed|rdf:RDF)(?:\s|>)/i.test(html)) return { ok: false, status: "unsupported", error: "기사 본문 대신 RSS 기사 목록이 응답했습니다. 목록의 제목·요약은 본문으로 사용하지 않습니다. 기사 원문 주소를 확인해 주세요.", finalUrl: res.finalUrl };
    if (isGoogleNewsUrl(res.finalUrl)) {
      let original = googleArticleLink(html, res.finalUrl);
      // Modern opaque IDs need Google's public per-article signature + URL lookup.
      // Reuse the page already fetched; do not request a second Google article page.
      if (!original) {
        try { original = await resolveGoogleNewsArticle(res.finalUrl, html, fetchImpl, { deadline, takeExtraCall: context.takeExtraCall }); }
        catch (e) { return failure(e); }
      }
      if (!original && Date.now() < deadline) {
        try { original = await publisherArticleLink(context, fetchImpl, deadline - Date.now()); }
        catch (e) { return failure(e); }
      }
      if (original) { target = preferReadableUrl(original); continue; }
      return { ok: false, status: "unsupported", error: "Google 뉴스 중간 링크의 원문 주소 조회를 완료하지 못했습니다. Google 응답 형식 변경 또는 원문 연결 정보 누락 가능성이 있습니다. 다른 기사를 추측하거나 제목·요약을 본문으로 저장하지 않았습니다." };
    }
    // A known discovery headline must identify the primary article, even for direct/decoded links.
    if (context.title && articleHeadlines(html, res.finalUrl).length && !matchesPrimaryArticleHeadline(html, context.title, res.finalUrl))
      return { ok: false, status: "unsupported", error: "원문 페이지의 주기사 제목이 수집 제목과 일치하지 않아 본문을 저장하지 않았습니다. 원문 주소를 확인하거나 본문을 직접 붙여넣어 주세요.", finalUrl: res.finalUrl };
    const { title, text, attachments } = extractHtml(html, res.finalUrl, context);
    if(isGedNoticePage(res.finalUrl))return readGedNotice(attachments,res.finalUrl,context.title||title,fetchImpl,context,deadline);
    // MCST press releases publish the actual document as an attachment. The page's
    // HTML paragraphs can contain only licensing/login text, which is not a body.
    const final = new URL(res.finalUrl);
    const mcstDocument = final.hostname.replace(/^www\./, "") === "mcst.go.kr" && /\/s_notice\/press\/pressView\.jsp$/.test(final.pathname) && final.searchParams.has("pSeq");
    if (mcstDocument) {
      const pdfs = attachments.filter(a => a.kind === "pdf");
      const pdf = pdfs.length === 1 ? pdfs[0] : undefined;
      if (pdf && new URL(pdf.url).hostname === final.hostname && (!context.takeExtraCall || context.takeExtraCall())) {
        try {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("원문 확인 시간 한도 초과");
          const document = await fetchImpl(pdf.url, { maxBytes: 8 * 1024 * 1024, timeoutMs: Math.min(12_000, remaining), allowedHosts: [final.hostname], accept: "application/pdf" });
          if (new URL(document.finalUrl).hostname !== final.hostname || document.body.subarray(0, 5).toString() !== "%PDF-") throw new Error("공식 첨부 PDF 응답이 아닙니다");
          const body = await extractPdf(document.body);
          if (body.length < 80) throw new Error("텍스트가 없는 PDF로 직접 확인이 필요합니다");
          pdf.status = "ok";
          return { ok: true, finalUrl: res.finalUrl, title, text: body, hash: sha256(body), attachments, contentKind: "pdf" };
        } catch (error) {
          currentGenerationSignal()?.throwIfAborted();
          pdf.status = "failed"; pdf.reason = error instanceof Error ? error.message : "PDF 추출 실패";
        }
      }
      return { ok: false, status: "unsupported", error: "보도자료 본문은 첨부 문서에 있습니다. PDF를 자동 확보하지 못했거나 호출 한도에 도달했습니다. 원문에서 첨부 문서를 확인해 주세요.", attachments, finalUrl: res.finalUrl };
    }
    if (text.length < 80) {
      if (!alternate) {
        const advertised = publicArticleAlternate(html, res.finalUrl, context);
        if (advertised && !visited.has(advertised.url) && hop < 2) { alternate = advertised; target = advertised.url; continue; }
      }
      return { ok: false, status: "unsupported", error: attachments.length
        ? "본문 대신 첨부 문서가 있는 공고입니다. 첨부 형식과 내용을 원문에서 확인하거나 본문을 붙여넣어 주세요."
        : `공개 HTML·구조화 데이터${alternate ? "·공식 대체 페이지" : ""}에서 충분한 본문을 찾지 못했습니다. 자바스크립트로만 표시되는 페이지이거나 본문 형식 확인이 필요합니다. 원문을 직접 열어 확인하거나 본문을 붙여넣어 주세요.`, attachments, finalUrl: res.finalUrl };
    }
    return { ok: true, finalUrl: res.finalUrl, title, text, hash: sha256(text), attachments, contentKind: "html" };
  }
  return { ok: false, status: "failed", error: "원문 연결 단계 한도를 초과했습니다." };
}
