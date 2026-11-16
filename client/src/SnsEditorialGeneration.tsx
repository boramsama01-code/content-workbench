import { useEffect, useRef, useState } from "react";
import { aiProviderLabels, type AiProvider } from "@shared/aiProviders";
import type { SnsEditorialInput } from "@shared/snsEditorial";
import type { SnsEditorialDraftReply, SnsEditorialDraftRequest } from "@shared/snsEditorialDraft";
import type { CodexWriterStatus, CodexWriterJobView, CodexWriterResult } from "@shared/codexWriter";
import type { StudioCardDetail } from "@shared/studio";
import { api, ApiError } from "./api";
import { useDirtyGuard } from "./state";

export type SnsEditorialTarget = { id: number; version?: number; provider?: AiProvider };
export type SnsEditorialApply = { title?: (text: string) => void; script?: (text: string) => void; caption?: (text: string) => void };
type WriterMode = "api" | "codex";
type Receipt = { targetId: number; body: SnsEditorialDraftRequest; contextSignature: string; originInput: SnsEditorialInput; writer: WriterMode };
type Active = { controller: AbortController; receipt: Receipt | null; ignore: boolean };
const inputSignature = (value: SnsEditorialInput) => JSON.stringify([value.task,value.topic,value.audience,value.format,value.channel,value.referenceText,value.existingText,value.instruction]);
function pollDelay(signal: AbortSignal) {
  return new Promise<void>((resolve,reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort",abort); resolve(); },3000);
    signal.addEventListener("abort",abort,{ once:true });
  });
}

