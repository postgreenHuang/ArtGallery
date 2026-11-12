import { expect, it, vi } from "vitest";
import { defaultLibrary, type Artwork, type ArtistSuggestion } from "../../types";
import { runRecommendationSearch } from "./run";

const { searchForCurator } = vi.hoisted(() => ({ searchForCurator: vi.fn() }));
vi.mock("../artSearch", () => ({ searchForCurator }));

it("searches every recommended artist on Commons first and keeps per-artist cursors", async () => {
  const artists: ArtistSuggestion[] = ["Ada", "Bea", "Cora", "Extra"].map((name) => ({
    nameZh: name, nameEn: name, query: name, reason: "相关风格",
  }));
  searchForCurator.mockImplementation(async (query: string, _settings: unknown, _signal: unknown, constraints: { providers: string[] }) => {
    const id = artists.findIndex((artist) => artist.query === query) + 1;
    const art: Artwork = { id, file: "", title: `Work ${id}`, artist: query, date: "", description: "",
      thumb: "", original: "", source: "https://museum.example/art", width: 0, height: 0,
      license: "CC0", licenseUrl: "", attribution: "" };
    return { artworks: [art], webResults: [], detailCalls: 2, sourceQueries: [], sourceStatuses: [],
      warning: "", scope: "commons", offsets: { commons: id * 8 }, providers: constraints.providers };
  });
  try {
    const result = await runRecommendationSearch({ recommendations: artists, settings: defaultLibrary.settings,
      signal: new AbortController().signal });
    expect(searchForCurator).toHaveBeenCalledTimes(3);
    expect(searchForCurator.mock.calls.map((call) => call[3].providers)).toEqual([["commons"], ["commons"], ["commons"]]);
    expect(searchForCurator.mock.calls.every((call) => call[1].scope === "commons" && call[3].pageSize === 8)).toBe(true);
    expect(result.artworks.map((art) => art.artist)).toEqual(["Ada", "Bea", "Cora"]);
    expect(result.artistCursors.map((cursor) => [cursor.name, cursor.offsets.commons])).toEqual([
      ["Ada", 8], ["Bea", 16], ["Cora", 24],
    ]);
    expect(result.diagnostics).toMatchObject({ sourceCalls: 3, sourceLimit: 6, detailCalls: 6,
      attemptedQueries: ["Ada", "Bea", "Cora"] });
    expect(result.suggestions).toHaveLength(3);
  } finally { searchForCurator.mockReset(); }
});

it("uses one named museum fallback only for artists absent from Commons", async () => {
  const artists: ArtistSuggestion[] = ["Ada", "Bea"].map((name) => ({ nameZh: name, nameEn: name, query: name, reason: "相似" }));
  searchForCurator.mockImplementation(async (query: string, _settings: unknown, _signal: unknown, constraints: { providers: string[] }) => ({
    artworks: constraints.providers[0] === "commons" && query === "Bea" ? [{ id: 2, artist: "Bea", title: "Work", recordKey: "commons:2" }] : [],
    webResults: [], offsets: {}, warning: "", sourceQueries: [], sourceStatuses: [], detailCalls: 0,
  }));
  try {
    const result = await runRecommendationSearch({ recommendations: artists, settings: defaultLibrary.settings,
      signal: new AbortController().signal });
    expect(searchForCurator.mock.calls.map((call) => [call[0], call[3].providers])).toEqual([
      ["Ada", ["commons"]], ["Bea", ["commons"]], ["Ada", ["cleveland"]],
    ]);
    expect(result.diagnostics.sourceCalls).toBe(3);
  } finally { searchForCurator.mockReset(); }
});
