import { describe, expect, it, vi } from "vitest";
vi.mock("./storage", () => ({ desktop: false }));
import { buildSearch, normalize, plain, safeImage, searchArt } from "./commons";
import {
  artworkIntroductionPrompt,
  isRecommendationRequest,
  localArtworkIntroduction,
  localPlan,
  parsePlan,
  parseSuggestions,
} from "./ai";
import type { Artwork } from "../types";
describe("Commons data boundary", () => {
  it("accepts current thumbnail CDN but rejects lookalike and credential URLs", () => {
    expect(safeImage("https://thumb.wikimedia.org/a.jpg")).toBe(true);
    expect(safeImage("https://upload.wikimedia.org/a.jpg")).toBe(true);
    expect(safeImage("https://upload.wikimedia.org.evil.test/a")).toBe(false);
    expect(safeImage("https://secret@upload.wikimedia.org/a")).toBe(false);
  });
  it("keeps the requested collection scope", () => {
    expect(buildSearch("Monet", "google")).toContain('"Google Art Project"');
    expect(buildSearch("Monet", "commons")).not.toContain("Google Art Project");
  });
  it("rejects missing thumbnails instead of downloading originals", () => {
    expect(
      normalize({
        pageid: 1,
        title: "File:A.jpg",
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/a.jpg",
            width: 9000,
            height: 9000,
            descriptionurl: "",
            mime: "image/jpeg",
          },
        ],
      }),
    ).toBeNull();
  });
  it("converts metadata to plain text", () => {
    expect(plain("<b>Monet</b> &amp; flowers")).toBe("Monet & flowers");
  });
  it("normalizes true results and preserves continuation", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          query: {
            pages: [
              {
                pageid: 42,
                title: "File:Garden.jpg",
                index: 1,
                imageinfo: [
                  {
                    url: "https://upload.wikimedia.org/original.jpg",
                    thumburl: "https://thumb.wikimedia.org/thumb.jpg",
                    descriptionurl: "",
                    width: 8000,
                    height: 6000,
                    mime: "image/jpeg",
                    extmetadata: {
                      ObjectName: { value: "Garden" },
                      Artist: { value: "<b>Monet</b>" },
                      LicenseShortName: { value: "Public domain" },
                    },
                  },
                ],
              },
            ],
          },
          continue: { gsroffset: 12 },
        }),
      ),
    );
    const result = await searchArt("Monet", "google");
    expect(result.offset).toBe(12);
    expect(result.artworks[0].artist).toBe("Monet");
    expect(result.artworks[0].thumb).toContain("thumb.wikimedia");
    expect(fetcher.mock.calls[0][0]).toContain("iiurlwidth=640");
    fetcher.mockRestore();
  });
  it("surfaces API errors, without fake fallback artwork", async () => {
    const f = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { info: "rate limited" } })),
      );
    await expect(searchArt("Monet", "google")).rejects.toThrow("rate limited");
    f.mockRestore();
  });
});
describe("curator planning", () => {
  it("introduces an artwork before any question without inventing its school", () => {
    const intro = localArtworkIntroduction({
      title: "Water lilies",
      artist: "Claude Monet",
      date: "1916",
      description: "画面描绘池塘。",
    } as Artwork);
    expect(intro).toContain("时代背景：馆藏标注创作于 1916");
    expect(intro).toContain("作者：馆藏署名为 Claude Monet");
    expect(intro).toContain("技法与风格流派：现有馆藏资料不足");
    expect(artworkIntroductionPrompt).toContain("不要等我提问");
  });
  it("maps common Chinese artist and theme queries without AI", () => {
    expect(localPlan("推荐莫奈的睡莲").query).toBe("Claude Monet water lilies");
    expect(localPlan("我想看一些希施金的画").query).toBe("Ivan Shishkin");
  });
  it("accepts bounded artist candidates and rejects invented URLs", () => {
    expect(
      parseSuggestions(
        '{"candidates":[{"nameZh":"希施金","nameEn":"Ivan Shishkin","query":"Ivan Shishkin","reason":"俄国风景画家"}]}',
      )[0].query,
    ).toBe("Ivan Shishkin");
    expect(
      parseSuggestions(
        '{"candidates":[{"nameZh":"假","nameEn":"Fake","query":"https://invalid.test/a","reason":"无"}]}',
      ),
    ).toHaveLength(0);
  });
  it("accepts a fenced structured response", () => {
    expect(
      parsePlan('```json\n{"query":"Monet","explanation":"看看莫奈"}\n```')
        .query,
    ).toBe("Monet");
    expect(
      parsePlan('Here is the plan:\n```json\n{"query":"Monet","explanation":"看 { 花园 }"}\n```')
        .explanation,
    ).toBe("看 { 花园 }");
    expect(() => parsePlan('{"query":"Monet"')).toThrow("不完整");
  });
  it("rejects invented result structures", () => {
    expect(() => parsePlan('{"url":"https://example.com/fake.jpg"}')).toThrow();
  });
  it("treats similar-style prompts as comparisons, not artist keyword searches", () => {
    expect(isRecommendationRequest("有没有类似希施金风格的作家推荐")).toBe(
      true,
    );
    expect(isRecommendationRequest("我想看希施金的画")).toBe(false);
    expect(localPlan("有没有类似希施金风格的作家推荐").explanation).toContain(
      "直接检索无法判断风格关联",
    );
    const plan = parsePlan(
      '{"query":"Isaac Levitan","explanation":"两人都关注风景，但处理光色的方式可作比较。","recommendations":[{"nameZh":"列维坦","nameEn":"Isaac Levitan","query":"Isaac Levitan","reason":"比较自然氛围"}]}',
    );
    expect(plan.recommendations?.[0].query).toBe("Isaac Levitan");
  });
});
