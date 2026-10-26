import { beforeEach, describe, expect, it, vi } from "vitest";
import { continuationProviders, runContinuationSearch } from "./continue";

const { searchAcrossProviders, searchArt } = vi.hoisted(() => ({ searchAcrossProviders: vi.fn(), searchArt: vi.fn() }));
vi.mock("../artSearch", () => ({ providers: ["commons", "cleveland", "chicago", "met"], searchAcrossProviders }));
vi.mock("../commons", () => ({ searchArt }));
beforeEach(() => { searchAcrossProviders.mockReset(); searchArt.mockReset(); });

describe("bounded continuation", () => {
  it("round-robins two available providers and preserves unqueried cursors", async () => {
    expect(continuationProviders({ commons: 8, cleveland: 8, chicago: 8, met: 8 }, 2)).toEqual(["chicago", "met"]);
    searchAcrossProviders.mockResolvedValue({ artworks: [], offsets: { chicago: 16 }, warning: "" });
    const result = await runContinuationSearch({ query: "landscape", scope: "commons",
      offsets: { commons: 8, cleveland: 8, chicago: 8, met: 8 }, rotation: 2,
      signal: new AbortController().signal });
    expect(searchAcrossProviders.mock.calls[0][3]).toEqual({ chicago: 8, met: 8 });
    expect(searchAcrossProviders.mock.calls[0][4].providers).toEqual(["chicago", "met"]);
    expect(result.offsets).toEqual({ commons: 8, cleveland: 8, chicago: 16 });
    expect(result.diagnostics).toMatchObject({ sourceCalls: 2, sourceLimit: 2, attemptedProviders: ["chicago", "met"] });
    expect(result.rotation).toBe(4);
  });
  it("keeps a retryable cursor when a selected provider fails", async () => {
    searchAcrossProviders.mockResolvedValue({ artworks: [], offsets: { commons: 8 }, warning: "部分馆藏暂不可用" });
    const result = await runContinuationSearch({ query: "landscape", scope: "commons",
      offsets: { commons: 8, cleveland: 8 }, signal: new AbortController().signal });
    expect(result.offsets).toEqual({ commons: 8 });
    expect(result.warning).toContain("暂不可用");
  });
  it("uses one operation for legacy Commons pagination", async () => {
    searchArt.mockResolvedValue({ artworks: [], offset: 20 });
    const result = await runContinuationSearch({ query: "garden", scope: "google", legacyOffset: 10,
      signal: new AbortController().signal });
    expect(searchArt).toHaveBeenCalledWith("garden", "google", 10, expect.any(AbortSignal));
    expect(result.legacyOffset).toBe(20);
    expect(result.diagnostics.sourceCalls).toBe(1);
  });
});
