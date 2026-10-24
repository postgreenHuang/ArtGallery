import { describe, expect, it, vi } from "vitest";
vi.mock("./storage", () => ({ desktop: false }));
import { normalizeChicago, normalizeCleveland, safeMuseumImage } from "./museums";
import { searchAcrossProviders } from "./artSearch";
import { sizedImage } from "./commons";

const cleveland = {
  id: 101, title: "Water lilies", share_license_status: "CC0",
  creators: [{ role: "artist", description: "Claude Monet" }],
  images: {
    web: { url: "https://openaccess-cdn.clevelandart.org/101/101_web.jpg", width: 900, height: 600 },
    print: { url: "https://openaccess-cdn.clevelandart.org/101/101_print.jpg", width: 3400, height: 2200 },
  },
};
const chicago = {
  id: 101, title: "Garden", artist_display: "Claude Monet",
  is_public_domain: true, image_id: "2d484387-2509-5e8e-2c43-22f9981972eb",
};

describe("independent museum collections", () => {
  it("namespaces IDs and rejects images outside an exact museum host", async () => {
    const cma = normalizeCleveland(cleveland)!;
    const aic = normalizeChicago(chicago, "https://www.artic.edu/iiif/2")!;
    expect(cma.id).toBe(1_000_000_000_101);
    expect(aic.id).toBe(2_000_000_000_101);
    expect(cma.original).toContain("_print.jpg");
    expect(aic.original).toContain("/full/full/0/default.jpg");
    expect(await sizedImage(cma, 2400)).toBe(cma.hd);
    expect(await sizedImage(aic, 1280)).toBe(aic.medium);
    expect(safeMuseumImage("https://openaccess-cdn.clevelandart.org.evil.test/101/101_web.jpg", "cleveland")).toBe(false);
    expect(normalizeCleveland({ ...cleveland, share_license_status: "Copyrighted" })).toBeNull();
    expect(normalizeChicago({ ...chicago, is_public_domain: false }, "https://www.artic.edu/iiif/2")).toBeNull();
  });

  it("keeps both museum results when Wikimedia returns 429", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("commons.wikimedia.org")) return new Response("limited", { status: 429 });
      if (url.includes("clevelandart.org")) return new Response(JSON.stringify({ info: { total: 1 }, data: [cleveland] }));
      return new Response(JSON.stringify({ config: { iiif_url: "https://www.artic.edu/iiif/2" }, pagination: { total: 1 }, data: [chicago] }));
    });
    try {
      const result = await searchAcrossProviders("Monet", "google", new AbortController().signal);
      expect(result.artworks.map((art) => art.provider)).toEqual(["cleveland", "chicago"]);
      expect(result.warning).toContain("部分馆藏");
    } finally {
      fetcher.mockRestore();
    }
  });
});
