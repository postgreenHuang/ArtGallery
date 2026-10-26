import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultLibrary } from "../../types";
import { runCuratorSearch } from "./run";

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
});
