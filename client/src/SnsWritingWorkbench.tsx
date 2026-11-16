import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import type { CanvaStudioSyncState } from "@shared/canvaStudioSync";
import { buildEditorialVoicePrompt, type EditorialVoiceProfile } from "@shared/editorialVoice";
import type { StudioContent } from "@shared/studio";
import { buildSnsEditorialPrompt, inspectSnsCopy, SNS_TASKS, SNS_VOICE_SUMMARY, SNS_EDITORIAL_VERSION, type SnsTaskId } from "@shared/snsEditorial";
import { ChatGptLaunch } from "./ChatGptLaunch";
import { useDraftRecovery } from "./useDraftRecovery";
import { useDirtyGuard } from "./state";
import { SnsEditorialGeneration, type SnsEditorialApply, type SnsEditorialTarget } from "./SnsEditorialGeneration";
import { api } from "./api";
import { SnsVoiceMemory } from "./SnsVoiceMemory";
import "./snsWritingWorkbench.css";

const taskGroups = [{ id: "create", label: "새 콘텐츠 만들기" }, { id: "review", label: "문구·성과 점검" }, { id: "operate", label: "운영 초안 만들기" }] as const;
const writingInputsSchema = z.object({ task: z.string().refine(value => SNS_TASKS.some(item => item.id === value)), topicOverride: z.string().max(600).nullable(), formatOverride: z.string().max(100).nullable(), audience: z.string().max(500), referenceText: z.string().max(24000), instruction: z.string().max(8000), includeCurrent: z.boolean(), includeMemo: z.boolean() }).strict();
type WritingInputs = z.infer<typeof writingInputsSchema>;
export type SnsWritingContent = Pick<StudioContent, "title" | "channel" | "format" | "script" | "caption" | "sourceLabel" | "memo"> & { panels: Array<{ dialogue: string }> };
export type SnsWritingContext = Pick<SnsWritingContent, "channel" | "caption" | "sourceLabel"> & { channelName: string; memo?: string; studioCardId?: number };

