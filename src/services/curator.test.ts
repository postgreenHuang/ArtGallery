import { beforeEach, describe, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./storage", () => ({ desktop: true }));
import { curatorHistory, referencedImages, parsePlan, parseCuratorReply, curateResults, planSearch, replyFromResults } from "./ai";
import { matchesArtist, searchAcrossProviders, searchForCurator } from "./artSearch";
import { normalizeMet, searchMet } from "./met";
import { normalizeWebResults, publicHttps } from "./webSearch";
import { defaultLibrary, type Artwork, type Message } from "../types";

const art = { id: 1, title: "Water lilies", artist: "Claude Monet", date: "1916", description: "Pond", source: "https://www.metmuseum.org/art/collection/search/1" } as Artwork;
const history: Message[] = [{ id: "a", role: "assistant", text: "搜索完成", query: "Monet", artworks: [art, { ...art, id: 2, title: "Garden", artist: "Other Artist" }], searchWarning: "部分来源不可用" }];
const met = { objectID: 1, isPublicDomain: true, title: "Garden", artistDisplayName: "Claude Monet", primaryImage: "https://images.metmuseum.org/CRDImages/ep/original/a.jpg", primaryImageSmall: "https://images.metmuseum.org/CRDImages/ep/web-large/a.jpg" };
beforeEach(() => { invoke.mockReset(); });

describe("curator grounded conversation", () => {
  it("ties concise selection reasons to actual IDs and rejects unseen visual claims", () => {
    const parsed = parseCuratorReply(JSON.stringify({ text: "结果说明", selectionReasons: [
      { id: 1, reason: "作者与指定姓名一致。", basis: "metadata" },
      { id: 999, reason: "不属于结果的作品", basis: "metadata" },
      { id: 2, reason: "画面冷色符合要求", basis: "image" },
    ] }), [art, { ...art, id: 2 }], [1]);
    expect(parsed.reasons).toEqual({ "1": "作者与指定姓名一致。" });
  });
  it("drops visual reasons when a model falls back to text and retains retrieval evidence in the request", async () => {
    const candidate = { ...art, thumb: "https://thumb.wikimedia.org/art.jpg", selectionReason: "作者字段匹配 Claude Monet" };
    invoke.mockRejectedValueOnce(new Error("HTTP 400 image unsupported")).mockResolvedValueOnce(JSON.stringify({ text: "按作者资料找到作品", selectionReasons: [{ id: 1, reason: "画面以蓝色为主", basis: "image" }] }));
    const result = await curateResults("蓝色风景", [], defaultLibrary.settings, new AbortController().signal, { query: "Monet", artworks: [candidate], warning: "" });
    expect(result.text).toContain("未读取图片");
    expect(result.reasons).toEqual({});
    expect(JSON.parse(invoke.mock.calls[1][1].messages.at(-1).content).currentSearch.results[0].selectionReason).toContain("作者字段匹配");
  });

  it("keeps the latest result group after many discussion turns, including an empty latest search", () => {
    const chat: Message[] = [...history, ...Array.from({ length: 12 }, (_, i) => ({ id: String(i), role: "user" as const, text: "继续解释" }))];
    const messages = curatorHistory(chat).map((m) => JSON.parse(m.content));
    expect(messages[0].latestDisplayedResults).toBe(true);
    expect(messages[0].results[1].title).toBe("Garden");
    chat.push({ id: "empty", role: "assistant", text: "没有找到", query: "Artem", artworks: [] });
    expect(curatorHistory(chat).map((m) => JSON.parse(m.content)).find((m) => m.latestDisplayedResults).results).toEqual([]);
  });
  it("attaches the referenced thumbnails and explicitly falls back for text-only models", async () => {
    const images = [art, { ...art, title: "Garden" }, { ...art, title: "Sunrise" }].map((a, i) => ({ ...a, thumb: `https://thumb.wikimedia.org/${i}.jpg` }));
    expect(referencedImages("比较第一张和第 3 幅", images).map((image) => image.number)).toEqual([1, 3]);
    invoke.mockRejectedValueOnce(new Error("HTTP 400 image unsupported")).mockResolvedValueOnce("依据资料回答");
    const answer = await replyFromResults("比较第一张和第3幅", [{ ...history[0], artworks: images }], defaultLibrary.settings, new AbortController().signal);
    const first = invoke.mock.calls[0][1].messages.at(-1).content;
    expect(first.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url)).toEqual([images[0].thumb, images[2].thumb]);
    expect(typeof invoke.mock.calls[1][1].messages.at(-1).content).toBe("string");
    expect(answer).toContain("未读取图片");
  });

  it("routes a question about displayed works to discussion and sends their actual metadata", async () => {
    invoke.mockResolvedValueOnce('{"action":"discuss","explanation":"解释第二张"}').mockResolvedValueOnce("第二张是 Other Artist 的 Garden。");
    const plan = await planSearch("第二张是谁画的？", history, { ...defaultLibrary.settings, useAi: true }, "", new AbortController().signal);
    expect(plan.action).toBe("discuss");
    const payload = invoke.mock.calls[0][1];
    expect(JSON.parse(payload.messages[1].content).results[1]).toMatchObject({ number: 2, title: "Garden", artist: "Other Artist" });
    expect(await replyFromResults("第二张是谁画的？", history, defaultLibrary.settings, new AbortController().signal)).toContain("Other Artist");
    expect(invoke.mock.calls.map((call) => call[0])).toEqual(["ai_plan", "ai_plan"]);
  });
  it("gives current results and source failures to the final answer instead of reusing the planning introduction", async () => {
    invoke.mockResolvedValue("当前来源没有匹配作者的作品。");
    await replyFromResults("Artem Rohovyi", history, defaultLibrary.settings, new AbortController().signal, { query: "Artem Rohovyi", targetArtist: "Artem Rohovyi", artworks: [], warning: "已排除 8 件作者不匹配的作品。" });
    const messages = invoke.mock.calls[0][1].messages;
    const payload = JSON.parse(messages.at(-1).content);
    expect(payload.currentSearch.results).toEqual([]);
    expect(payload.currentSearch.targetArtist).toBe("Artem Rohovyi");
    expect(payload.currentSearch.warning).toContain("已排除");
    expect(curatorHistory(history)[0].content).toContain("部分来源不可用");
  });
  it("respects a thematic plan instead of inventing an artist from capitalization", async () => {
    invoke.mockResolvedValue('{"action":"search","query":"blue flowers","targetArtist":"","explanation":"寻找蓝色花卉","recommendations":[]}');
    const plan = await planSearch("Blue Flowers", [], { ...defaultLibrary.settings, useAi: true }, "", new AbortController().signal);
    expect(plan.targetArtist).toBeUndefined();
    expect(plan.query).toBe("blue flowers");
  });
  it("retains structured artist constraints and aborts late answers", async () => {
    expect(parsePlan('{"query":"Artem Rohovyi","targetArtist":"Artem Rohovyi","artistAliases":["Artem Rogovoi",42],"explanation":"寻找本人作品"}')).toMatchObject({ targetArtist: "Artem Rohovyi", artistAliases: ["Artem Rogovoi"] });
    const controller = new AbortController();
    invoke.mockImplementation(async () => { controller.abort(); return "late"; });
    await expect(replyFromResults("继续", [], defaultLibrary.settings, controller.signal)).rejects.toThrow("已停止");
  });
});

