import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../db";
import { contentItems, contentSources, sourceDocuments } from "../../shared/schema";

export function itemSourceIdSql() {
  return sql<number>`coalesce((select ${contentSources.sourceDocumentId} from ${contentSources} where ${contentSources.contentItemId} = ${contentItems.id} and ${contentSources.role} in ('manual_primary', 'merged_primary') order by case when ${contentSources.role} = 'manual_primary' then 0 else 1 end, ${contentSources.id} desc limit 1), ${contentItems.primarySourceId}, (select ${contentSources.sourceDocumentId} from ${contentSources} where ${contentSources.contentItemId} = ${contentItems.id} and ${contentSources.role} = 'bundle_primary' order by ${contentSources.id} limit 1))`;
}

/** Keep the collected primary ID for deduplication; pasted text belongs to this item only. */
export async function itemPrimarySource(db: DB, item: { id: number; primarySourceId: number | null }) {
  const [manual] = await db.select({ doc: sourceDocuments }).from(contentSources)
    .innerJoin(sourceDocuments, eq(contentSources.sourceDocumentId, sourceDocuments.id))
    .where(and(eq(contentSources.contentItemId, item.id), inArray(contentSources.role, ["manual_primary", "merged_primary"]))).orderBy(sql`case when ${contentSources.role} = 'manual_primary' then 0 else 1 end`).limit(1);
  if (manual) return manual.doc;
  if(item.primarySourceId)return (await db.select().from(sourceDocuments).where(eq(sourceDocuments.id,item.primarySourceId)))[0]??null;
  const [bundle]=await db.select({doc:sourceDocuments}).from(contentSources).innerJoin(sourceDocuments,eq(contentSources.sourceDocumentId,sourceDocuments.id)).where(and(eq(contentSources.contentItemId,item.id),eq(contentSources.role,'bundle_primary'))).limit(1);
  return bundle?.doc??null;
}

