import { describe, expect, it } from "vitest";
import { artworkRecordKey, legacyWorkRecord, parseAttribution } from "./artwork";
import type { Artwork } from "../types";

const oldArt = { id: 42, title: "An old saved work", artist: "After Claude Monet", date: "1900",
  description: "", thumb: "https://example.org/small.jpg", original: "https://example.org/full.jpg",
  source: "https://example.org/work/42", width: 0, height: 0, license: "unknown", licenseUrl: "", attribution: "" } as Artwork;

describe("compatible work identity", () => {
  it("keeps independent source IDs and reads old saved works without changing image URLs", () => {
    expect(artworkRecordKey(oldArt)).toBe("commons:42");
    expect(artworkRecordKey({ id: 1_000_000_000_042, provider: "cleveland" })).toBe("cleveland:42");
    expect(artworkRecordKey({ id: 2_000_000_000_042, provider: "chicago" })).toBe("chicago:42");
    expect(artworkRecordKey({ id: 3_000_000_000_042, provider: "met" })).toBe("met:42");
    const record = legacyWorkRecord(oldArt);
    expect(record.attribution).toMatchObject({ kind: "after", name: "Claude Monet" });
    expect(record.assets.map((asset) => asset.url)).toEqual([oldArt.thumb, oldArt.original]);
    expect(oldArt.original).toBe("https://example.org/full.jpg");
  });
  it("separates a creator from attribution qualifiers", () => {
    expect(parseAttribution("Workshop of Albrecht Dürer", "source").kind).toBe("workshop");
    expect(parseAttribution("Attributed to Albrecht Dürer", "source").kind).toBe("attributed_to");
    expect(parseAttribution("Albrecht Dürer", "source").kind).toBe("by");
    expect(parseAttribution("Anonymous", "source").kind).toBe("unknown");
  });
});