describe("artist search precision and source isolation", () => {
  it("rejects names appearing only in titles and descriptions, without accepting same surname", () => {
    const constraints = { targetArtist: "Artem Rohovyi", artistAliases: ["Artem Rogovoi"] };
    expect(matchesArtist({ ...art, title: "Artem Rohovyi", description: "Artem Rohovyi" }, constraints)).toBe(false);
    expect(matchesArtist({ ...art, artist: "Other Rohovyi" }, constraints)).toBe(false);
    expect(matchesArtist({ ...art, artist: "Artem Rogovoi (Ukrainian)" }, constraints)).toBe(true);
    expect(matchesArtist({ ...art, artist: "Paul Cézanne" }, { targetArtist: "Paul Cezanne" })).toBe(true);
  });
  it("filters the screenshot's unrelated artists while keeping pagination for later matches", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "commons_query") return { query: { pages: [] } };
      if (cmd === "met_query") return { objectIDs: [], total: 0 };
      return { data: [{ id: 10, title: "La Grande Jatte", artist_display: "Georges Seurat", is_public_domain: true, image_id: "2d484387-2509-5e8e-2c43-22f9981972eb" }], config: { iiif_url: "https://www.artic.edu/iiif/2" }, pagination: { total: 20 } };
    });
    const result = await searchAcrossProviders("Artem Rohovyi", "commons", new AbortController().signal, undefined, { targetArtist: "Artem Rohovyi" });
    expect(result.artworks).toEqual([]);
    expect(result.warning).toContain("作者不匹配");
    expect(result.offsets.chicago).toBe(8);
  });
  it("keeps web clues if every museum fails and never presents web clues as verified artwork", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "web_image_search") return { results: [{ title: "Artem", url: "https://rohovyiart.com/", thumbnail: { src: "https://imgs.search.brave.com/a" } }] };
      return Promise.reject("offline");
    });
    const result = await searchForCurator("Artem Rohovyi", { ...defaultLibrary.settings, webSearch: true }, new AbortController().signal, { targetArtist: "Artem Rohovyi" });
    expect(result.artworks).toEqual([]);
    expect(result.webResults[0].url).toBe("https://rohovyiart.com/");
    expect(result.warning).toContain("馆藏搜索失败");
  });
  it("normalizes public Met images and uses paginated search with artist filtering", async () => {
    expect(normalizeMet(met)?.id).toBe(3_000_000_000_001);
    expect(normalizeMet({ ...met, isPublicDomain: false })).toBeNull();
    expect(normalizeMet({ ...met, primaryImage: "https://images.metmuseum.org.evil.test/a.jpg" })).toBeNull();
    invoke.mockResolvedValueOnce({ objectIDs: [1], total: 20 }).mockResolvedValueOnce(met);
    const result = await searchMet("Claude Monet", 8, new AbortController().signal, true);
    expect(invoke.mock.calls[0][1].path).toContain("offset=8");
    expect(invoke.mock.calls[0][1].path).toContain("artistOrCulture=true");
    expect(result.offset).toBe(16);
    expect(result.artworks[0].artist).toBe("Claude Monet");
  });
  it("deduplicates web pages and embeds only search proxy thumbnails", () => {
    const results = normalizeWebResults({ results: [
      { url: "https://artist.example/art", title: "Art", thumbnail: { src: "https://tracking.example/a.jpg" } },
      { url: "https://artist.example/art" }, { url: "javascript:alert(1)" }, { url: "https://127.0.0.1/a" },
    ] });
    expect(results).toHaveLength(1);
    expect(results[0].thumbnail).toBeUndefined();
    expect(publicHttps("https://user:secret@example.com/")).toBeUndefined();
  });
});
