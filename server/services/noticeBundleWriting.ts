import {and,eq} from 'drizzle-orm';
import type {DB} from '../db';
import {contentItems,contentRevisions} from '../../shared/schema';
import {noticeBundleFromPayload,noticeBundleWritingContext} from '../../shared/noticeBundle';
import {HttpError} from '../routes/util';

/** Bind writing to the server's source revision, never client-supplied PDF
 * excerpts. Oversize packets fail before a model call instead of silently
 * dropping a later institution's eligibility or deadline. */
export async function loadNoticeBundleWriting(db:DB,itemId:number|null|undefined){
  if(!itemId)return null;
  const [row]=await db.select({revisionId:contentRevisions.id,payload:contentRevisions.payload}).from(contentItems)
    .innerJoin(contentRevisions,and(eq(contentRevisions.id,contentItems.currentRevisionId),eq(contentRevisions.contentItemId,contentItems.id))).where(eq(contentItems.id,itemId));
  const bundle=noticeBundleFromPayload(row?.payload);
  if(!bundle)return null;
  if(bundle.status==='collecting')throw new HttpError(409,'선택한 공고의 자료를 읽는 중입니다. 비교 자료가 준비된 뒤 작성해 주세요.');
  const text=noticeBundleWritingContext(bundle);
  if(text.length>200000)throw new HttpError(422,'공고 자료가 한 번의 작성에 담기에는 많습니다. 공고를 나눠 새 묶음으로 만들어 주세요. 원문과 비교 자료는 모두 보존했습니다.');
  return {itemId,revisionId:row.revisionId,text};
}
