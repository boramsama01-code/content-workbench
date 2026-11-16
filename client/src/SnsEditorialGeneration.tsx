import { useEffect, useRef, useState } from "react";
import { aiProviderLabels, type AiProvider } from "@shared/aiProviders";
import type { SnsEditorialInput } from "@shared/snsEditorial";
import type { SnsEditorialDraftReply, SnsEditorialDraftRequest } from "@shared/snsEditorialDraft";
import type { StudioCardDetail } from "@shared/studio";
import { api, ApiError } from "./api";
import { useDirtyGuard } from "./state";

export type SnsEditorialTarget = { id: number; version?: number; provider?: AiProvider };
export type SnsEditorialApply = { title?: (text: string) => void; script?: (text: string) => void; caption?: (text: string) => void };
type Receipt = { targetId: number; body: SnsEditorialDraftRequest };
type Active = { controller: AbortController; receipt: Receipt | null; ignore: boolean };
const inputSignature = (value: SnsEditorialInput) => JSON.stringify([value.task,value.topic,value.audience,value.format,value.channel,value.referenceText,value.existingText,value.instruction]);

export function SnsEditorialGeneration({ input, target, disabled, onApply }: {
  input: SnsEditorialInput; target?: SnsEditorialTarget; disabled: boolean; onApply?: SnsEditorialApply;
}) {
  const guard = useDirtyGuard();
  const [providerOverride, setProviderOverride] = useState<AiProvider | null>(null);
  const provider = providerOverride ?? target?.provider ?? "gemini";
  const [working, setWorking] = useState(false), [cancelling, setCancelling] = useState(false);
  const [unresolved, setUnresolved] = useState<Receipt | null>(null);
  const [activeReceipt, setActiveReceipt] = useState<Receipt | null>(null);
  const [result, setResult] = useState<SnsEditorialDraftReply | null>(null);
  const [resultInput, setResultInput] = useState("");
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const active = useRef<Active | null>(null), mounted = useRef(true);
  const changed = !!result && resultInput !== inputSignature(input);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (active.current) { active.current.ignore = true; active.current.controller.abort(); } }; }, []);
  useEffect(() => {
    const key = `sns-editorial-request:${target?.id ?? "none"}`;
    guard.setDirty(key, working || cancelling || !!unresolved, async () => false);
    return () => guard.setDirty(key, false);
  }, [working, cancelling, unresolved, target?.id, guard]);

  async function generate() {
    if (!target || disabled || active.current || cancelling) return;
    const flight: Active = { controller: new AbortController(), receipt: null, ignore: false };
    active.current = flight; setWorking(true); setError(""); setMessage("");
    let receipt = unresolved;
    try {
      if (!receipt) {
        const version = target.version ?? (await api<StudioCardDetail>(`/studio/cards/${target.id}`, { signal: flight.controller.signal })).card.version;
        receipt = { targetId: target.id, body: { ...input, version, requestId: crypto.randomUUID(), provider } };
      }
      flight.receipt = receipt; setActiveReceipt(receipt);
      const proposal = await api<SnsEditorialDraftReply>(`/studio/cards/${receipt.targetId}/editorial-draft`, { method: "POST", body: receipt.body, signal: flight.controller.signal });
      if (!mounted.current || flight.ignore) return;
      setResult(proposal); setResultInput(inputSignature({ ...receipt.body, channel: receipt.body.channel ?? input.channel })); setUnresolved(null);
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
      const response = await api<{ cancelled: boolean }>(`/studio/cards/${receipt.targetId}/editorial-draft/${receipt.body.requestId}/cancel`, { method: "POST", body: {} });
      if (!mounted.current) return;
      if (response.cancelled) { setUnresolved(null); setMessage("요청 중단을 확인했습니다. 기존 원고는 유지했습니다."); }
      else { setUnresolved(receipt); setMessage("이미 완료됐을 수 있습니다. 같은 요청의 결과를 다시 확인하세요."); }
    } catch (caught) { if (mounted.current) { setUnresolved(receipt); setError(caught instanceof Error ? caught.message : "중단 여부를 확인하지 못했습니다."); } }
    finally { if (mounted.current) setCancelling(false); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setMessage("선택한 문구를 복사했습니다."); }
    catch { setMessage("자동 복사가 되지 않았습니다. 아래 문구를 직접 선택해 복사해 주세요."); }
  }
  const apply = (kind: keyof SnsEditorialApply, text: string) => {
    if (disabled || working || cancelling || changed || !onApply?.[kind]) return;
    onApply[kind]!(text); setMessage("편집기에 문구를 반영했습니다. 검토한 뒤 콘텐츠 저장을 눌러 주세요.");
  };
  if (!target) return <p className="small muted">스튜디오 원고에 연결하면 앱 안에서 제안을 받을 수 있습니다. 아래 요청 복사로도 같은 글쓰기 기준을 사용할 수 있어요.</p>;
  const busy = disabled || working || cancelling;
  return <div className="sns-editorial-generation stack">
    <label className="field">작성 AI<select disabled={busy || !!unresolved} value={provider} onChange={event => setProviderOverride(event.target.value as AiProvider)}>{(["gemini", "openai", "anthropic"] as const).map(value => <option key={value} value={value}>{aiProviderLabels[value]}</option>)}</select></label>
    <p className="small muted">선택한 AI에 한 번 요청합니다. 연결한 API의 사용량·요금이 적용될 수 있으며 결과는 제안으로만 표시합니다.</p>
    <div className="row"><button type="button" className="btn primary" disabled={busy} onClick={() => void generate()}>{working ? "문구를 다듬는 중…" : unresolved ? "같은 요청 결과 다시 확인" : "스튜디오에서 제안 받기"}</button>{(working && activeReceipt || unresolved) && <button type="button" className="btn sm" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "중단 확인 중…" : "요청 중단"}</button>}</div>
    {unresolved && <p className="notice warn small">처리 결과가 아직 확인되지 않았습니다. 다시 확인은 같은 요청을 사용하며 새 생성 요청을 만들지 않습니다.</p>}
    {error && <p className="notice err small" role="alert">{error}</p>}
    {message && <p className="small" role="status">{message}</p>}
    {result && <section className="sns-editorial-result stack" aria-label="글쓰기 제안 결과">
      <div><span className="section-kicker">YOUR NEXT DRAFT</span><h3>검토할 제안</h3><p className="small muted">{aiProviderLabels[result.provider]} · {result.model} · 기존 원고는 유지 중</p></div>
      {changed && <p className="notice warn small">제안을 받은 뒤 입력이나 원고가 바뀌었습니다. 기존 제안은 복사할 수 있으며, 최신 내용으로 다시 제안받으면 편집기에 반영할 수 있습니다.</p>}
      {!!result.hooks.length && <div className="sns-result-hooks">{result.hooks.map((hook,index) => <article key={index}><span>{String(index + 1).padStart(2, "0")} · {hook.angle}</span><strong>{hook.text}</strong><p>{hook.reason}</p><div className="row"><button type="button" className="btn sm" onClick={() => void copy(hook.text)}>이 훅 복사</button>{onApply?.title && ["reel_script","carousel_plan"].includes(result.task) && <button type="button" className="btn sm ghost" disabled={busy || changed || hook.text.length > 160} onClick={() => apply("title",hook.text)}>제목에 반영</button>}</div></article>)}</div>}
      {!!result.sections.length && <details><summary>구성과 작성 이유</summary><dl className="sns-result-sections">{result.sections.map((section,index) => <div key={index}><dt>{section.label}</dt><dd>{section.text}</dd></div>)}</dl></details>}
      <label className="field">최종 문구<textarea aria-label="제안한 최종 문구" readOnly value={result.finalCopy} rows={8} onFocus={event => event.target.select()} /></label>
      <div className="row"><button type="button" className="btn sm" onClick={() => void copy(result.finalCopy)}>최종 문구 복사</button>{onApply?.script && ["reel_script","carousel_plan","humanize","story_sequence","repurpose"].includes(result.task) && <button type="button" className="btn sm" disabled={busy || changed || result.finalCopy.length > 24000} onClick={() => apply("script", result.finalCopy)}>전체 원고에 반영</button>}{onApply?.caption && ["caption_review","humanize"].includes(result.task) && <button type="button" className="btn sm" disabled={busy || changed || result.finalCopy.length > 8000} onClick={() => apply("caption", result.finalCopy)}>캡션에 반영</button>}</div>
      {!!result.checks.length && <details><summary>공개 전 확인할 점</summary><ul>{result.checks.map((check,index) => <li key={index}>{check}</li>)}</ul></details>}
    </section>}
  </div>;
}
