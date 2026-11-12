import { describe, expect, it } from "vitest";
import type { Artwork } from "../types";
import { floatingArtworkUrl, parseFloatingArtworkPayload } from "./floatingArtwork";

const art: Artwork = { id: 73, file: "File:Landscape.jpg", title: "Landscape", artist: "A Painter", date: "1900",
  description: "A long museum description is not needed in the viewing window.",
  thumb: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Landscape.jpg/640px-Landscape.jpg",
  original: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Landscape.jpg",
  source: "https://commons.wikimedia.org/wiki/File:Landscape.jpg", width: 3000, height: 2000,
  license: "Public domain", licenseUrl: "", attribution: "" };

describe("detached artwork window payload", () => {
  it("passes the artwork image and theme without the long description", () => {
    const url = floatingArtworkUrl(art, "collection/originals/73.jpg", "dark");
    const parsed = parseFloatingArtworkPayload(new URL(url, "https://atelier.local").searchParams.get("floatingArtwork"));
    expect(parsed).toMatchObject({ art: { id: 73, title: "Landscape", original: art.original, description: "" },
      originalLocal: "collection/originals/73.jpg", theme: "dark" });
  });
  it("rejects an untrusted image host", () => {
    const url = floatingArtworkUrl({ ...art, thumb: "https://example.com/tracker.jpg" }, undefined, "light");
    expect(parseFloatingArtworkPayload(new URL(url, "https://atelier.local").searchParams.get("floatingArtwork"))).toBeNull();
  });
});
