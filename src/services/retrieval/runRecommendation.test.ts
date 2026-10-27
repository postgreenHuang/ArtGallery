import { expect, it, vi } from "vitest";
import { defaultLibrary, type Artwork, type ArtistSuggestion } from "../../types";
import { runRecommendationSearch } from "./run";

const { searchForCurator } = vi.hoisted(() => ({ searchForCurator: vi.fn() }));
vi.mock("../artSearch", () => ({ searchForCurator }));

it("budgets recommendation museums at six calls and records diagnostics", async () => {
  const artists: ArtistSuggestion[] = ["Ada", "Bea", "Cora", "Extra"].map((name) => ({
    nameZh: name, nameEn: name, query: name, reason: "相关风格",
  }));
  searchForCurator.mockImplementation(async (query: string, _settings: unknown, _signal: unknown, constraints: { providers: string[] }) => {
    const id = artists.findIndex((artist) => artist.query === query) + 1;
    const art: Artwork = { id, file: "", title: `Work ${id}`, artist: query, date: "", description: "",
      thumb: "", original: "", source: "https://museum.example/art", width: 0, height: 0,
      license: "CC0", licenseUrl: "", attribution: "" };
    return { artworks: [art], webResults: [], detailCalls: 2, sourceQueries: [], sourceStatuses: [],
      warning: "", scope: "google", offsets: {}, providers: constraints.providers };
  });
  try {
    const result = await runRecommendationSearch({ recommendations: artists, settings: defaultLibrary.settings,
      signal: new AbortController().signal });
    expect(searchForCurator).toHaveBeenCalledTimes(3);
    expect(searchForCurator.mock.calls.map((call) => call[3].providers)).toEqual([
      ["commons", "cleveland"], ["chicago", "met"], ["commons", "chicago"],
    ]);
    expect(result.artworks.map((art) => art.artist)).toEqual(["Ada", "Bea", "Cora"]);
    expect(result.diagnostics).toMatchObject({ sourceCalls: 6, sourceLimit: 6, detailCalls: 6,
      attemptedQueries: ["Ada", "Bea", "Cora"] });
    expect(result.suggestions).toHaveLength(3);
  } finally { searchForCurator.mockReset(); }
});