export function SnsEditorialGeneration({ input, target, disabled, onApply, active: visible = false }: {
  input: SnsEditorialInput; target?: SnsEditorialTarget; disabled: boolean; onApply?: SnsEditorialApply; active?: boolean;
}) {
  const guard = useDirtyGuard();
  const [providerOverride, setProviderOverride] = useState<AiProvider | null>(null);
  const provider = providerOverride ?? target?.provider ?? "gemini";
  const [writer, setWriter] = useState<WriterMode>("api"), writerTouched = useRef(false);
  const [codexStatus,setCodexStatus] = useState<CodexWriterStatus | null>(null), [codexChecking,setCodexChecking] = useState(false), [codexStatusError,setCodexStatusError] = useState("");
  const codexChecked = useRef(false), statusFlight = useRef<AbortController | null>(null);
  const [codexJob,setCodexJob] = useState<CodexWriterJobView | null>(null);
  const [working, setWorking] = useState(false), [cancelling, setCancelling] = useState(false);
  const [unresolved, setUnresolved] = useState<Receipt | null>(null);
  const [activeReceipt, setActiveReceipt] = useState<Receipt | null>(null);
  const [result, setResult] = useState<SnsEditorialDraftReply | CodexWriterResult | null>(null);
  const [resultWriter,setResultWriter] = useState<WriterMode>("api");
  const [resultInput, setResultInput] = useState("");
  const [resultOrigin, setResultOrigin] = useState<SnsEditorialInput | null>(null);
  const [feedback, setFeedback] = useState(""), [selectedHook, setSelectedHook] = useState<string | null>(null);
  const feedbackField = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const active = useRef<Active | null>(null), mounted = useRef(true);
  const changed = !!result && resultInput !== inputSignature(input);
  const codexReviewBlocked = resultWriter === "codex" && (!result || !("qualityReview" in result) || result.qualityReview?.passed !== true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (active.current) { active.current.ignore = true; active.current.controller.abort(); } }; }, []);
  async function refreshCodexStatus() {
    if (statusFlight.current || !target) return;
    const controller = new AbortController(); statusFlight.current = controller;
    if (!codexChecked.current) setCodexChecking(true);
    try {
      const next = await api<CodexWriterStatus>("/studio/codex-writer/status",{ signal:controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      setCodexStatus(next); setCodexStatusError("");
      if (next.online && !writerTouched.current) setWriter("codex");
    } catch (caught) {
      if (!mounted.current || controller.signal.aborted) return;
      setCodexStatus(null); setCodexStatusError(caught instanceof Error ? caught.message : "Codex 연결 상태를 확인하지 못했습니다.");
    } finally {
      if (statusFlight.current === controller) statusFlight.current = null;
      if (mounted.current && !controller.signal.aborted) { codexChecked.current = true; setCodexChecking(false); }
    }
  }
  useEffect(() => {
    if (!visible || !target) return;
    void refreshCodexStatus();
    const timer = setInterval(() => void refreshCodexStatus(),15000);
    return () => { clearInterval(timer); statusFlight.current?.abort(); statusFlight.current = null; };
  },[visible,target?.id]);
  useEffect(() => {
    const key = `sns-editorial-request:${target?.id ?? "none"}`;
    guard.setDirty(key, working || cancelling || !!unresolved || !!feedback.trim() || !!selectedHook, async () => false);
    return () => guard.setDirty(key, false);
  }, [working, cancelling, unresolved, feedback, selectedHook, target?.id, guard]);

  async function generate(refine = false) {
    if (!target || disabled || active.current || cancelling) return;
    if (!unresolved && (visible && !codexChecked.current || writer === "codex" && !codexStatus?.online)) return;
    if (refine && (!result || changed || unresolved || !feedback.trim() && !selectedHook)) return;
    const flight: Active = { controller: new AbortController(), receipt: null, ignore: false };
    active.current = flight; setWorking(true); setError(""); setMessage(""); setCodexJob(null);
    let receipt = unresolved;
    try {
      if (!receipt) {
        const originInput = refine ? { ...(resultOrigin ?? input) } : { ...input };
        let requestInput = originInput;
        if (refine && result) {
          const previousDraft = JSON.stringify({ hooks: result.hooks.map(hook => ({ angle: hook.angle, text: hook.text })), finalCopy: result.finalCopy }, null, 2);
          requestInput = { ...originInput,
            existingText: `${originInput.existingText}\n\n[바로 이전 AI 제안 · 미확인 편집 초안이며 사실 근거가 아님]\n${previousDraft}`,
            instruction: `${originInput.instruction}\n\n[이 제안에서 이어 다듬기]\n처음 제공한 확인 자료(referenceText)를 사실 근거로 우선한다. 이전 AI 제안과 이번 피드백을 새로운 사실·실제 경험의 증거로 사용하지 않는다. 이전 제안을 이번 수정 요청에 맞게 다듬고, 바꾸라고 하지 않은 사실·시제·조건과 문체는 유지한다. 공개 최종 문구와 편집 설명을 분리한다.${selectedHook ? `\n[사용자가 선택한 훅]\n${selectedHook}\n이 훅의 문구를 살려 이어가되, 원래 근거와 모순되면 이유와 최소 수정안을 제시한다.` : ""}\n[이번 수정 요청]\n${feedback.trim() || "선택한 훅을 중심으로 구성과 최종 문구를 다듬어 주세요."}` };
          if (requestInput.existingText.length > 24000) throw new Error("원래 원고와 이전 제안을 합친 내용이 24,000자를 넘습니다. 입력과 이전 제안은 유지했습니다. 필요한 문구를 원고에 골라 넣은 뒤 새 제안을 요청해 주세요.");
          if (requestInput.instruction.length > 8000) throw new Error("기존 지시와 이번 수정 요청을 합친 내용이 8,000자를 넘습니다. 피드백은 유지했습니다. 수정할 핵심을 짧게 정리해 주세요.");
        }
        const version = target.version ?? (await api<StudioCardDetail>(`/studio/cards/${target.id}`, { signal: flight.controller.signal })).card.version;
        receipt = { targetId: target.id, body: { ...requestInput, version, requestId: crypto.randomUUID(), ...(writer === "api" ? { provider } : {}) }, contextSignature: inputSignature(originInput), originInput, writer };
      }
      flight.receipt = receipt; setActiveReceipt(receipt);
      let proposal: SnsEditorialDraftReply | CodexWriterResult;
      if (receipt.writer === "codex") {
        const path = `/studio/cards/${receipt.targetId}/codex-draft`;
        let job = await api<CodexWriterJobView>(path,{ method:"POST",body:receipt.body,signal:flight.controller.signal });
        if (mounted.current && !flight.ignore) setCodexJob(job);
        while (job.status === "queued" || job.status === "running") {
          await pollDelay(flight.controller.signal);
          job = await api<CodexWriterJobView>(`${path}/${receipt.body.requestId}`,{ signal:flight.controller.signal });
          if (mounted.current && !flight.ignore) setCodexJob(job);
        }
        if (job.status !== "succeeded") throw new ApiError(422,job.error || (job.status === "cancelled" ? "Codex 작업이 중단됐습니다." : "Codex가 제안을 완성하지 못했습니다."),{ jobStatus:job.status });
        if (!job.result) throw new ApiError(0,"Codex 완료 결과를 확인하지 못했습니다. 같은 요청을 다시 확인해 주세요.",{ resultUnknown:true });
        proposal = job.result;
      } else proposal = await api<SnsEditorialDraftReply>(`/studio/cards/${receipt.targetId}/editorial-draft`, { method: "POST", body: receipt.body, signal: flight.controller.signal });
      if (!mounted.current || flight.ignore) return;
      setResult(proposal); setResultWriter(receipt.writer); setResultInput(receipt.contextSignature); setResultOrigin(receipt.originInput); setUnresolved(null); setFeedback(""); setSelectedHook(null);
    } catch (caught) {
      if (!mounted.current || flight.ignore) return;
      setError(caught instanceof Error ? caught.message : "제안을 받지 못했습니다. 입력은 유지했습니다.");
      if (receipt && caught instanceof ApiError && (caught.status === 0 || caught.body.jobStatus === "running" || caught.body.jobStatus === "queued")) setUnresolved(receipt);
      else setUnresolved(null);
    } finally {
      if (active.current === flight) active.current = null;
      if (mounted.current) { setWorking(false); setActiveReceipt(null); }
    }
  }
  async function cancel() {
    const flight = active.current, receipt = flight?.receipt ?? unresolved;
    if (cancelling || !receipt) return;
    if (flight) { flight.ignore = true; flight.controller.abort(); }
    setCancelling(true); setError("");
    try {
      const codex = receipt.writer === "codex";
      const response = await api<{ cancelled: boolean } | CodexWriterJobView>(`/studio/cards/${receipt.targetId}/${codex ? "codex-draft" : "editorial-draft"}/${receipt.body.requestId}/cancel`, { method: "POST", body: {} });
      if (!mounted.current) return;
      if ("status" in response) setCodexJob(response);
      if ("cancelled" in response ? response.cancelled : response.status === "cancelled") { setUnresolved(null); setMessage("요청 중단을 확인했습니다. 기존 원고는 유지했습니다."); }
      else { setUnresolved(receipt); setMessage("중단이 확정되지 않았거나 이미 완료됐을 수 있습니다. 같은 요청의 결과를 다시 확인하세요."); }
    } catch (caught) { if (mounted.current) { setUnresolved(receipt); setError(caught instanceof Error ? caught.message : "중단 여부를 확인하지 못했습니다."); } }
    finally { if (mounted.current) setCancelling(false); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setMessage("선택한 문구를 복사했습니다."); }
    catch { setMessage("자동 복사가 되지 않았습니다. 아래 문구를 직접 선택해 복사해 주세요."); }
  }
  const apply = (kind: keyof SnsEditorialApply, text: string) => {
    if (disabled || working || cancelling || changed || codexReviewBlocked || !onApply?.[kind]) return;
    onApply[kind]!(text); setMessage("편집기에 문구를 반영했습니다. 검토한 뒤 콘텐츠 저장을 눌러 주세요.");
  };
  if (!target) return <p className="small muted">스튜디오 원고에 연결하면 앱 안에서 제안을 받을 수 있습니다. 아래 요청 복사로도 같은 글쓰기 기준을 사용할 수 있어요.</p>;
  const busy = disabled || working || cancelling;
  const writerUnavailable = !unresolved && (visible && !codexChecked.current || writer === "codex" && !codexStatus?.online);
  return <div className="sns-editorial-generation stack">
    <label className="field">작성 방식<select aria-label="작성 방식" disabled={busy || !!unresolved} value={writer} onChange={event => { writerTouched.current = true; setWriter(event.target.value as WriterMode); }}><option value="codex">Codex · 이 PC</option><option value="api">API</option></select></label>
    {writer === "api" ? <><label className="field">작성 AI<select aria-label="작성 AI" disabled={busy || !!unresolved} value={provider} onChange={event => setProviderOverride(event.target.value as AiProvider)}>{(["gemini", "openai", "anthropic"] as const).map(value => <option key={value} value={value}>{aiProviderLabels[value]}</option>)}</select></label><p className="small muted">선택한 AI에 한 번 요청합니다. 연결한 API의 사용량·요금이 적용될 수 있으며 결과는 제안으로만 표시합니다.</p></> : <div className="stack"><p className="small muted">이 PC에 로그인한 Codex의 이용 한도를 사용합니다. 별도 API 키가 필요 없으며 작업하는 동안 PC가 켜져 있어야 합니다.</p><p className="small muted">초안 작성 뒤 별도로 검토하고, 필요하면 한 번 고쳐 다시 검토합니다. 한 작업에 최대 4회 작성·검토하며 각 단계가 Codex 사용 한도에 반영됩니다.</p><p className="small" role="status">{codexChecking ? "이 PC의 Codex 연결을 확인하는 중…" : codexStatus?.online ? `${codexStatus.deviceName || "이 PC"} 연결됨 · ${codexStatus.model}` : codexStatus?.configured ? "Codex 작업기가 연결되지 않았습니다. PC의 연결 상태를 확인해 주세요." : "Codex 연결이 아직 준비되지 않았습니다."}</p>{codexStatus?.lastSeenAt && <p className="small muted">마지막 연결 확인 · {new Date(codexStatus.lastSeenAt).toLocaleString("ko-KR")}</p>}</div>}
    {codexStatusError && <p className="small muted">{codexStatusError}</p>}
    {visible && <div><button type="button" className="btn sm ghost" disabled={codexChecking} onClick={() => void refreshCodexStatus()}>Codex 연결 다시 확인</button></div>}
    <div className="row"><button type="button" className="btn primary" disabled={busy || writerUnavailable} onClick={() => void generate()}>{working ? activeReceipt?.writer === "codex" ? "Codex에서 다듬는 중…" : "문구를 다듬는 중…" : unresolved ? "같은 요청 결과 다시 확인" : "스튜디오에서 제안 받기"}</button>{(working && activeReceipt || unresolved) && <button type="button" className="btn sm" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "중단 확인 중…" : "요청 중단"}</button>}</div>
    {working && codexJob && <p className="small" role="status">{codexJob.status === "queued" ? "Codex 작업 대기 중" : "Codex 작성 중"}{codexJob.phase ? ` · ${codexJob.phase}` : ""}</p>}
    {unresolved && <p className="notice warn small">처리 결과가 아직 확인되지 않았습니다. 다시 확인은 같은 요청을 사용하며 새 생성 요청을 만들지 않습니다.</p>}
    {error && <p className="notice err small" role="alert">{error}</p>}
    {message && <p className="small" role="status">{message}</p>}
    {result && <section className="sns-editorial-result stack" aria-label="글쓰기 제안 결과">
      <div><span className="section-kicker">YOUR NEXT DRAFT</span><h3>검토할 제안</h3><p className="small muted">{resultWriter === "codex" ? "Codex · 이 PC" : aiProviderLabels[result.provider]} · {result.model} · 기존 원고는 유지 중</p></div>
      {codexReviewBlocked && <p className="notice warn small">수정·근거 확인이 필요합니다. 문구는 복사할 수 있으며, 이어 다듬기로 검토 사항을 해결한 뒤 편집기에 반영하세요.</p>}
      {"qualityReview" in result && result.qualityReview && <details><summary>Codex 자체 검토 기록</summary><p className="small">{result.qualityReview.passed ? "자체 점검에서 추가 수정 사항을 찾지 못했습니다." : "추가로 확인할 사항이 남아 있습니다."}</p><ul>{result.qualityReview.issues.map((issue,index) => <li key={index}>{issue}</li>)}{result.qualityReview.revisionsApplied.map((revision,index) => <li key={`revision-${index}`}>{revision}</li>)}</ul></details>}
      {changed && <p className="notice warn small">제안을 받은 뒤 입력이나 원고가 바뀌었습니다. 기존 제안은 복사할 수 있으며, 최신 내용으로 다시 제안받으면 편집기에 반영할 수 있습니다.</p>}
      {!!result.hooks.length && <div className="sns-result-hooks">{result.hooks.map((hook,index) => <article key={index}><span>{String(index + 1).padStart(2, "0")} · {hook.angle}</span><strong>{hook.text}</strong><p>{hook.reason}</p><div className="row"><button type="button" className="btn sm" onClick={() => void copy(hook.text)}>이 훅 복사</button>{onApply?.title && ["reel_script","carousel_plan"].includes(result.task) && <button type="button" className="btn sm ghost" disabled={busy || changed || codexReviewBlocked || hook.text.length > 160} onClick={() => apply("title",hook.text)}>제목에 반영</button>}<button type="button" className="btn sm ghost" disabled={busy || changed || !!unresolved} onClick={() => { setSelectedHook(hook.text); feedbackField.current?.focus(); }}>이 훅으로 이어 다듬기</button></div></article>)}</div>}
      {!!result.sections.length && <details><summary>구성과 작성 이유</summary><dl className="sns-result-sections">{result.sections.map((section,index) => <div key={index}><dt>{section.label}</dt><dd>{section.text}</dd></div>)}</dl></details>}
      <label className="field">최종 문구<textarea aria-label="제안한 최종 문구" readOnly value={result.finalCopy} rows={8} onFocus={event => event.target.select()} /></label>
      <div className="row"><button type="button" className="btn sm" onClick={() => void copy(result.finalCopy)}>최종 문구 복사</button>{onApply?.script && ["reel_script","carousel_plan","humanize","story_sequence","repurpose"].includes(result.task) && <button type="button" className="btn sm" disabled={busy || changed || codexReviewBlocked || result.finalCopy.length > 24000} onClick={() => apply("script", result.finalCopy)}>전체 원고에 반영</button>}{onApply?.caption && ["caption_review","humanize"].includes(result.task) && <button type="button" className="btn sm" disabled={busy || changed || codexReviewBlocked || result.finalCopy.length > 8000} onClick={() => apply("caption", result.finalCopy)}>캡션에 반영</button>}</div>
      {!!result.checks.length && <details><summary>공개 전 확인할 점</summary><ul>{result.checks.map((check,index) => <li key={index}>{check}</li>)}</ul></details>}
      {selectedHook && <div className="notice small"><strong>이어갈 훅</strong><p>{selectedHook}</p><button type="button" className="btn sm ghost" disabled={busy || !!unresolved} onClick={() => setSelectedHook(null)}>훅 선택 취소</button></div>}
      <label className="field">이 안에서 바꿀 점<textarea ref={feedbackField} aria-label="이 안에서 바꿀 점" rows={3} maxLength={8000} value={feedback} disabled={busy || !!unresolved} onChange={event => setFeedback(event.target.value)} placeholder="예: 첫 문장은 좋아요. 본문은 더 구체적으로, 마지막은 아이가 생각해 볼 질문으로 끝내 주세요." /></label>
      <p className="small muted">처음 확인한 자료를 유지하고 바로 이전 제안에 이번 피드백을 반영합니다. 아래 버튼을 누를 때 {writer === "codex" ? "이 PC의 Codex에서 새 작성·검토 작업을 시작하며 각 단계가 Codex 사용 한도에 반영됩니다." : "선택한 AI에 새로 한 번 요청하며 API 사용량·요금이 적용될 수 있습니다."}</p>
      <div><button type="button" className="btn" disabled={busy || writerUnavailable || changed || !!unresolved || !feedback.trim() && !selectedHook} onClick={() => void generate(true)}>이 제안에서 이어 다듬기</button></div>
    </section>}
  </div>;
}