export function SnsWritingWorkbench({ content, channelName, disabled = false, recoveryKey, revision = 0, generationTarget, onApply }: {
  content: SnsWritingContent; channelName: string; disabled?: boolean; recoveryKey?: string; revision?: number; generationTarget?: SnsEditorialTarget; onApply?: SnsEditorialApply;
}) {
  const fieldId = useId();
  const guard = useDirtyGuard();
  const [expanded,setExpanded] = useState(false);
  const [voiceMemory,setVoiceMemory] = useState<{ channel:string; profile:EditorialVoiceProfile } | null>(null);
  useEffect(() => setVoiceMemory(null),[content.channel]);
  const { data:canvaState } = useQuery<CanvaStudioSyncState>({ queryKey:["canva-studio-sync",generationTarget?.id ?? "none"], queryFn:() => api(`/studio/cards/${generationTarget!.id}/canva-sync`), enabled:false });
  const [task, setTask] = useState<SnsTaskId>(() => content.format === "릴스" ? "reel_script" : "carousel_plan");
  const [topicOverride, setTopicOverride] = useState<string | null>(null);
  const [formatOverride, setFormatOverride] = useState<string | null>(null);
  const [audience, setAudience] = useState(() => content.channel === "highscoop" ? "중고등학생과 학부모" : "이 채널의 콘텐츠를 처음 보는 독자");
  const [referenceText, setReferenceText] = useState("");
  const [instruction, setInstruction] = useState("");
  const [includeCurrent, setIncludeCurrent] = useState(true);
  const [includeMemo, setIncludeMemo] = useState(false);
  const defaults = useRef<WritingInputs>({ task, topicOverride: null, formatOverride: null, audience, referenceText: "", instruction: "", includeCurrent: true, includeMemo: false });
  const values: WritingInputs = { task, topicOverride, formatOverride, audience, referenceText, instruction, includeCurrent, includeMemo };
  const inputsChanged = JSON.stringify(values) !== JSON.stringify(defaults.current);
  function restoreInputs(value: WritingInputs) {
    setTask(value.task as SnsTaskId); setTopicOverride(value.topicOverride); setFormatOverride(value.formatOverride); setAudience(value.audience); setReferenceText(value.referenceText); setInstruction(value.instruction); setIncludeCurrent(value.includeCurrent); setIncludeMemo(false);
  }
  const recovery = useDraftRecovery<WritingInputs>({ recoveryKey: `sns-writing:${recoveryKey ?? "unscoped"}`, label: "글쓰기 작업실 입력", version: revision,
    serverValue: defaults.current, value: values, dirty: inputsChanged, ready: !!recoveryKey,
    parse: value => { const result = writingInputsSchema.safeParse(value); return result.success ? result.data : null; }, onRestore: restoreInputs });
  const blocked = disabled || !!recovery.pending;
  useEffect(() => {
    const key = `sns-writing-inputs:${recoveryKey ?? fieldId}`;
    guard.setDirty(key, inputsChanged || !!recovery.pending, async () => !recovery.pending && (!inputsChanged || recovery.status === "saved"), () => { recovery.clear(); restoreInputs(defaults.current); });
    return () => guard.setDirty(key, false);
  }, [inputsChanged, recovery.pending, recovery.status, recoveryKey, fieldId, guard]);
  const topic = topicOverride ?? content.title;
  const taskFormat = task === "reel_script" ? "릴스" : task === "carousel_plan" ? "카드뉴스" : task === "story_sequence" ? "스토리" : null;
  const format = taskFormat ?? formatOverride ?? content.format;
  const selectedTask = SNS_TASKS.find(item => item.id === task)!;
  const latestCanvaText = canvaState?.latestText?.trim() ?? "";
  const comparisonScript = latestCanvaText && content.script.includes(latestCanvaText) ? content.script.replace(latestCanvaText,"[위 최신 Canva 추출 문구와 같은 구간]") : content.script;
  const studioCopy = [content.title && `제목: ${content.title}`, comparisonScript && `전체 원고:\n${comparisonScript}`,
    ...content.panels.map((panel, index) => panel.dialogue.trim() && `${index + 1}컷 문구: ${panel.dialogue}`),
    content.caption && `캡션:\n${content.caption}`].filter(Boolean).join("\n\n");
  const currentCopy = latestCanvaText ? [
    "[편집 대상 우선순위]\n최신 Canva 저장본이 기본 편집 대상이다. 기존 장별 편집 칸은 Canva와 대응이 검증되지 않은 비교용 자료다. 상충하는 문구를 임의로 혼합하지 않는다. 이번 사용자 지시와 사용자가 명시한 미저장 수정이 우선이다. 제목이나 장별 필드를 자동 대응했다고 가정하지 않는다. 아래 초안은 사실 근거가 아니며 확인 자료(referenceText)를 별도로 대조한다.",
    `[최신 Canva 저장본의 추출 문구 · 기본 편집 대상]\n${latestCanvaText}`,
    `[기존 스튜디오 편집 칸 · 대응 미검증, 비교용]\n${studioCopy}`,
  ].join("\n\n") : studioCopy;
  const references = [content.sourceLabel && `등록한 출처: ${content.sourceLabel}`, referenceText,
    includeMemo && content.memo.trim() && `선택한 기획·참고 자료:\n${content.memo}`].filter(Boolean).join("\n\n");
  const editorialInput = { task, topic, audience, format, channel: content.channel, referenceText: references, existingText: includeCurrent ? currentCopy : "", instruction };
  let prompt = "", promptError = "";
  try { prompt = [buildSnsEditorialPrompt(editorialInput), voiceMemory?.channel === content.channel ? buildEditorialVoicePrompt(voiceMemory.profile) : ""].filter(Boolean).join("\n\n"); }
  catch (error) { promptError = error instanceof Error ? error.message : "작업 요청을 만들지 못했습니다. 입력 내용을 확인해 주세요."; }
  const checks = inspectSnsCopy({ title: content.title, caption: content.caption, script: content.script, format: content.format });
  const captionPreview = Array.from(content.caption.trim()).slice(0, 125).join("");
  const hasCaptionOverflow = Array.from(content.caption.trim()).length > 125;

  return <details className="sns-writing-workbench" data-editorial-version={SNS_EDITORIAL_VERSION} onToggle={event => { if (event.target === event.currentTarget) setExpanded(event.currentTarget.open); }}>
    <summary><span className="sns-workbench-mark" aria-hidden="true">✦</span><span><strong>글쓰기 작업실</strong><small>내 말투로 기획하고, 첫 문장부터 다듬기</small></span><span className="sns-workbench-count">13가지 작업</span></summary>
    <div className="sns-workbench-body">
      <div className="sns-workbench-intro"><span className="section-kicker">WRITE WITH YOUR OWN VOICE</span><p>구체적인 장면과 생활 속 재치, 궁금증을 풀어주는 설명. 채널의 말투를 지키며 선명하게 씁니다.</p></div>
      {recovery.pending && <div className="notice warn stack" aria-label="글쓰기 작업실 기기 복구본"><strong>이 기기에 남겨 둔 작업실 입력이 있어요.</strong><p className="small">현재 원고는 그대로 두고 작업 요청의 입력만 불러옵니다. 기획 메모 포함은 다시 선택해 주세요.</p><div className="row"><button type="button" className="btn sm" disabled={disabled} onClick={recovery.restore}>작업실 입력 복구</button><button type="button" className="btn sm ghost" disabled={disabled} onClick={recovery.discard}>복구본 버리기</button></div></div>}
      {recovery.status === "saved" && inputsChanged && !recovery.pending && <p className="small muted" role="status">작업실 입력을 이 기기에 임시 보관했습니다. 콘텐츠 원고는 바꾸지 않습니다.</p>}
      {recovery.error && inputsChanged && <p className="notice warn small" role="alert">{recovery.error}</p>}
      <div className="sns-workbench-layout">
        <div className="sns-workbench-compose stack">
          <label className="field" htmlFor={`${fieldId}-task`}>무엇을 할까요?<select id={`${fieldId}-task`} aria-label="무엇을 할까요?" disabled={blocked} value={task} onChange={event => setTask(event.target.value as SnsTaskId)}>
            {taskGroups.map(group => <optgroup key={group.id} label={group.label}>{SNS_TASKS.filter(item => item.group === group.id).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>)}
          </select></label>
          <p className="sns-workbench-task-description">{selectedTask.description}</p>
          <label className="field" htmlFor={`${fieldId}-topic`}>주제<input id={`${fieldId}-topic`} aria-label="주제" disabled={blocked} value={topic} maxLength={600} onChange={event => setTopicOverride(event.target.value)} placeholder="예: 우주선을 공중에서 붙잡은 장면" /></label>
          <div className="sns-workbench-fields">
            <label className="field" htmlFor={`${fieldId}-audience`}>누가 읽나요?<input id={`${fieldId}-audience`} aria-label="누가 읽나요?" disabled={blocked} value={audience} maxLength={500} onChange={event => setAudience(event.target.value)} /></label>
            <label className="field" htmlFor={`${fieldId}-format`}>만들 형식<select id={`${fieldId}-format`} aria-label="만들 형식" disabled={blocked || !!taskFormat} value={format} onChange={event => setFormatOverride(event.target.value)}>{!["릴스", "카드뉴스", "웹툰", "스토리", "캡션", "브랜드", "기타"].includes(format) && <option>{format}</option>}{["릴스", "카드뉴스", "웹툰", "스토리", "캡션", "브랜드", "기타"].map(value => <option key={value}>{value}</option>)}</select>{taskFormat && <span className="hint">선택한 작업에 맞춘 형식입니다. 참고 원고: {content.format}</span>}</label>
          </div>
          <label className="field" htmlFor={`${fieldId}-reference`}>확인한 사실·원문·분석 수치<textarea id={`${fieldId}-reference`} aria-label="확인한 사실·원문·분석 수치" rows={4} maxLength={24000} disabled={blocked} value={referenceText} onChange={event => setReferenceText(event.target.value)} placeholder={task === "post_audit" ? "게시 후 경과 시간, 광고 여부, 도달·조회, 건너뛰기·저장·공유 비율을 구분해 적어 주세요." : "원문과 확인한 내용을 넣어 주세요. 숫자나 경험이 없으면 새로 만들지 않습니다."} /></label>
          <label className="field" htmlFor={`${fieldId}-instruction`}>더 다듬고 싶은 점<textarea id={`${fieldId}-instruction`} aria-label="더 다듬고 싶은 점" rows={2} maxLength={8000} disabled={blocked} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="예: 첫 장은 짧게. 마지막은 비용이 낮아지면 무엇이 달라질지 묻는 문장으로." /></label>
          <div className="sns-workbench-context">
            {latestCanvaText && <p className="small muted">최신 Canva 문구를 기본 편집 대상으로 참고합니다. 기존 장별 편집 칸은 대응이 확인되지 않은 비교용입니다.</p>}
            <label><input type="checkbox" checked={includeCurrent} disabled={blocked} onChange={event => setIncludeCurrent(event.target.checked)} /><span>현재 제목·원고·캡션을 함께 참고<small>저장 전 수정한 최신 내용도 포함합니다.</small></span></label>
            {!!content.memo.trim() && <label><input type="checkbox" checked={includeMemo} disabled={blocked} onChange={event => setIncludeMemo(event.target.checked)} /><span>기획·참고 자료도 포함<small>체크한 경우에만 위 기획 메모를 전달합니다.</small></span></label>}
          </div>
          <div className="sns-workbench-delivery"><strong>이번에 받을 결과</strong><p>{selectedTask.outputHint}</p>
            {promptError && <p className="notice warn small" role="alert">{promptError} 입력 내용은 유지했습니다. 필요한 자료만 선택하거나 현재 원고 참고를 해제해 주세요.</p>}
            <SnsEditorialGeneration input={editorialInput} target={generationTarget} active={expanded} disabled={blocked || !!promptError || !topic.trim() || !audience.trim()} onApply={onApply} />
            <details className="sns-workbench-manual"><summary>ChatGPT에서 같은 기준으로 작성하기</summary>
            <ChatGptLaunch prompt={prompt} disabled={blocked || !!promptError || !topic.trim() || !audience.trim()} label="ChatGPT에서 작업 시작 ↗" copyLabel="이 작업 요청 복사" />
            </details>
          </div>
          <p className="sns-workbench-handoff">{channelName}의 결과에서 고른 문구를 제목·원고·캡션에 붙여넣고 저장하세요. 새 요청은 작업을 바꿔도 유지됩니다.</p>
        </div>
        <aside className="sns-workbench-review" aria-label="현재 원고 편집 점검">
          <section className="sns-workbench-preview"><span className="section-kicker">FIRST IMPRESSION</span><h3>캡션 앞부분</h3><div className={`sns-caption-preview${captionPreview ? "" : " is-empty"}`}>{captionPreview || "캡션을 쓰면 여기에서 앞부분을 미리 볼 수 있어요."}{hasCaptionOverflow && <span className="sns-caption-more"> … 더 보기</span>}</div><p className="small muted">앞 125자 기준의 편집용 미리보기입니다. 실제 표시 길이는 기기와 화면에 따라 달라집니다.</p></section>
          <section className="sns-workbench-checks"><div className="sns-workbench-check-heading"><h3>현재 원고 점검</h3><span>수정할 곳 찾기</span></div><ul>{checks.map(check => <li key={check.id} data-status={check.status}><span className="sns-check-dot" aria-hidden="true">{check.status === "pass" ? "✓" : check.status === "missing" ? "＋" : "!"}</span><div><strong>{check.label}</strong><p>{check.detail}</p></div></li>)}</ul><p className="small muted">문장 형태를 살피는 보조 점검입니다. 사실 검증이나 조회수 예측을 대신하지 않습니다.</p></section>
          <details className="sns-workbench-voice"><summary>적용 중인 글쓰기 기준</summary><ul>{SNS_VOICE_SUMMARY.map(rule => <li key={rule}>{rule}</li>)}</ul></details>
        </aside>
      </div>
      <SnsVoiceMemory channelKey={content.channel} currentText={currentCopy} enabled={expanded} onProfileChange={profile => setVoiceMemory({ channel:content.channel,profile })}/>
    </div>
  </details>;
}
