import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "../server/db";
import { getCanvaDesign, getCanvaLibraryPages, getCanvaPrincipal } from "../server/services/canvaRest";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const identity = (id = "one") => ({ team_user: { user_id: `user_${id}`, team_id: `team_${id}` } });
let db: DB;
beforeEach(() => {
  db = {} as DB;
  vi.stubEnv("CANVA_CLIENT_ID", "isolated-client"); vi.stubEnv("CANVA_CLIENT_SECRET", "isolated-secret");
  vi.stubEnv("CANVA_ACCESS_TOKEN", "isolated-access-one"); vi.stubEnv("CANVA_REFRESH_TOKEN", "isolated-refresh");
  vi.stubEnv("CANVA_TOKEN_EXPIRES_AT", String(Date.now() + 3600000));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unmocked external request prohibited"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("bounded Canva identity reads", () => {
  it("coalesces concurrent reads and reuses the validated result without caller mutation leaking", async () => {
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(resolve => { release = resolve; }));
    const first = getCanvaPrincipal(db, { fetchImpl }), second = getCanvaPrincipal(db, { fetchImpl });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    release(json(identity()));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ userId: "user_one", teamId: "team_one" }); expect(b).toEqual(a); expect(b).not.toBe(a);
    a.userId = "caller_changed";
    expect(await getCanvaPrincipal(db, { fetchImpl })).toEqual({ userId: "user_one", teamId: "team_one" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("expires after sixty seconds without extending freshness on frequent cache hits", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1900000000000);
    vi.stubEnv("CANVA_TOKEN_EXPIRES_AT", "1900003600000");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json(identity())).mockResolvedValueOnce(json(identity("two")));
    await getCanvaPrincipal(db, { fetchImpl });
    clock.mockReturnValue(1900000059999);
    expect((await getCanvaPrincipal(db, { fetchImpl })).userId).toBe("user_one"); expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(1900000060000);
    expect((await getCanvaPrincipal(db, { fetchImpl })).userId).toBe("user_two"); expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("changes identity immediately when the current access token changes and never serves a disconnected cache", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json(identity())).mockResolvedValueOnce(json(identity("two")));
    await getCanvaPrincipal(db, { fetchImpl });
    vi.stubEnv("CANVA_ACCESS_TOKEN", "isolated-access-two");
    expect((await getCanvaPrincipal(db, { fetchImpl })).userId).toBe("user_two");
    vi.stubEnv("CANVA_REFRESH_TOKEN", "");
    await expect(getCanvaPrincipal(db, { fetchImpl })).rejects.toMatchObject({ code: "not_connected" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("separates different database and fetch identities and evicts beyond eight cached identities", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json(identity()));
    await getCanvaPrincipal(db, { fetchImpl });
    await getCanvaPrincipal({} as DB, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const otherFetch = vi.fn<typeof fetch>().mockImplementation(async () => json(identity("other")));
    expect((await getCanvaPrincipal(db, { fetchImpl: otherFetch })).userId).toBe("user_other");
    for (let index = 2; index <= 9; index++) {
      vi.stubEnv("CANVA_ACCESS_TOKEN", `isolated-access-${index}`); await getCanvaPrincipal(db, { fetchImpl });
    }
    vi.stubEnv("CANVA_ACCESS_TOKEN", "isolated-access-one");
    await getCanvaPrincipal(db, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(11);
  });
  it("does not cache a provider rejection or an invalid principal", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ code: "too_many_requests" }, 429))
      .mockResolvedValueOnce(json({ team_user: { user_id: "invalid missing team" } })).mockResolvedValueOnce(json(identity()));
    await expect(getCanvaPrincipal(db, { fetchImpl })).rejects.toMatchObject({ code: "rate_limited" });
    await expect(getCanvaPrincipal(db, { fetchImpl })).rejects.toMatchObject({ code: "invalid_response" });
    expect((await getCanvaPrincipal(db, { fetchImpl })).userId).toBe("user_one");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("lets one caller cancel without cancelling a shared read used by another caller", async () => {
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(resolve => { release = resolve; })), controller = new AbortController();
    const cancelled = getCanvaPrincipal(db, { fetchImpl, signal: controller.signal });
    const survivor = getCanvaPrincipal(db, { fetchImpl });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort(); await expect(cancelled).rejects.toMatchObject({ code: "cancelled", outcomeUnknown: false });
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(false);
    release(json(identity())); expect((await survivor).userId).toBe("user_one");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("keeps design metadata and page geometry fresh while reusing only identity", async () => {
    let version = 1;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === "/rest/v1/users/me") return json(identity());
      if (path.endsWith("/pages")) return json({ items: [{ id: "page_one", page_number: 1, dimensions: { width: version * 100, height: 1350 } }] });
      return json({ design: { id: "design_one", page_count: 1, updated_at: version, owner: identity().team_user } });
    });
    for (version = 1; version <= 2; version++) {
      await getCanvaPrincipal(db, { fetchImpl });
      expect((await getCanvaDesign(db, "design_one", { fetchImpl })).updatedAt).toBe(version);
      expect((await getCanvaLibraryPages(db, "design_one", { fetchImpl }))[0].width).toBe(version * 100);
    }
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).endsWith("/users/me"))).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});
