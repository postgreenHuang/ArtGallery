import { describe, expect, it } from "vitest";
import type { Artwork } from "../types";
import { discoveryCoverage, discoveryProviderOrder, discoveryRateLimited, rankDiscoveryCandidates, sourceOrderDiscoveryCandidates } from "./discovery";

const art = (id: number, artist: string, culture?: string, objectType?: string, provider: Artwork["provider"] = "chicago"): Artwork => ({
  id, provider, file: String(id), title: `Work ${id}`, artist, date: "", description: "", thumb: "", original: "", source: "https://example.org",
  width: 0, height: 0, license: "Public domain", licenseUrl: "", attribution: "",
  facets: { culture: culture ? { value: culture, rawValue: culture, source: "https://example.org", evidence: "provider" } : undefined,
    objectType: objectType ? { value: objectType, rawValue: objectType, source: "https://example.org", evidence: "provider" } : undefined },
});

describe("discovery diversity", () => {
  it("bounds a five-topic refresh to two provider searches per topic", () => {
    const attempts = Array.from({ length: 5 }, (_, index) => discoveryProviderOrder(index));
    expect(attempts).toEqual([
      ["commons", "cleveland"], ["cleveland", "commons"], ["chicago", "commons"],
      ["met", "commons"], ["commons", "cleveland"],
    ]);
    expect(attempts.flat()).toHaveLength(10);
  });
  it("recognizes a provider cooldown without treating an empty result as rate limited", () => {
    expect(discoveryRateLimited(new Error("Wikimedia HTTP 429"))).toBe(true);
    expect(discoveryRateLimited("来源限流，进入冷却期")).toBe(true);
    expect(discoveryRateLimited("没有匹配作品")).toBe(false);
  });
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
  it("can preserve source order without showing the same work twice in one group", () => {
    const chosen = art(10, "Ada", "China", "Drawing");
    expect(sourceOrderDiscoveryCandidates([art(1, "Familiar"), { ...chosen, id: 20, provider: "met" }, art(2, "Novel")], [chosen])
      .map((item) => item.id)).toEqual([1, 2]);
  });
  it("selects new work groups across five refreshes when the fixed sample has enough supply", () => {
    const pool = Array.from({ length: 30 }, (_, index) => art(index + 1, `Artist ${index + 1}`,
      `Culture ${index % 6}`, index % 2 ? "Print" : "Painting"));
    const seenIds = new Set<number>(), seenArtists = new Set<string>();
    const seenCultures = new Set<string>(), seenTypes = new Set<string>();
    let previousIds: number[] = [];
    const groups: number[][] = [];
    for (let refresh = 0; refresh < 5; refresh++) {
      const selected: Artwork[] = [];
      for (let slot = 0; slot < 5; slot++) {
        const ranked = rankDiscoveryCandidates(pool, { selected, seenIds, seenArtists, seenCultures, seenTypes, previousIds });
        selected.push(ranked.find((candidate) => !seenIds.has(candidate.id))!);
      }
      const coverage = discoveryCoverage(selected, seenArtists, seenCultures, seenTypes);
      expect(coverage.newArtists).toBe(5);
      expect(coverage.unknownCulture).toBe(0);
      expect(coverage.unknownType).toBe(0);
      groups.push(selected.map((item) => item.id));
      previousIds = selected.map((item) => item.id);
      selected.forEach((item) => {
        seenIds.add(item.id); seenArtists.add(item.artist.toLocaleLowerCase());
        seenCultures.add(item.facets!.culture!.value.toLocaleLowerCase());
        seenTypes.add(item.facets!.objectType!.value.toLocaleLowerCase());
      });
    }
    expect(new Set(groups.flat()).size).toBe(25);
  });
});
