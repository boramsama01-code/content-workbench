// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { CanvaStudioSync } from "../client/src/CanvaStudioSync";
import { ApiError } from "../client/src/api";
import type { CanvaStudioSyncState } from "../shared/canvaStudioSync";

const mocks = vi.hoisted(() => ({ api:vi.fn(), editing:false, guard:{ hasDirty:vi.fn(), confirmLeave:vi.fn((next:()=>void) => next()) } }));
vi.mock("../client/src/api",async original => ({ ...await original<object>(),api:mocks.api }));
vi.mock("../client/src/state",() => ({ useDirtyGuard:()=>mocks.guard }));
Object.assign(globalThis,{ IS_REACT_ACT_ENVIRONMENT:true });
let root:Root,host:HTMLDivElement,client:QueryClient;
const path = "/studio/cards/18/canva-sync";
const state = (enabled = false,version = 7):CanvaStudioSyncState => ({ binding:{ designId:"DTEST001",editUrl:"https://www.canva.com/design/DTEST001/edit",enabled,lastDesignUpdatedAt:null,lastStudioVersion:version },phase:"idle",cardVersion:version,message:"확인한 연결 상태" });
beforeEach(() => { vi.clearAllMocks(); mocks.editing = false; mocks.guard.hasDirty.mockImplementation(() => mocks.editing); Object.defineProperty(document,"visibilityState",{ configurable:true,value:"visible" }); client = new QueryClient({defaultOptions:{queries:{retry:false}}});host = document.createElement("div");document.body.append(host);root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount());client.clear();host.remove();vi.useRealTimers(); });
async function render(version?:number) { await act(async () => root.render(createElement(QueryClientProvider,{client},createElement(CanvaStudioSync,{cardId:18,version})))); }
function button(label:string) { const value = [...host.querySelectorAll("button")].find(node => node.textContent === label);if(!value)throw new Error(`Missing button ${label}`);return value; }
async function click(label:string) { expect(button(label).disabled).toBe(false);await act(async () => button(label).click()); }
async function design(value:string) { const field = host.querySelector<HTMLInputElement>('[aria-label="Canva 디자인 링크 또는 ID"]')!;await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true})); }); }
const mutations = () => mocks.api.mock.calls.filter(([,options]) => options?.method === "PUT" || options?.method === "POST");

describe("Canva saved-design sync controls",() => {
  it("shows a discovered disabled binding without enabling it automatically",async () => {
    mocks.api.mockResolvedValue({ ...state(),binding:{...state().binding!,discovered:true} });await render(7);
    expect(host.querySelector<HTMLInputElement>('[aria-label="Canva 저장 내용 자동 반영"]')!.checked).toBe(false);
    expect(host.querySelector<HTMLInputElement>('[aria-label="Canva 디자인 링크 또는 ID"]')).toBeNull();
    expect(host.querySelector("a")?.getAttribute("href")).toBe("https://www.canva.com/design/DTEST001/edit");
    expect(mutations()).toHaveLength(0);
  });

  it("connects only after a valid design and explicit enable choice, using the actual Studio version",async () => {
    mocks.api.mockImplementation(async (_:string,options?:{method?:string;body?:any}) => options?.method === "PUT" ? state(options.body.enabled,21) : {...state(false,21),binding:null});
    await render();await design("https://www.canva.com/design/DTEST002/edit");
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(mutations()).toHaveLength(0);
    await click("디자인 연결");
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0][1].body).toMatchObject({version:21,designId:"DTEST002",enabled:true,requestId:expect.any(String)});
  });

  it("checks enabled clean visible designs on a timer and refreshes Studio and source caches after a new version",async () => {
    vi.useFakeTimers();let checks = 0;const invalidate = vi.spyOn(client,"invalidateQueries");
    mocks.api.mockImplementation(async (_:string,options?:{method?:string}) => options?.method === "POST" ? ++checks === 1 ? {...state(true),phase:"exporting"} : {...state(true,8),phase:"needs_text_review",pageCount:11,canonicalMapping:"not_mapped",latestText:"Canva에서 실제로 읽은 새 문구",textStatus:"extracted"} : state(true));
    await render(7);expect(checks).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(checks).toBe(2);
    expect(invalidate.mock.calls.map(([options]) => options!.queryKey)).toEqual(expect.arrayContaining([["studio"],["ch"],["card-copy"]]));
    expect(host.textContent).toContain("11장");
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="최신 Canva 추출 문구"]')!.value).toBe("Canva에서 실제로 읽은 새 문구");
    expect(host.textContent).toContain("문구가 같다고 확정하지 않습니다");
    const before = mocks.api.mock.calls.length;Object.defineProperty(document,"visibilityState",{configurable:true,value:"hidden"});
    await act(async () => vi.advanceTimersByTimeAsync(30000));expect(mocks.api).toHaveBeenCalledTimes(before);
  });

  it("pauses automated checks while edits are dirty and resumes on focus after they are saved",async () => {
    vi.useFakeTimers();mocks.editing = true;mocks.api.mockResolvedValue(state(true));
    await render(7);expect(mutations()).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(15000));expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("편집 중인 입력을 유지");
    mocks.editing = false;await act(async () => window.dispatchEvent(new Event("focus")));
    expect(mutations()).toHaveLength(1);
  });

  it("rechecks an uncertain binding mutation with the same request ID and full input",async () => {
    let puts = 0;mocks.api.mockImplementation(async (_:string,options?:{method?:string}) => {if(options?.method === "PUT"){if(++puts === 1)throw new ApiError(0,"결과 확인 불가");return state(true);}return {...state(),binding:null};});
    await render(7);await design("https://www.canva.com/design/DTEST001/edit");await click("디자인 연결");
    const first = structuredClone(mutations()[0][1].body);
    expect(host.querySelector<HTMLInputElement>('[aria-label="Canva 디자인 링크 또는 ID"]')!.value).toBe("https://www.canva.com/design/DTEST001/edit");
    await click("같은 요청 결과 다시 확인");
    expect(mutations()[1][1].body).toEqual(first);
    expect(mutations()).toHaveLength(2);
  });

  it("keeps an incoming result pending when the user starts editing during the check",async () => {
    let resolve!:(value:CanvaStudioSyncState)=>void;const pending = new Promise<CanvaStudioSyncState>(done => {resolve = done;});
    mocks.api.mockImplementation((_path:string,options?:{method?:string}) => options?.method === "POST" ? pending : Promise.resolve(state(true)));
    const invalidate = vi.spyOn(client,"invalidateQueries");await render(7);mocks.editing = true;
    await act(async () => resolve({...state(true,8),phase:"needs_text_review"}));
    expect(invalidate).not.toHaveBeenCalled();expect(host.textContent).toContain("현재 입력은 유지했습니다");
    await click("최신 결과 확인");expect(mocks.guard.confirmLeave).toHaveBeenCalled();expect(invalidate).toHaveBeenCalled();
  });
});
