import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearArtistIdentityCache, normalizeArtistSearch, resolveArtistIdentity } from "./entityResolver";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./storage", () => ({ desktop: true }));
beforeEach(() => { invoke.mockReset(); clearArtistIdentityCache(); });

describe("bounded artist identity lookup", () => {
  it("accepts only artist-like Wikidata items with valid IDs", () => {
    expect(normalizeArtistSearch({ search: [
      { id: "Q1", label: "Alex Kim", description: "Korean painter" },
      { id: "Q2", label: "Alex Kim", description: "businessperson" },
      { id: "javascript:bad", label: "Alex Kim", description: "artist" },
    ] })).toHaveLength(1);
  });
  it("adds a cross-language alias only when one identity matches both names and caches lookups", async () => {
    invoke.mockImplementation(async (_command, args) => ({ search: [{ id: "Q123", label: args.language === "zh" ? "张华" : "Zhang Hua",
      description: args.language === "zh" ? "中国画家" : "Chinese painter", match: { text: args.query } }] }));
    const signal = new AbortController().signal;
    const first = await resolveArtistIdentity("Zhang Hua", "张华", signal);
    const second = await resolveArtistIdentity("Zhang Hua", "张华", signal);
    expect(first).toEqual({ aliases: ["张华"], choices: [] });
    expect(second).toEqual(first);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("does not auto-select among two exact artist identities", async () => {
    invoke.mockResolvedValue({ search: [
      { id: "Q11", label: "Alex Kim", description: "American painter" },
      { id: "Q22", label: "Alex Kim", description: "Korean artist" },
    ] });
    const result = await resolveArtistIdentity("Alex Kim", "find Alex Kim", new AbortController().signal);
    expect(result.aliases).toEqual([]);
    expect(result.choices.map((item) => item.id)).toEqual(["Q11", "Q22"]);
  });
  it("ignores an unavailable identity index and honors cancellation", async () => {
    invoke.mockRejectedValueOnce(new Error("offline"));
    expect(await resolveArtistIdentity("Alex Kim", "find Alex Kim", new AbortController().signal)).toEqual({ aliases: [], choices: [] });
    clearArtistIdentityCache();
    const controller = new AbortController();
    invoke.mockImplementationOnce(async () => { controller.abort(); return { search: [] }; });
    await expect(resolveArtistIdentity("Alex Kim", "find Alex Kim", controller.signal)).rejects.toThrow("已停止");
  });
});
