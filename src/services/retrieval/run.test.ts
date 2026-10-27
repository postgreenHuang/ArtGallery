import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultLibrary } from "../../types";
import { runCuratorSearch, supplementAfterRejection } from "./run";

const { searchForCurator, searchWebPages } = vi.hoisted(() => ({ searchForCurator: vi.fn(), searchWebPages: vi.fn() }));
vi.mock("../artSearch", () => ({ searchForCurator }));
vi.mock("../webSearch", () => ({ searchWebPages }));

const empty = (webResults: unknown[] = []) => ({ artworks: [], webResults, offsets: {}, scope: "google",
  warning: "", failed: false });
const args = () => ({ query: "quiet landscape", alternativeQueries: ["quiet landscape painting", "serene view"],
  settings: { ...defaultLibrary.settings, webSearch: true }, constraints: {}, desktop: true,
  signal: new AbortController().signal });

beforeEach(() => { searchForCurator.mockReset(); searchWebPages.mockReset(); });

describe("bounded retrieval run", () => {
  it("stops after a useful first group and does not spend the supplement budget", async () => {
    searchForCurator.mockResolvedValueOnce({ ...empty(), artworks: [{ id: 1, title: "A work" }] });
    const result = await runCuratorSearch(args());
    expect(result.diagnostics.sourceCalls).toBe(4);
    expect(result.queries).toEqual(["quiet landscape"]);
    expect(searchForCurator.mock.calls[0][3].providers).toEqual(["commons", "cleveland", "chicago"]);
    expect(searchWebPages).not.toHaveBeenCalled();
  });
  it("uses one other museum and one web-page lookup, preserving image clues", async () => {
    searchForCurator.mockResolvedValueOnce(empty([{ url: "https://example.org/image", title: "image" }]))
      .mockResolvedValueOnce(empty());
    searchWebPages.mockResolvedValueOnce([{ url: "https://example.org/page", title: "source" }]);
    const result = await runCuratorSearch(args());
    expect(result.diagnostics.sourceCalls).toBe(6);
    expect(result.queries).toEqual(["quiet landscape", "quiet landscape painting"]);
    expect(searchForCurator.mock.calls[1][3].providers).toEqual(["met"]);
    expect(searchForCurator.mock.calls[1][1].webSearch).toBe(false);
    expect(result.webResults.map((item) => item.url)).toEqual(["https://example.org/image", "https://example.org/page"]);
  });
  it("preserves first-source cursors when a supplementary source is searched", async () => {
    searchForCurator.mockResolvedValueOnce({ ...empty(), offsets: { chicago: 8 } })
      .mockResolvedValueOnce({ ...empty(), offsets: { met: 8 } });
    searchWebPages.mockResolvedValueOnce([]);
    const result = await runCuratorSearch(args());
    expect(result.offsets).toEqual({ chicago: 8, met: 8 });
  });
  it("uses one untried source after all first candidates are rejected", async () => {
    searchForCurator.mockResolvedValueOnce({ ...empty(), sourceQueries: [{ provider: "met", filters: {}, applied: [], deferred: [] }] });
    const diagnostics = { runId: "run", sourceCalls: 4, sourceLimit: 6, attemptedQueries: ["landscape"],
      sourceQueries: (["commons", "cleveland", "chicago"] as const).map((provider) => ({ provider, filters: {}, applied: [], deferred: [] })) };
    const result = await supplementAfterRejection({ query: "landscape", settings: args().settings,
      constraints: {}, diagnostics, signal: new AbortController().signal });
    expect(searchForCurator.mock.calls[0][3].providers).toEqual(["met"]);
    expect(searchForCurator.mock.calls[0][1].webSearch).toBe(false);
    expect(result?.diagnostics).toMatchObject({ sourceCalls: 5, qualitySupplemented: true });
    expect(result?.diagnostics.sourceQueries).toHaveLength(4);
    expect(await supplementAfterRejection({ query: "landscape", settings: args().settings,
      constraints: {}, diagnostics: result?.diagnostics, signal: new AbortController().signal })).toBeNull();
  });
  it("does not publish a late result after cancellation", async () => {
    const controller = new AbortController();
    searchForCurator.mockImplementationOnce(async () => { controller.abort(); return empty(); });
    await expect(runCuratorSearch({ ...args(), signal: controller.signal })).rejects.toThrow("已停止");
    expect(searchWebPages).not.toHaveBeenCalled();
  });
  it("keeps the same six-operation ceiling without Brave", async () => {
    searchForCurator.mockResolvedValue(empty());
    const result = await runCuratorSearch({ ...args(), settings: { ...defaultLibrary.settings, webSearch: false } });
    expect(result.diagnostics.sourceCalls).toBe(6);
    expect(searchForCurator.mock.calls[0][3].providers).toHaveLength(4);
    expect(searchForCurator.mock.calls[1][3].providers).toEqual(["met", "commons"]);
    expect(searchWebPages).not.toHaveBeenCalled();
  });
  it("does not repeat the same four museum queries when no alternate wording exists", async () => {
    searchForCurator.mockResolvedValue(empty());
    const result = await runCuratorSearch({ ...args(), alternativeQueries: [],
      settings: { ...defaultLibrary.settings, webSearch: false } });
    expect(result.diagnostics.sourceCalls).toBe(4);
    expect(result.queries).toEqual(["quiet landscape"]);
    expect(searchForCurator).toHaveBeenCalledTimes(1);
  });
  it("does not immediately retry a rate-limited provider with an alternate query", async () => {
    searchForCurator.mockResolvedValueOnce({ ...empty(), sourceStatuses: [
      { provider: "met", state: "limited", candidateCount: 0, matchedCount: 0 },
    ] }).mockResolvedValueOnce(empty());
    const result = await runCuratorSearch({ ...args(), settings: { ...defaultLibrary.settings, webSearch: false } });
    expect(result.diagnostics.sourceCalls).toBe(5);
    expect(searchForCurator.mock.calls[1][3].providers).toEqual(["commons"]);
  });
  it("counts Met detail requests separately from provider-search operations", async () => {
    searchForCurator.mockResolvedValueOnce({ ...empty(), detailCalls: 8 })
      .mockResolvedValueOnce({ ...empty(), detailCalls: 4 });
    const result = await runCuratorSearch({ ...args(), settings: { ...defaultLibrary.settings, webSearch: false } });
    expect(result.diagnostics).toMatchObject({ sourceCalls: 6, detailCalls: 12 });
  });
});
