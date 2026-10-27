import { expect, it, vi } from "vitest";
import type { Artwork } from "../types";
import { discoverArt } from "./discovery";

const { searchProvider } = vi.hoisted(() => ({ searchProvider: vi.fn() }));
vi.mock("./artSearch", () => ({ providers: ["commons", "cleveland", "chicago", "met"], searchProvider }));

it("does not repeat work groups across five real discovery cycles when source pages have supply", async () => {
  const pages = new Map<string, number>();
  searchProvider.mockImplementation(async (provider: string, query: string, _scope: string, offset: number) => {
    const key = `${provider}:${query}`;
    if (!pages.has(key)) pages.set(key, pages.size + 1);
    const base = pages.get(key)! * 1000 + offset;
    const artworks: Artwork[] = Array.from({ length: 8 }, (_, index) => ({
      id: base + index + 1, provider: provider === "commons" ? undefined : provider as Artwork["provider"],
      file: "", title: `Work ${base + index + 1}`, artist: `Artist ${base + index + 1}`,
      date: "", description: "", thumb: "", original: "", source: "https://museum.example/art",
      width: 0, height: 0, license: "CC0", licenseUrl: "", attribution: "",
      facets: { culture: { value: `Culture ${index % 4}`, rawValue: "", source: "", evidence: "provider" },
        objectType: { value: index % 2 ? "Print" : "Painting", rawValue: "", source: "", evidence: "provider" } },
    }));
    return { artworks, offset: offset + 8 };
  });
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  try {
    let topics: string[] = [], previousIds: number[] = [], offsets: Record<string, number> = {};
    const seenIds = new Set<number>(), seenArtists = new Set<string>(), seenCultures = new Set<string>(), seenTypes = new Set<string>();
    for (let cycle = 0; cycle < 5; cycle++) {
      const result = await discoverArt("google", topics, previousIds, seenIds, offsets, new AbortController().signal,
        seenArtists, seenCultures, seenTypes);
      expect(result.artworks).toHaveLength(5);
      expect(result.sourceCalls).toBeLessThanOrEqual(10);
      expect(result.coverage.newArtists).toBe(5);
      expect(result.coverage.unknownCulture).toBe(0);
      previousIds = result.artworks.map((item) => item.id);
      topics = result.artists; offsets = result.offsets;
      result.artworks.forEach((item) => {
        expect(seenIds.has(item.id)).toBe(false);
        seenIds.add(item.id); seenArtists.add(item.artist.toLocaleLowerCase());
        seenCultures.add(item.facets!.culture!.value.toLocaleLowerCase());
        seenTypes.add(item.facets!.objectType!.value.toLocaleLowerCase());
      });
    }
    expect(seenIds.size).toBe(25);
  } finally { random.mockRestore(); searchProvider.mockReset(); }
});
