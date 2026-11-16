import {describe,it,expect} from 'vitest';
import {buildNoticeBundlePayload,noticeBundleRequestSchema,noticeBundleWritingContext,type NoticeBundle} from '../shared/noticeBundle';
import {cardCopySchema} from '../shared/cardCopy';
import {planCarousel,renderCarouselPage} from '../server/services/cardCarousel';
import sharp from 'sharp';
const fixture=():NoticeBundle=>({version:1,status:'ready',sourceItemIds:[10,20],instruction:'지역별 영재학급 비교',createdAt:'2026-11-16T00:00:00.000Z',rows:[
 {itemId:10,title:'가 영재학급',url:'https://example.org/a',sourceId:100,fetchStatus:'ok',text:'가 기관 원문',extracted:{organization:'가 기관',academic_year:'2027',audience:'현재 초등학교 5학년',eligibility:'가 지역 재학생만',schedules:[{kind:'apply',label:'학생 접수',end:{date:'2026-11-20'},raw:'학생 접수 11월 20일까지'},{kind:'other',label:'교사 추천',end:{date:'2026-11-25'},raw:'교사 추천 11월 25일까지'}],key_details:'20명 선발',uncertainties:[]},attachments:[{name:'가 모집요강.pdf',url:'https://example.org/a.pdf',kind:'pdf',status:'ok',pages:[{page:3,text:'지원자는 가 지역 재학생이어야 합니다.'}]}]},
 {itemId:20,title:'나 영재학급',url:'https://example.org/b',sourceId:200,fetchStatus:'ok',text:'나 기관 원문',extracted:{organization:'나 기관',academic_year:'2027',audience:'현재 중학교 1학년',eligibility:'나 지역 거주자',schedules:[{kind:'apply',label:'학생 접수',end:{date:'2026-12-01'},raw:'12월 1일 마감'}],key_details:'정원은 원문에서 확인',uncertainties:[]}},
]});
describe('모집 공고 묶음의 기관별 사실 보존',()=>{
 it('중복·타입·개수 범위를 검증한다',()=>{
  const request={itemIds:[10,20],requestId:crypto.randomUUID()};expect(noticeBundleRequestSchema.safeParse(request).success).toBe(true);
  for(const itemIds of [[10],[10,10],Array.from({length:11},(_,i)=>i+1)])expect(noticeBundleRequestSchema.safeParse({...request,itemIds}).success).toBe(false);
 });
 it('기관별 학년과 지역, 학생 마감과 추천 마감을 같은 글에서도 구분해 보존한다',()=>{
  const bundle=fixture(),before=JSON.stringify(bundle),payload=buildNoticeBundlePayload(bundle,'영재학급, 우리 지역 조건부터');
  const copy=cardCopySchema.parse(payload.cardCopy),text=copy.pages.map(p=>p.body).join('\n');
  for(const phrase of ['가 기관','현재 초등학교 5학년','가 지역 재학생만','학생 접수 11월 20일까지','교사 추천 11월 25일까지','나 기관','현재 중학교 1학년','나 지역 거주자','12월 1일 마감'])expect(text).toContain(phrase);
  expect(payload.organization).toBeNull();expect(payload.schedules).toEqual([]);expect(payload.deadline_type).toBe('unknown');
  expect(JSON.stringify(bundle)).toBe(before);
 });
 it('못 읽은 공고도 남기고 원문에 없는 날짜와 페이지를 만들지 않는다',()=>{
  const bundle=fixture();bundle.status='partial';bundle.rows[1]={...bundle.rows[1],fetchStatus:'blocked',extracted:null,issue:'접근 제한으로 읽지 못했습니다.'};
  const payload=buildNoticeBundlePayload(bundle,'함께 확인할 영재학급'),context=noticeBundleWritingContext(bundle);
  expect(payload.has_conflict).toBe(true);expect((payload.noticeBundle as NoticeBundle).rows).toHaveLength(2);
  expect(context).toContain('가 모집요강.pdf 3쪽:');expect(context).toContain('접근 제한으로 읽지 못했습니다.');expect(context).toContain('가 지역 재학생만');expect(context).not.toContain('나 기관 원문');
  expect(context).not.toContain('나 모집요강.pdf 1쪽');
 });
 it('카드 한 편 분량을 넘으면 나머지를 버리지 않고 비교 자료 전체를 유지한다',()=>{
  const bundle=fixture();bundle.rows[0].extracted!.eligibility='길지만 빠뜨릴 수 없는 조건입니다. '.repeat(300);
  const payload=buildNoticeBundlePayload(bundle,'긴 요강 비교');
  expect(payload.cardCopy).toBeUndefined();expect(payload.noticeBundle).toEqual(bundle);
  expect((payload.uncertainties as string[]).some(text=>text.includes('나누거나'))).toBe(true);
 });
 it('기관별 비교 초안을 기존 HighScoop 편집·이미지 출력 경로로 바로 전달한다',async()=>{
  const payload=buildNoticeBundlePayload(fixture(),'영재학급, 조건부터 비교해요'),style={layout:'magazine' as const,highscoopTemplateKey:'highscoop:gifted'};
  const plan=planCarousel({kind:'notice',payload,channelName:'HighScoop',channelSlug:'opportunities',accent:'#FF493B',sourceOrg:'선택한 기관별 모집 공고',checkedDate:'2026-11-16'},style);
  const body=await renderCarouselPage(plan,1,style,null,'');
  expect(await sharp(body).metadata()).toMatchObject({width:1080,height:1350,format:'jpeg'});
  expect(plan.count).toBe(cardCopySchema.parse(payload.cardCopy).pages.length+2);
 });
});
