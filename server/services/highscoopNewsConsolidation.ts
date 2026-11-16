import { eq, sql } from "drizzle-orm";
import type { DB } from "../db";
import { appSettings, channels } from "../../shared/schema";
import { channelCategories } from "../../shared/channelCategories";
import { resolveDiscovery } from "../../shared/domain";
import { canonicalChannelId, channelRedirects } from "./channelRedirects";

export const HIGHSCOOP_NEWS_MERGE_KEY = "highscoop_news_consolidated_v1";
/** Ownership migration only: evidence payloads, revision snapshots and publication identities stay intact. */
export async function consolidateHighscoopNews(db: DB): Promise<boolean> {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(7193211)`);
    if ((await tx.select().from(appSettings).where(eq(appSettings.key, HIGHSCOOP_NEWS_MERGE_KEY))).length) return false;
    const rows = await tx.select().from(channels).for("update");
    const target = rows.find(row => row.slug === "opportunities");
    const sources = rows.filter(row => ["current-dialogue", "science-dialogue"].includes(row.slug));
    if (!target || !sources.length) return false;
    const ids = sources.map(row => row.id), sourceIds = sql.join(ids.map(id => sql`${id}`), sql`, `);
    const scope = sql.join([...ids, target.id].map(id => sql`${id}`), sql`, `);
    await tx.execute(sql`select id from content_items where channel_id in (${scope}) for update`);
    await tx.execute(sql`select id from studio_cards where content->>'channel' in ('news','science','science-dialogue','current-dialogue') or source_item_id in (select id from content_items where channel_id in (${sourceIds})) for update`);
    await tx.execute(sql`select id from jobs where channel_id in (${scope}) and status in ('queued','running') for update`);
    const active = await tx.execute(sql`select id from jobs where status='running' and (channel_id in (${scope}) or payload->>'cardId' in (select id::text from studio_cards where content->>'channel' in ('news','science','science-dialogue','current-dialogue'))) limit 1`);
    if (active.rows.length) throw new Error("하이스쿱 뉴스 통합: 실행 중인 제작 작업을 마친 뒤 다시 시작해 주세요.");
    const activeCanva = await tx.execute(sql`select id from canva_render_jobs where channel_id in (${scope}) and status='running' limit 1`);
    if (activeCanva.rows.length) throw new Error("하이스쿱 뉴스 통합: Canva 제작 작업을 마친 뒤 다시 시작해 주세요.");
    const collision = await tx.execute(sql`select s.id from canva_render_jobs s join canva_render_jobs t on t.channel_id=${target.id} and s.request_id=t.request_id where s.channel_id in (${sourceIds}) limit 1`);
    if (collision.rows.length) throw new Error("하이스쿱 뉴스 통합: 중복 Canva 요청 기록을 보존하기 위해 통합을 중단했습니다.");
    await tx.insert(appSettings).values({ key: "highscoop_news_original_classification_v1", value: {
      sourceIds: ids, targetId: target.id, targetCategories: target.categories, targetBudget: target.budget,
      items: (await tx.execute(sql`select id,channel_id,subcategory from content_items where channel_id in (${sourceIds})`)).rows,
      rules: (await tx.execute(sql`select id,channel_id,subcategory from search_rules where channel_id in (${sourceIds})`)).rows,
    } }).onConflictDoNothing();

    // Preserve duplicate source drafts, including independently pasted evidence.
    await tx.execute(sql`insert into content_sources(content_item_id,source_document_id,role)
      select s.id,s.primary_source_id,'merged_primary' from content_items s where s.channel_id in (${sourceIds}) and s.primary_source_id is not null
      and exists(select 1 from content_items t where t.channel_id=${target.id} and t.primary_source_id=s.primary_source_id)
      on conflict(content_item_id,source_document_id) do nothing`);
    await tx.execute(sql`update content_items s set primary_source_id=null where s.channel_id in (${sourceIds}) and exists(select 1 from content_items t where t.channel_id=${target.id} and t.primary_source_id=s.primary_source_id)`);
    // A source-source duplicate can also occur on a fresh installation before the old merge ran.
    await tx.execute(sql`insert into content_sources(content_item_id,source_document_id,role) select s.id,s.primary_source_id,'merged_primary' from content_items s
      where s.channel_id in (${sourceIds}) and s.primary_source_id is not null and exists(select 1 from content_items t where t.channel_id in (${sourceIds}) and t.primary_source_id=s.primary_source_id and t.id<s.id)
      on conflict(content_item_id,source_document_id) do nothing`);
    await tx.execute(sql`update content_items s set primary_source_id=null where s.channel_id in (${sourceIds}) and exists(select 1 from content_items t where t.channel_id in (${sourceIds}) and t.primary_source_id=s.primary_source_id and t.id<s.id)`);
    await tx.execute(sql`update search_rules s set enabled=false,deleted_at=now(),version=version+1 where s.channel_id in (${sourceIds}) and s.deleted_at is null and exists(select 1 from search_rules t where (t.channel_id=${target.id} or t.channel_id in (${sourceIds}) and t.id<s.id) and t.deleted_at is null and t.endpoint=s.endpoint and t.normalized_query=s.normalized_query)`);
    await tx.execute(sql`update search_rules set subcategory='뉴스' where channel_id in (${sourceIds})`);
    await tx.execute(sql`update official_sources set name=name || ' · 뉴스 통합 #' || id,enabled=false,version=version+1 where channel_id in (${sourceIds})`);
    await tx.execute(sql`update destinations set label=label || ' · 통합 전 계정 #' || id,enabled=false,version=version+1,updated_at=now() where channel_id in (${sourceIds})`);
    await tx.execute(sql`update approvals set status='invalidated',invalidated_reason='하이스쿱 뉴스 통합 후 게시 계정을 다시 확인해 주세요.',updated_at=now() where channel_id in (${sourceIds}) and status='active'`);
    await tx.execute(sql`update deliveries set status='cancelled',last_error='하이스쿱 뉴스 통합 후 새 게시 계정으로 다시 승인해 주세요.',updated_at=now() where channel_id in (${sourceIds}) and status in ('waiting','scheduled')`);
    await tx.execute(sql`update jobs set status='cancelled',finished_at=now(),last_error='하이스쿱 뉴스에서 최신 원고와 설정으로 다시 요청해 주세요.' where status='queued' and (channel_id in (${sourceIds}) or payload->>'cardId' in (select id::text from studio_cards where content->>'channel' in ('news','science','science-dialogue','current-dialogue')))`);
    await tx.execute(sql`update canva_render_jobs set status='cancelled',error_message='하이스쿱 뉴스 통합 후 최신 원고로 다시 요청해 주세요.' where channel_id in (${sourceIds}) and status='queued'`);
    await tx.execute(sql`update canva_masters set template_version=template_version || '-merged-' || id,status='archived' where channel_id in (${sourceIds})`);

    // Advance ownership versions together only where a Canva binding was current before the move.
    await tx.execute(sql`update app_settings a set value=jsonb_set(jsonb_set(a.value,'{lastStudioVersion}',to_jsonb(c.version+1)),'{sourceVersion}',case when i.id is not null then to_jsonb(i.version+1) else coalesce(a.value->'sourceVersion','null'::jsonb) end),updated_at=now()
      from studio_cards c left join content_items i on i.id=c.source_item_id
      where a.key='studio_canva_sync:' || c.id and c.content->>'channel' in ('news','science','science-dialogue','current-dialogue')
      and a.value->>'lastStudioVersion'=c.version::text and (i.id is null or a.value->>'sourceVersion'=i.version::text)`);
    await tx.execute(sql`update studio_cards set content=jsonb_set(jsonb_set(content,'{channel}','"highscoop"'::jsonb),'{subcategory}','"뉴스"'::jsonb),version=version+1,updated_at=now()
      where content->>'channel' in ('news','science','science-dialogue','current-dialogue') or source_item_id in (select id from content_items where channel_id in (${sourceIds}))`);
    await tx.execute(sql`update content_items set subcategory='뉴스',version=version+1,review_status=case when review_status='reviewed' then 'review_required' else review_status end,publish_status=case when publish_status='scheduled' then 'waiting' else publish_status end,updated_at=now() where channel_id in (${sourceIds})`);
    await tx.execute(sql`update content_items set kind='current_dialogue',schedule_status='not_applicable',version=version+1,updated_at=now() where channel_id=${target.id} and subcategory='뉴스' and kind='notice'`);
    for (const table of ["content_items","search_rules","official_sources","runs","media_assets","card_templates","approvals","destinations","deliveries","family_editorial_stages","card_image_prompts","notion_sync_links","canva_masters","canva_render_jobs","family_manual_requests"]) {
      await tx.execute(sql`update ${sql.identifier(table)} set channel_id=${target.id} where channel_id in (${sourceIds})`);
    }
    await tx.execute(sql`update jobs set channel_id=${target.id},payload=case when payload ? 'channelId' then jsonb_set(payload,'{channelId}',to_jsonb(${target.id}::int)) else payload end where channel_id in (${sourceIds})`);
    const news = sources.find(row => row.slug === "current-dialogue") ?? sources[0];
    const categories = [...new Set([...channelCategories(target.slug, target.categories), "뉴스"])];
    const discovery = target.budget.discovery ?? resolveDiscovery("current_dialogue", news.budget.discovery) ?? { enabled: false, autoDraft: false };
    await tx.update(channels).set({ categories, budget: { ...target.budget, discovery }, version: target.version + 1, updatedAt: new Date() }).where(eq(channels.id, target.id));
    for (const source of sources) await tx.update(channels).set({ active: false, name: `${source.name.replace(/ · 통합 보관$/, "")} · 하이스쿱 통합 보관`, version: source.version + 1, updatedAt: new Date() }).where(eq(channels.id, source.id));
    const redirects = { ...await channelRedirects(tx as DB), ...Object.fromEntries(ids.map(id => [id, target.id])) };
    for (const id of Object.keys(redirects)) redirects[id] = canonicalChannelId(Number(id), redirects);
    await tx.insert(appSettings).values({ key: "channel_redirects", value: redirects }).onConflictDoUpdate({ target: appSettings.key, set: { value: redirects, updatedAt: new Date() } });
    const [voice] = await tx.select().from(appSettings).where(eq(appSettings.key, `sns_voice_profile:${target.id}`));
    if (!voice) {
      const [old] = await tx.select().from(appSettings).where(eq(appSettings.key, `sns_voice_profile:${news.id}`));
      if (old) await tx.insert(appSettings).values({ key: `sns_voice_profile:${target.id}`, value: old.value }).onConflictDoNothing();
    }
    await tx.insert(appSettings).values({ key: HIGHSCOOP_NEWS_MERGE_KEY, value: { targetId: target.id, sourceIds: ids, completedAt: new Date().toISOString() } });
    return true;
  });
}
