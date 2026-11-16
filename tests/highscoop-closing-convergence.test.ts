import {describe,expect,it} from 'vitest';
import sharp from 'sharp';
import {defaultPageDesigns} from '../shared/familyDialogue';
import {FAMILY_ENDING_ASSET_IDS} from '../shared/characterVariantAssets';
import {HIGHSCOOP_CLOSING_COPY} from '../shared/highscoopClosing';
import {familyDialogueCardFixture} from './fixtures/familyDialogueCard';
import {planCarousel,renderCarouselPage,renderCarouselPages} from '../server/services/cardCarousel';
import {highScoopCardPageSvg} from '../server/services/highscoopCardBridge';
import {layoutFamilyDialogueCard,renderFamilyDialogueCard,familyPageText,familyPageTitle} from '../server/services/familyDialogueCard';
import {layoutReadingCard,renderReadingCard,readingPageText} from '../server/services/readingCard';
import {layoutHighscoopClosing} from '../server/services/highscoopClosing';

const style={layout:'minimal' as const};
const context={brandName:'HighScoop',accent:'#2457A6',highscoopOutroTheme:'opportunity' as const};
const input=(copy:ReturnType<typeof familyDialogueCardFixture>,pageDesigns=defaultPageDesigns())=>({kind:'current_dialogue',channelSlug:'opportunities',channelName:'HighScoop',accent:'#FF493B',sourceOrg:'확인한 원문',checkedDate:'2026-11-16',payload:{cardCopy:copy,pageDesigns}});

describe('HighScoop closing across existing renderer paths',()=>{
  it('replaces only the declared v2 outro in the native bridge and keeps all seven factual pages',async()=>{
    const copy=familyDialogueCardFixture();copy.templateKey='highscoop:conversation';
    const designs=defaultPageDesigns();
    designs.outro.outroPresentation={mode:'full_image',assetId:FAMILY_ENDING_ASSET_IDS[0]};
    designs.outro.background={...designs.outro.background,kind:'image',assetId:999999};
    const before=structuredClone({copy,designs}),plan=planCarousel(input(copy,designs),style);
    expect(plan.count).toBe(8);expect(plan.pages).toHaveLength(7);
    expect(plan.highscoopClosing?.appended).toBe(false);
    expect(plan.highscoop?.includeOutro).toBe(true);
    expect(plan.highscoop?.document.pages).toHaveLength(7);
    expect(plan.highscoop?.pageAssetIds).toHaveLength(7);
    expect(plan.highscoop?.outroProfileId).toBeUndefined();
    for(const [index,page] of copy.pages.slice(0,7).entries())expect(plan.highscoop?.document.pages[index].title).toBe(familyPageTitle(page));
    const lastContent=await highScoopCardPageSvg(plan.highscoop!,6,null,'');
    expect(lastContent).toContain('원문에서 확인된 사실은 파랑');
    const final=await highScoopCardPageSvg(plan.highscoop!,7,null,'');
    for(const text of [HIGHSCOOP_CLOSING_COPY.follow,HIGHSCOOP_CLOSING_COPY.introductionText,HIGHSCOOP_CLOSING_COPY.handle,HIGHSCOOP_CLOSING_COPY.actionText])expect(final).toContain(text);
    expect(final).not.toContain('@spacepenguin.co');
    expect(await sharp(await renderCarouselPage(plan,7,style,null,'')).metadata()).toMatchObject({width:1080,height:1350,format:'jpeg'});
    expect({copy,designs}).toEqual(before);
  });

  it('uses the same closing for reading and dialogue styles even when an old penguin ending or profile is selected',async()=>{
    const copy=familyDialogueCardFixture(),outro=copy.pages[7],design=defaultPageDesigns().outro;
    if(outro.id!=='outro')throw new Error('outro');
    outro.fields.logoAssetId='unregistered-old-profile';
    design.outroPresentation={mode:'full_image',assetId:FAMILY_ENDING_ASSET_IDS[0]};
    const expected=layoutHighscoopClosing(context.accent),dialogue=layoutFamilyDialogueCard(outro,design,context,style);
    expect(dialogue.svg).toBe(expected.svg);
    const dialogueBytes=await renderFamilyDialogueCard(outro,design,context,style);
    for(const templateKey of ['reading-ink-lime-v1','cardnews14-sharp-serif-v1']){
      copy.templateKey=templateKey;
      const reading=layoutReadingCard(copy,outro,context);
      expect(reading.svg).toBe(expected.svg);
      expect(readingPageText(copy,outro,context)).toEqual(familyPageText(outro,context));
      expect((await renderReadingCard(copy,outro,design,context)).equals(dialogueBytes)).toBe(true);
    }
    copy.templateKey='reading-ink-lime-v1';
    if(copy.pages[0].id==='cover')copy.pages[0].fields.headline='똑똑함의 기준';
    const plan=planCarousel(input(copy,{...defaultPageDesigns(),outro:design}),style);
    expect(plan.count).toBe(8);
    const pages=await renderCarouselPages(plan,style,null,'');
    expect(pages.at(-1)?.title).toBe(HIGHSCOOP_CLOSING_COPY.title);
    expect(pages.at(-1)?.altText).not.toContain('구독');
  });

  it('preserves another brand’s native closing and its stored profile',async()=>{
    const copy=familyDialogueCardFixture();copy.templateKey='editorial:blue';
    const plan=planCarousel({...input(copy),channelSlug:'current-dialogue',channelName:'알리고당'},style);
    expect(plan.highscoopClosing).toBeUndefined();expect(plan.count).toBe(8);
    expect(plan.highscoop?.includeOutro).toBe(false);expect(plan.highscoop?.document.pages).toHaveLength(8);
    expect(plan.highscoop?.outroProfileId).toBe('brand:space-penguin-company:20261101');
    const final=await highScoopCardPageSvg(plan.highscoop!,7,null,'');
    expect(final).toContain('@test_allligodang');expect(final).not.toContain(HIGHSCOOP_CLOSING_COPY.follow);
  });
});
