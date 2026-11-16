/** Actual downloaded document text. Page numbers are supplied by the PDF parser. */
export type SourceAttachment = {
  url:string; name:string; kind:string; status:string; reason?:string;
  role?:'primary'|'supplement';
  pages?:Array<{page:number;text:string}>; pageCount?:number;
  pdfSha256?:string; textSha256?:string; truncated?:boolean; unreadablePages?:number[];
};
