import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CanvaStudioSyncState } from "@shared/canvaStudioSync";
import { canvaDesignIdFromInput } from "@shared/canvaReconciliation";
import { api, ApiError } from "./api";
import { useDirtyGuard } from "./state";
import "./canvaStudioSync.css";

const phaseLabels = { idle:"연결됨", checking:"저장 변경 확인 중", exporting:"Canva 결과 가져오는 중", synced:"새 버전 반영됨", conflict:"버전 대조 필요", needs_text_review:"이미지 반영 · 문구 대조 필요", result_unknown:"처리 결과 확인 필요", failed:"연동 확인 필요" };
type PendingOperation = { method:"PUT"|"POST"; path:string; body:{ version:number; requestId:string; designId?:string; enabled?:boolean } };
const pageVisible = () => document.visibilityState !== "hidden";

export function CanvaStudioSync({ cardId, version }: { cardId:number; version?:number }) {
  const qc = useQueryClient(), guard = useDirtyGuard();
  const [state,setState] = useState<CanvaStudioSyncState | null>(null), stateRef = useRef(state);
  const [designInput,setDesignInput] = useState(""), [enableOnConnect,setEnableOnConnect] = useState(false);
  const [busy,setBusy] = useState(false), [loading,setLoading] = useState(true), [paused,setPaused] = useState(false), [incoming,setIncoming] = useState(false);
  const [error,setError] = useState(""), [unknown,setUnknown] = useState<PendingOperation | null>(null);
  const lock = useRef(false), mounted = useRef(true), unknownRef = useRef<PendingOperation | null>(null), lastVersion = useRef<number | null>(version ?? null);
  const hasEdits = () => guard.hasDirty?.() ?? false;
  const refreshEditors = () => { void qc.invalidateQueries({ queryKey:["studio"] }); void qc.invalidateQueries({ queryKey:["ch"] }); void qc.invalidateQueries({ queryKey:["card-copy"] }); };
  function accept(next:CanvaStudioSyncState) {
    if (!mounted.current || stateRef.current && next.cardVersion < stateRef.current.cardVersion) return;
    stateRef.current = next; setState(next); qc.setQueryData(["canva-studio-sync",cardId],next);
    if (lastVersion.current !== null && next.cardVersion > lastVersion.current) {
      if (hasEdits()) setIncoming(true);
      else { lastVersion.current = next.cardVersion; setIncoming(false); refreshEditors(); }
    } else if (lastVersion.current === null) lastVersion.current = next.cardVersion;
  }
  async function perform(operation:PendingOperation) {
    try {
      const next = await api<CanvaStudioSyncState>(operation.path,{ method:operation.method,body:operation.body });
      if (!mounted.current) return;
      accept(next); setError(""); setUnknown(null); unknownRef.current = null;
      if (operation.method === "PUT") { setDesignInput(""); setEnableOnConnect(false); }
    } catch (caught) {
      if (!mounted.current) return;
      setError(caught instanceof Error ? caught.message : "Canva 연동 결과를 확인하지 못했습니다.");
      if (caught instanceof ApiError && (caught.status === 0 || caught.body.resultUnknown === true)) { unknownRef.current = operation; setUnknown(operation); }
    }
  }
  async function refresh(checkChanges = true, initial = false) {
    if (lock.current || !pageVisible()) return;
    const editing = hasEdits(); setPaused(editing);
    if (editing && !initial) return;
    lock.current = true;
    try {
      const next = await api<CanvaStudioSyncState>(`/studio/cards/${cardId}/canva-sync`);
      if (!mounted.current) return;
      accept(next); setError("");
      if (checkChanges && !hasEdits() && !unknownRef.current && next.binding?.enabled && !["conflict","result_unknown","failed"].includes(next.phase)) {
        await perform({ method:"POST",path:`/studio/cards/${cardId}/canva-sync/check`,body:{ version:next.cardVersion,requestId:crypto.randomUUID() } });
      }
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : "Canva 상태를 불러오지 못했습니다."); }
    finally { lock.current = false; if (mounted.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true; void refresh(true,true);
    const timer = setInterval(() => void refresh(),15000), focus = () => { if (pageVisible()) void refresh(); };
    window.addEventListener("focus",focus); document.addEventListener("visibilitychange",focus);
    return () => { mounted.current = false; clearInterval(timer); window.removeEventListener("focus",focus); document.removeEventListener("visibilitychange",focus); };
  },[cardId]);
  async function bind(enabled:boolean) {
    if (lock.current || hasEdits() || unknownRef.current) { setPaused(hasEdits()); return; }
    const current = stateRef.current, designId = current?.binding?.designId ?? canvaDesignIdFromInput(designInput);
    if (!current || !designId) { setError("Canva 디자인 링크 또는 ID를 확인해 주세요."); return; }
    lock.current = true; setBusy(true);
    try { await perform({ method:"PUT",path:`/studio/cards/${cardId}/canva-sync`,body:{ version:current.cardVersion,designId,enabled,requestId:crypto.randomUUID() } }); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  async function checkNow() {
    if (lock.current || hasEdits()) { setPaused(hasEdits()); return; }
    const current = stateRef.current;
    if (!current?.binding && !unknownRef.current) return;
    lock.current = true; setBusy(true);
    try { await perform(unknownRef.current ?? { method:"POST",path:`/studio/cards/${cardId}/canva-sync/check`,body:{ version:current!.cardVersion,requestId:crypto.randomUUID() } }); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  const binding = state?.binding, disabled = busy || loading || !!unknown || paused;
  const editUrl = binding ? binding.editUrl && canvaDesignIdFromInput(binding.editUrl) === binding.designId ? binding.editUrl : `https://www.canva.com/design/${encodeURIComponent(binding.designId)}/edit` : null;
  return <section className="canva-studio-sync" aria-label="Canva 저장 연동">
    <div className="canva-sync-heading"><div><strong>Canva 저장 연동</strong><p>연결한 디자인의 저장 변경을 확인해 스튜디오 새 버전으로 가져옵니다.</p></div><span className="canva-sync-phase" data-phase={state?.phase ?? "idle"}>{loading ? "연결 확인 중" : binding ? phaseLabels[state!.phase] : "디자인 연결 전"}</span></div>
    {binding ? <div className="canva-sync-controls"><a className="btn sm" href={editUrl!} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Canva에서 편집 ↗</a><label className="check"><input type="checkbox" aria-label="Canva 저장 내용 자동 반영" checked={binding.enabled} disabled={disabled} onChange={event => void bind(event.target.checked)} /><span>저장 내용 자동 반영</span></label><button type="button" className="btn sm ghost" disabled={busy || loading || paused} onClick={() => void checkNow()}>{busy ? "연동 확인 중…" : unknown ? "같은 요청 결과 다시 확인" : "지금 변경 확인"}</button></div>
      : state && <div className="canva-sync-connect"><label className="field">Canva 디자인 링크 또는 ID<input aria-label="Canva 디자인 링크 또는 ID" value={designInput} maxLength={8192} disabled={disabled} onChange={event => setDesignInput(event.target.value)} placeholder="https://www.canva.com/design/…/edit" /></label><label className="check"><input type="checkbox" checked={enableOnConnect} disabled={disabled} onChange={event => setEnableOnConnect(event.target.checked)} /><span>연결한 뒤 저장 내용을 자동 반영</span></label><button type="button" className="btn sm" disabled={disabled || !canvaDesignIdFromInput(designInput)} onClick={() => void bind(enableOnConnect)}>디자인 연결</button>{unknown && <button type="button" className="btn sm" disabled={busy || paused} onClick={() => void checkNow()}>같은 요청 결과 다시 확인</button>}</div>}
    {paused && <p className="notice small">편집 중인 입력을 유지하기 위해 화면의 자동 확인을 잠시 멈췄습니다. 저장·대조한 뒤 다시 확인해 주세요.</p>}
    {incoming && <p className="notice warn small">새 Canva 결과가 있습니다. 현재 입력은 유지했습니다. <button type="button" className="btn sm" onClick={() => guard.confirmLeave(() => { lastVersion.current = stateRef.current?.cardVersion ?? null; setIncoming(false); refreshEditors(); })}>최신 결과 확인</button></p>}
    {state?.message && <p className="small" role="status">{state.message}{state.pageCount ? ` · ${state.pageCount}장` : ""}</p>}
    {binding && state && ["failed","conflict","result_unknown"].includes(state.phase) && !unknown && <div className="stack"><p className="small muted">현재 스튜디오 저장본과 Canva 결과를 대조한 뒤 같은 디자인으로 연결 기준을 다시 저장해 주세요.</p><div><button type="button" className="btn sm" disabled={busy || loading || paused} onClick={() => void bind(binding.enabled)}>현재 저장본 기준으로 다시 연결</button></div></div>}
    {state?.canonicalMapping === "not_mapped" && <p className="small muted">Canva 출력과 추출 문구를 가져왔습니다. 기존 카드 편집 칸과의 대응은 검증되지 않았으므로 문구가 같다고 확정하지 않습니다.</p>}
    {state?.latestText && <details><summary>최신 Canva에서 읽은 문구 확인</summary><label className="field">추출 문구<textarea aria-label="최신 Canva 추출 문구" readOnly rows={6} value={state.latestText} onFocus={event => event.target.select()} /></label>{state.textStatus === "partial" && <p className="small muted">일부 문구만 추출됐습니다. 실제 Canva 결과와 대조해 주세요.</p>}</details>}
    {binding?.enabled && <p className="small muted">화면이 보일 때 15초마다 변경을 확인합니다. 화면을 닫은 뒤에도 이 PC의 연결 작업기가 실행 중이면 확인을 이어갑니다.</p>}
    {unknown && <p className="notice warn small">직전 요청의 처리 여부가 확인되지 않았습니다. 같은 요청을 다시 확인할 때까지 새 연결·자동 확인을 시작하지 않습니다.</p>}
    {error && <p className="notice warn small" role="alert">{error}</p>}
    {!binding && !loading && !state && <button type="button" className="btn sm" onClick={() => void refresh(false,true)}>Canva 상태 다시 확인</button>}
  </section>;
}
