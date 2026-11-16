import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { aiProviderLabels, type AiProvider } from "@shared/aiProviders";
import { estimateImageCapacity, type AiCapacity } from "@shared/aiCapacity";
import { api } from "./api";
import { GuardedLink } from "./ui";
import "./aiCapacity.css";

export function AiCapacityPanel({ channelId, analysisProvider, plannedImages = 1, plannedDescription, alternateRequest, showAnalysis = false }: { channelId?: number; analysisProvider?: AiProvider; plannedImages?: number; plannedDescription?: string; alternateRequest?: { images: number; description: string }; showAnalysis?: boolean }) {
  const capacity = useQuery({
    queryKey: ["ai-capacity", channelId, analysisProvider ?? "channel", showAnalysis ? "analysis-image" : "image-only"],
    queryFn: ({ signal }) => api<AiCapacity>(`/studio/ai-capacity?channelId=${channelId}${analysisProvider ? `&analysisProvider=${analysisProvider}` : ""}${showAnalysis ? "" : "&imageOnly=1"}`, { signal }),
    enabled: Number.isSafeInteger(channelId) && Number(channelId) > 0, retry: false, staleTime: 15_000, refetchOnWindowFocus: true,
  });
  const data = capacity.data?.channelId === channelId ? capacity.data : undefined;
  const model = data?.image.model ?? "";
  const scope = `${channelId ?? "unknown"}:${model}`;
  const [input, setInput] = useState({ scope: "", budget: "", unit: "" });
  useEffect(() => { setInput({ scope, budget: "", unit: "" }); }, [scope]);
  const budget = input.scope === scope ? input.budget : "", unit = input.scope === scope ? input.unit : "";
  const estimate = model ? estimateImageCapacity(budget, unit, plannedImages) : null;
  const alternateEstimate = model && alternateRequest ? estimateImageCapacity(budget, unit, alternateRequest.images) : null;
  const id = useId();
  const failure = data?.latestFailure;
  const relevantFailure = failure && (showAnalysis || failure.provider === data.image.provider && (!failure.model || failure.model === data.image.model)) ? failure : null;
  const usd = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 8 })}`;
  return <section className="ai-capacity stack small" aria-label="AI 제작 가능량" data-testid="ai-capacity-panel">
    <div className="ai-capacity-heading"><strong>제작 전 AI 사용량 확인</strong><button type="button" className="btn sm ghost" disabled={!channelId || capacity.isFetching} onClick={() => void capacity.refetch()}>{capacity.isFetching ? "확인 중…" : "상태 새로 확인"}</button></div>
    <dl className="ai-capacity-facts">
      {showAnalysis && <div><dt>원문 분석</dt><dd>{data ? `${aiProviderLabels[data.analysis.provider]} · ${data.analysis.model} · ${data.analysis.keyConfigured ? "키 연결됨" : "키 연결 필요"}` : "설정 확인 중"}</dd></div>}
      <div><dt>이미지 제작</dt><dd>{data ? `OpenAI · ${data.image.model} · ${data.image.keyConfigured ? "키 연결됨" : "키 연결 필요"}` : "모델·연결 확인 필요"}</dd></div>
      <div><dt>스튜디오 일일 제한</dt><dd>별도 토큰·이미지 장수 제한 없음</dd></div>
      <div><dt>실제 잔여 토큰·장수</dt><dd>공급자 계정에서 확인 필요</dd></div>
      <div><dt>이번 이미지 요청</dt><dd>{plannedDescription && `${plannedDescription} · `}최대 {plannedImages}장 · 1024 × 1024 · 중간 품질{alternateRequest && <span className="ai-capacity-alternate">{alternateRequest.description} · 최대 {alternateRequest.images}장</span>}</dd></div>
    </dl>
    <p className="hint">키 연결만으로 잔액·한도·생성 가능 여부가 확인되지는 않습니다. 그림은 OpenAI로 만들며, {showAnalysis ? "앞 단계의 원문 분석이 막히면 이미지 제작까지 진행되지 않습니다." : "재생성할 때마다 API 사용료가 발생합니다."} 기존 결과를 재사용하거나 앞 단계가 중단되면 실제 요청 장수는 줄어들 수 있습니다.</p>
    {relevantFailure && <p className="notice warn" role="status">최근 {aiProviderLabels[relevantFailure.provider]} 요청: {({ quota: "할당량·결제 제한", rate_limit: "호출 속도 제한", connection: "연결·권한 확인 필요", other: "처리 실패" })[relevantFailure.kind]} · {new Date(relevantFailure.at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}{relevantFailure.model ? ` · ${relevantFailure.model}` : ""}. 이전 결과이며 현재 제한이 해제됐는지는 공급자 화면에서 확인하세요.</p>}
    {capacity.isError && <p className="hint" role="status">AI 설정을 불러오지 못했습니다. 입력은 유지됩니다. 상태를 다시 확인하거나 연결 설정을 열어 주세요.</p>}
    <div className="row ai-capacity-links"><a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noopener noreferrer">OpenAI 잔액</a><a href="https://platform.openai.com/settings/organization/limits" target="_blank" rel="noopener noreferrer">OpenAI 한도</a><a href="https://platform.openai.com/usage" target="_blank" rel="noopener noreferrer">OpenAI 사용 내역</a>{showAnalysis && data?.analysis.provider === "gemini" && <a href="https://aistudio.google.com/rate-limit" target="_blank" rel="noopener noreferrer">Gemini 실제 할당량</a>}<GuardedLink href="/settings">역할별 AI 설정</GuardedLink></div>
    <details><summary>예산으로 예상 장수 계산</summary><div className="stack">
      <p>직접 입력한 예산 기준의 예상치이며 실제 계정 잔여량이 아닙니다. 모델·크기·품질에 맞는 단가를 확인해 입력하세요. 수정·참조 이미지·본문 생성 비용에 따라 실제 비용은 달라집니다.</p>
      <p className="hint">계산 모델: {model || "설정 확인 필요"}. 채널·모델이 바뀌면 입력한 예산과 단가를 다시 확인하도록 계산값을 비웁니다. <a href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noopener noreferrer">OpenAI 공식 요금 확인</a></p>
      <div className="ai-capacity-inputs"><label htmlFor={`${id}-budget`}>사용할 예산 (USD)<input id={`${id}-budget`} type="number" inputMode="decimal" min="0" step="any" value={budget} disabled={!model} onChange={event => setInput(value => ({ scope, budget: event.target.value, unit: value.scope === scope ? value.unit : "" }))} /></label><label htmlFor={`${id}-unit`}>예상 이미지 1장 비용 (USD)<input id={`${id}-unit`} type="number" inputMode="decimal" min="0.00000001" step="any" value={unit} disabled={!model} onChange={event => setInput(value => ({ scope, unit: event.target.value, budget: value.scope === scope ? value.budget : "" }))} /></label></div>
      <output aria-live="polite">{estimate ? `입력 예산 기준 약 ${estimate.images.toLocaleString("ko-KR")}장 · ${plannedDescription ?? "이번"} ${plannedImages}장 예상 ${usd(estimate.requestUsd)}${alternateEstimate && alternateRequest ? ` · ${alternateRequest.description} ${alternateRequest.images}장 예상 ${usd(alternateEstimate.requestUsd)}` : ""}` : budget || unit ? "예산은 0 이상, 1장 비용은 0보다 큰 금액을 소수점 8자리 이내로 입력해 주세요." : "예산과 이미지 1장 비용을 모두 입력하면 예상 장수를 계산합니다."}</output>
    </div></details>
  </section>;
}
