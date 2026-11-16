// @vitest-environment jsdom
import { act,createElement } from "react";
import { createRoot,type Root } from "react-dom/client";
import { QueryClient,QueryClientProvider } from "@tanstack/react-query";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { StudioPage } from "../client/src/pages/Studio";
import { studioContentSchema,type StudioCardDetail } from "../shared/studio";

const mocks = vi.hoisted(() => ({ api:vi.fn(),dirty:new Map<string,boolean>(),leave:vi.fn(),guard:{setDirty:vi.fn(),hasDirty:vi.fn(),confirmLeave:vi.fn()} }));
vi.mock("../client/src/api",async original => ({...await original<object>(),api:mocks.api}));
vi.mock("../client/src/state",() => ({useDirtyGuard:()=>mocks.guard,useChannel:()=>({allChannels:[],channels:[],select:vi.fn()})}));
vi.mock("../client/src/toast",() => ({useToast:()=>vi.fn()}));
vi.mock("../client/src/CanvaStudioSync",() => ({CanvaStudioSync:()=>null}));
vi.mock("../client/src/pages/FinishedDeckEditor",() => ({FinishedDeckEditor:({data}:{data:StudioCardDetail}) => createElement("div",{"data-testid":"new-finished-deck"},`${data.card.finishedDeck?.pages.length}장의 실제 Canva 결과`)}));
vi.mock("../client/src/pages/SourceStudioCard",async () => {const React = await import("react");return {SourceStudioCard:()=>{const [value,setValue]=React.useState("기존 여덟 장 원고");React.useEffect(()=>{mocks.guard.setDirty("source-editor",value!=="기존 여덟 장 원고");return()=>mocks.guard.setDirty("source-editor",false);},[value]);return React.createElement("textarea",{"aria-label":"원래 8장 편집 입력",value,onChange:(event:{target:{value:string}})=>setValue(event.target.value)});}};});
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let root:Root,host:HTMLDivElement,client:QueryClient,detail:StudioCardDetail;
const key = ["studio","card",8];
const withCanvaOutput = ():StudioCardDetail => ({...detail,card:{...detail.card,version:2,finishedDeck:{pages:Array.from({length:11},(_,index)=>({imageId:index+1,name:`Canva ${index+1}.png`,altText:""}))}}});
beforeEach(()=>{vi.clearAllMocks();mocks.dirty.clear();mocks.guard.setDirty.mockImplementation((key:string,dirty:boolean)=>{if(dirty)mocks.dirty.set(key,true);else mocks.dirty.delete(key);});mocks.guard.hasDirty.mockImplementation(()=>mocks.dirty.size>0);mocks.guard.confirmLeave.mockImplementation(mocks.leave);detail={card:{...studioContentSchema.parse({title:"8장 뉴스 원고",channel:"news",format:"카드뉴스",script:"",memo:""}),id:8,version:1,sourceItemId:44,sourceReference:{itemId:44,channelId:3},createdAt:"2026-11-16T00:00:00Z",updatedAt:"2026-11-16T00:00:00Z"},jobs:[],revisions:[]};mocks.api.mockImplementation(async(path:string)=>{if(path==="/studio/cards/8")return detail;throw Error(path);});client=new QueryClient({defaultOptions:{queries:{retry:false}}});host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());client.clear();host.remove();});
async function render(){await act(async()=>root.render(createElement(QueryClientProvider,{client},createElement(StudioPage,{cardId:8}))));await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});}
async function receive(next:StudioCardDetail){await act(async()=>{client.setQueryData(key,next);await new Promise(resolve=>setTimeout(resolve,20));});}

describe("Canva output editor transitions",()=>{
  it("keeps the dirty source editor mounted until the operator explicitly resolves the view change",async()=>{
    await render();const field=host.querySelector<HTMLTextAreaElement>('[aria-label="원래 8장 편집 입력"]')!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(field,"저장 전 직접 다듬은 원고");field.dispatchEvent(new Event("input",{bubbles:true}));});
    await receive(withCanvaOutput());
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="원래 8장 편집 입력"]')!.value).toBe("저장 전 직접 다듬은 원고");
    expect(host.querySelector('[data-testid="new-finished-deck"]')).toBeNull();
    const switchButton=[...host.querySelectorAll("button")].find(node=>node.textContent==="저장·대조 후 최신 결과 열기")!;
    await act(async()=>switchButton.click());expect(mocks.leave).toHaveBeenCalled();
    expect(host.querySelector('[data-testid="new-finished-deck"]')).toBeNull();
    await act(async()=>{mocks.dirty.clear();mocks.leave.mock.calls.at(-1)![0]();});
    expect(host.querySelector('[data-testid="new-finished-deck"]')?.textContent).toContain("11장");
    expect(mocks.api.mock.calls.some(([,options])=>options?.method==="PATCH")).toBe(false);
  });

  it("opens newly synced pages when the source editor is clean",async()=>{
    await render();await receive(withCanvaOutput());
    expect(host.querySelector('[data-testid="new-finished-deck"]')?.textContent).toContain("11장");
    expect(host.querySelector('[aria-label="원래 8장 편집 입력"]')).toBeNull();
  });

  it("shows actual synced pages for a Notion-linked card without pretending they are the original structured fields",async()=>{
    detail={...withCanvaOutput(),card:{...withCanvaOutput().card,notionLinkId:6,channel:"highscoop"}};await render();
    expect(host.querySelector('[data-testid="new-finished-deck"]')?.textContent).toContain("11장");
    expect(host.querySelector('[aria-label="원래 8장 편집 입력"]')).toBeNull();
  });
});
