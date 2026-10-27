import { describe, expect, it, vi } from "vitest";
vi.mock("./storage", () => ({ desktop: false }));
import { clevelandSearchParams, normalizeChicago, normalizeCleveland, safeMuseumImage } from "./museums";
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

  it("keeps print and watercolor searches out of the default Painting filter", () => {
    expect(clevelandSearchParams("Hokusai woodcut").get("type")).toBe("Print");
    expect(clevelandSearchParams("watercolor garden").has("type")).toBe(false);
    expect(clevelandSearchParams("Claude Monet", 8, "Claude Monet").get("artists")).toBe("Claude Monet");
    expect(clevelandSearchParams("Claude Monet").has("type")).toBe(false);
    const record = normalizeChicago({ ...chicago, classification_title: "Print", style_titles: ["Impressionism"],
      subject_titles: ["Gardens"], medium_display: "Etching on paper" }, "https://www.artic.edu/iiif/2")!;
    expect(record.facets).toMatchObject({ objectType: { value: "Print" }, medium: { value: "Etching on paper" } });
    expect(record.facets?.subjects?.[0].value).toBe("Gardens");
  });

  it("preserves public-domain source records without images for exact artist searches", () => {
    expect(clevelandSearchParams("Claude Monet").get("has_image")).toBe("1");
    expect(clevelandSearchParams("Claude Monet", 0, "Claude Monet").has("has_image")).toBe(false);
    const cma = normalizeCleveland({ ...cleveland, images: undefined });
    const aic = normalizeChicago({ ...chicago, image_id: undefined }, "");
    expect(cma).toMatchObject({ provider: "cleveland", thumb: "", original: "", source: "https://www.clevelandart.org/art/101" });
    expect(aic).toMatchObject({ provider: "chicago", thumb: "", original: "" });
    expect(normalizeCleveland({ ...cleveland, images: { web: { url: "https://evil.example/a.jpg" } } })).toBeNull();
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
