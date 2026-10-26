import { describe, expect, it } from "vitest";
import type { Artwork } from "../types";
import { discoveryCoverage, rankDiscoveryCandidates } from "./discovery";

const art = (id: number, artist: string, culture?: string, objectType?: string, provider: Artwork["provider"] = "chicago"): Artwork => ({
  id, provider, file: String(id), title: `Work ${id}`, artist, date: "", description: "", thumb: "", original: "", source: "https://example.org",
  width: 0, height: 0, license: "Public domain", licenseUrl: "", attribution: "",
  facets: { culture: culture ? { value: culture, rawValue: culture, source: "https://example.org", evidence: "provider" } : undefined,
    objectType: objectType ? { value: objectType, rawValue: objectType, source: "https://example.org", evidence: "provider" } : undefined },
});

describe("discovery diversity", () => {
  it("ranks unseen authors, cultures and object types above familiar candidates", () => {
    const familiar = art(1, "Known Artist", "France", "Painting");
    const novel = art(2, "New Artist", "Japan", "Print", "met");
    const ranked = rankDiscoveryCandidates([familiar, novel], { selected: [art(3, "Wall Artist", "France", "Painting")],
      seenIds: new Set([1]), seenArtists: new Set(["known artist"]), seenCultures: new Set(["france"]),
      seenTypes: new Set(["painting"]), previousIds: [1] });
    expect(ranked.map((item) => item.id)).toEqual([2, 1]);
    expect(discoveryCoverage([novel, art(4, "匿名", undefined, undefined)], new Set(), new Set(), new Set()))
      .toEqual({ newArtists: 1, newCultures: 1, newTypes: 1, unknownCulture: 1, unknownType: 1 });
  });
  it("does not surface the same known work twice in one wall", () => {
    const current = art(10, "Ada", "China", "Drawing");
    const duplicate = { ...current, id: 20, provider: "met" as const };
    expect(rankDiscoveryCandidates([duplicate, art(21, "Bea")], { selected: [current], seenIds: new Set(),
      seenArtists: new Set(), seenCultures: new Set(), seenTypes: new Set(), previousIds: [] }).map((item) => item.id)).toEqual([21]);
  });
});
