import { useEffect, useRef, useState } from "react";
import type { EditorialVoiceProfile } from "@shared/editorialVoice";
import { api } from "./api";
import { useDirtyGuard } from "./state";

/** Saving is explicit: applying or editing a draft never adds a writing preference automatically. */
export function SnsVoiceMemory({ channelKey, currentText = "", enabled = false, onProfileChange }: { channelKey: string; currentText?: string; enabled?: boolean; onProfileChange?: (profile: EditorialVoiceProfile) => void }) {
  const [profile, setProfile] = useState<EditorialVoiceProfile | null>(null), [rule, setRule] = useState(""), [approved, setApproved] = useState("");
  const [rejected, setRejected] = useState(""), [explanation, setExplanation] = useState(""), [role, setRole] = useState<"title" | "body" | "caption">("body");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const request = useRef<{ signature: string; requestId: string } | null>(null);
  const currentChannel = useRef(channelKey), previousChannel = useRef(channelKey); currentChannel.current = channelKey;
  const onProfile = useRef(onProfileChange); onProfile.current = onProfileChange;
  const guard = useDirtyGuard();
  const path = `/studio/editorial-voice/${encodeURIComponent(channelKey)}`;
  async function load() {
    setError(""); const scope = channelKey; try { const next = await api<EditorialVoiceProfile>(path); if (currentChannel.current === scope) { setProfile(next); onProfile.current?.(next); } } catch (caught) { if (currentChannel.current === scope) setError(caught instanceof Error ? caught.message : "기준을 불러오지 못했습니다."); }
  }
  useEffect(() => { let current = true;
    if (previousChannel.current !== channelKey) { previousChannel.current = channelKey; setProfile(null); setRule(""); setApproved(""); setRejected(""); setExplanation(""); setRole("body"); setMessage(""); setError(""); request.current = null; }
    if (enabled) void api<EditorialVoiceProfile>(path).then(value => { if (current) { setProfile(value); onProfile.current?.(value); } }).catch(caught => { if (current) setError(caught instanceof Error ? caught.message : "기준을 불러오지 못했습니다."); });
    return () => { current = false; };
  }, [channelKey, enabled]);
  useEffect(() => { const key = `sns-voice-memory:${channelKey}`; guard.setDirty(key, busy || !!(rule.trim() || approved.trim() || rejected.trim() || explanation.trim()), async () => false); return () => guard.setDirty(key, false); }, [channelKey, rule, approved, rejected, explanation, busy, guard]);
  async function save() {
    if (!profile || busy || !(rule.trim() || approved.trim())) return;
    const input = { expectedRevision: profile.profileRevision, ...(rule.trim() ? { rule: rule.trim() } : {}), ...(approved.trim() ? { approvedText: approved.trim(), rejectedText: rejected, explanation, role, genre: "any" } : {}) };
    const signature = JSON.stringify(input);
    if (request.current?.signature !== signature) request.current = { signature, requestId: crypto.randomUUID() };
    const scope = channelKey; setBusy(true); setError(""); setMessage("");
    try { const next = await api<EditorialVoiceProfile>(`${path}/feedback`, { method: "POST", body: { ...input, requestId: request.current.requestId } });
      if (currentChannel.current !== scope) return;
      setProfile(next); onProfile.current?.(next); setRule(""); setApproved(""); setRejected(""); setExplanation(""); request.current = null; setMessage(`문체 기준 v${next.profileRevision}에 저장했습니다. 다음 작성부터 참고합니다.`);
    } catch (caught) { if (currentChannel.current === scope) setError(caught instanceof Error ? caught.message : "저장하지 못했습니다."); }
    finally { setBusy(false); }
  }
  async function remove(kind: "rules" | "examples", id: string) {
    if (!profile || busy) return; const scope = channelKey; setBusy(true); setError("");
    try { const next = await api<EditorialVoiceProfile>(path, { method: "PUT", body: { expectedRevision: profile.profileRevision, requestId: crypto.randomUUID(), rules: kind === "rules" ? profile.rules.filter(item => item.id !== id) : profile.rules, examples: kind === "examples" ? profile.examples.filter(item => item.id !== id) : profile.examples } }); if (currentChannel.current === scope) { setProfile(next); onProfile.current?.(next); setMessage("선택한 기억을 삭제했습니다."); } }
    catch (caught) { if (currentChannel.current === scope) setError(caught instanceof Error ? caught.message : "삭제하지 못했습니다."); } finally { setBusy(false); }
  }
  if (!enabled) return null;
  return <details className="sns-voice-memory stack"><summary>내 글쓰기 기준 기억하기{profile && ` · v${profile.profileRevision}`}</summary><div className="stack">
    <p className="small muted">직접 저장한 교정 기준과 채택 문구를 다음 글에 참고합니다. 사례 속 날짜·숫자·사건은 새 글의 사실로 사용하지 않습니다.</p>
    {error && <p className="notice err small" role="alert">{error}</p>}{message && <p className="notice ok small" role="status">{message}</p>}
    {!profile ? <button type="button" className="btn sm" disabled={busy} onClick={() => void load()}>기준 불러오기</button> : <>
      <label className="field">다음 글에도 지킬 기준<textarea value={rule} maxLength={400} rows={2} disabled={busy} onChange={event => setRule(event.target.value)} placeholder="예: 좋은 제목은 살리고, 내가 요청한 부분만 고쳐 주세요." /></label>
      <div className="row"><label className="field">문구 종류<select value={role} disabled={busy} onChange={event => setRole(event.target.value as typeof role)}><option value="title">제목</option><option value="body">본문</option><option value="caption">캡션</option></select></label><button type="button" className="btn sm" disabled={busy || !currentText.trim() || currentText.length > 6000} onClick={() => setApproved(currentText)}>현재 문구를 사례로 가져오기</button></div>
      <label className="field">채택한 문구 · 선택<textarea value={approved} maxLength={6000} rows={3} disabled={busy} onChange={event => setApproved(event.target.value)} /></label>
      <label className="field">고치기 전 문구 · 선택<textarea value={rejected} maxLength={3000} rows={2} disabled={busy || !approved.trim()} onChange={event => setRejected(event.target.value)} /></label>
      <label className="field">이렇게 고른 이유 · 선택<input value={explanation} maxLength={1000} disabled={busy || !approved.trim()} onChange={event => setExplanation(event.target.value)} /></label>
      <button type="button" className="btn primary" disabled={busy || !(rule.trim() || approved.trim())} onClick={() => void save()}>{busy ? "저장 중…" : "다음 글에도 이 기준 기억"}</button>
      {!!profile.rules.length && <ul>{profile.rules.map(item => <li key={item.id}><span>{item.text}</span> <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void remove("rules", item.id)}>삭제</button></li>)}</ul>}
      {!!profile.examples.length && <details><summary>저장한 문체 사례 {profile.examples.length}개</summary>{profile.examples.map(item => <div className="stack" key={item.id}><strong>{item.role === "title" ? "제목" : item.role === "caption" ? "캡션" : "본문"}</strong><p style={{ whiteSpace: "pre-wrap" }}>{item.approvedText}</p>{item.explanation && <p className="small muted">{item.explanation}</p>}<button type="button" className="btn ghost sm" disabled={busy} onClick={() => void remove("examples", item.id)}>이 사례 삭제</button></div>)}</details>}
      <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void load()}>저장된 기준 새로 불러오기</button>
    </>}
  </div></details>;
}
