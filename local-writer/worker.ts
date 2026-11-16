import { readFile, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_WRITER_MODEL, type CodexWriterClaim } from "../shared/codexWriter";
import { createCodexInvoker, writeAndReview, WriterRuntimeError } from "./codexRuntime";

type Config = { studioUrl: string; codexPath: string; deviceName?: string; allowLoopbackTest?: boolean; tokenFile: string };
const configPath = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "config.json"));
const config = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, "")) as Config;
const base = new URL(config.studioUrl);
if (base.href !== "https://spacepenguin.onrender.com/" && !(config.allowLoopbackTest && base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname))) throw new Error("허용되지 않은 스튜디오 주소");
if (!config.codexPath || !config.tokenFile) throw new Error("연결 설정이 없습니다.");
const directory = dirname(configPath);
await mkdir(directory, { recursive: true });
const lockPath = join(directory, "writer.lock");
async function acquireLock() {
  try { const fd = await open(lockPath, "wx", 0o600); await fd.writeFile(String(process.pid)); return fd; }
  catch {
    let pid = 0;
    try { pid = Number(await readFile(lockPath, "utf8")); process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH" && pid > 0) { await unlink(lockPath); return acquireLock(); }
    }
    throw new Error("이미 연결 프로그램이 실행 중입니다.");
  }
}
const lock = await acquireLock();
const stop = new AbortController();
process.on("SIGINT", () => stop.abort()); process.on("SIGTERM", () => stop.abort());
async function decryptToken(): Promise<string> {
  return new Promise((resolveToken, reject) => {
    // Fixed script reads the DPAPI file path from an argument; neither token nor Codex auth is passed on a command line.
    const command = 'Add-Type -AssemblyName System.Security; $b=[IO.File]::ReadAllBytes($env:SP_WRITER_TOKENFILE); $c=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); try {[Console]::Out.Write([Text.Encoding]::UTF8.GetString($c))} finally {[Array]::Clear($c,0,$c.Length)}';
    const ps = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, shell: false, env: { ...process.env, SP_WRITER_TOKENFILE: resolve(config.tokenFile) }, stdio: ["ignore", "pipe", "ignore"] });
    let answer = "";
    ps.stdout.on("data", chunk => { answer += chunk.toString("utf8"); if (answer.length > 500) ps.kill(); });
    ps.on("error", reject); ps.on("close", code => code === 0 && /^[A-Za-z0-9_-]{43,128}$/.test(answer.trim()) ? resolveToken(answer.trim()) : reject(new Error("연결 키를 읽을 수 없습니다.")));
  });
}
let token = await decryptToken();
async function post<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
  const response = await fetch(new URL(`/api/codex-writer/${path}`, base), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (!response.ok) throw new Error(`Studio HTTP ${response.status}`);
  const raw = await response.text(); if (raw.length > 350_000) throw new Error("결과가 너무 큽니다.");
  return JSON.parse(raw) as T;
}
const pause = (ms: number) => new Promise<void>(resolvePause => {
  const done = () => { clearTimeout(timer); stop.signal.removeEventListener("abort", done); resolvePause(); };
  const timer = setTimeout(done, ms); stop.signal.addEventListener("abort", done, { once: true }); if (stop.signal.aborted) done();
});
const status = async (state: string) => { await writeFile(join(directory, "status.json"), JSON.stringify({ state, updatedAt: new Date().toISOString(), model: CODEX_WRITER_MODEL }), { mode: 0o600 }); };
const invoke = createCodexInvoker(config.codexPath);
let current: AbortController | null = null, phase: "draft" | "review" | "revision" = "draft", ticking = false;
const heartbeat = async () => {
  if (ticking || stop.signal.aborted) return;
  ticking = true;
  try {
    await post("heartbeat", { deviceName: (config.deviceName || hostname()).slice(0, 100), model: CODEX_WRITER_MODEL });
    await status(current ? phase : "connected");
    // One independent safe export advancement; no generation is started by this tick.
    await post("canva-sync-tick", {}).catch(() => {});
  } catch { await status("reconnecting"); }
  finally { ticking = false; }
};
const timer = setInterval(() => { void heartbeat(); }, 15_000);
try {
  await heartbeat();
  while (!stop.signal.aborted) {
    let claim: CodexWriterClaim | null = null;
    try { claim = (await post<{ job: CodexWriterClaim | null }>("claim", {})).job; }
    catch { await status("reconnecting"); await pause(10_000); continue; }
    if (!claim) { await pause(3_000); continue; }
    current = new AbortController();
    const controller = current;
    const abort = () => controller.abort(); stop.signal.addEventListener("abort", abort, { once: true });
    let checking = false, lastHealthy = Date.now();
    const leaseHeartbeat = async () => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try {
        const receipt = await post<{ continue: boolean }>(`jobs/${claim!.jobId}/heartbeat`, { leaseId: claim!.leaseId, phase });
        if (!receipt.continue) controller.abort(); else lastHealthy = Date.now();
      } catch { if (Date.now() - lastHealthy > 40_000) controller.abort(); }
      finally { checking = false; }
    };
    const leaseTimer = setInterval(() => { void leaseHeartbeat(); }, 10_000);
    try {
      const result = await writeAndReview(claim, invoke, controller.signal, async next => { phase = next; await leaseHeartbeat(); controller.signal.throwIfAborted(); });
      // Retry delivering the SAME result only; never regenerate after a lost response.
      let delivered = false;
      for (let attempt = 0; attempt < 3 && !controller.signal.aborted; attempt++) {
        try { await post(`jobs/${claim.jobId}/complete`, { leaseId: claim.leaseId, ...result }); delivered = true; break; }
        catch { await pause(2000); }
      }
      await status(delivered ? "connected" : "delivery_unknown");
    } catch (error) {
      const reason = controller.signal.aborted ? "cancelled" : error instanceof WriterRuntimeError ? error.reason : "invalid_output";
      await post(`jobs/${claim.jobId}/fail`, { leaseId: claim.leaseId, reason }).catch(() => {});
      await status("request_stopped");
    } finally { clearInterval(leaseTimer); stop.signal.removeEventListener("abort", abort); current = null; }
  }
} finally {
  clearInterval(timer); current?.abort(); token = "";
  await lock.close(); await unlink(lockPath).catch(() => {}); await status("stopped");
}
