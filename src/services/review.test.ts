import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Artwork, Message, WebResult } from "../types";
import { defaultLibrary } from "../types";
import { parseReview, reviewCandidates, type ReviewCandidate } from "./review";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./storage", () => ({ desktop: true }));
vi.mock("./pageEvidence", () => ({ enrichSources: vi.fn(async (artworks, webResults) => ({ artworks, webResults })) }));

const candidate = (key = "art:1"): ReviewCandidate => ({
  key, title: "Self-Portrait", artist: "Claude Monet", date: "1916",
  description: "Portrait of the artist", source: "https://museum.example/work/1",
  thumbnail: "https://thumb.wikimedia.org/example.jpg",
});
const decision = (key: string, overrides: Record<string, unknown> = {}) => ({
  key, verdict: "reject", reason: "自画像不符合排除肖像的要求", confidence: 0.95,
  basis: "metadata", quote: "Self-Portrait",
  assessments: [{ criterionId: "excluded-0", verdict: "contradicts", reason: "明确为肖像" }], ...overrides,
});
const response = (...items: unknown[]) => JSON.stringify({ decisions: items });
const criteria = { required: ["风景"], preferred: ["冷色"], excluded: ["肖像"], requiresImage: true };
beforeEach(() => { invoke.mockReset(); });

describe("grounded per-candidate review", () => {
  it("rejects a clear contradiction in metadata and keeps an audit quote", () => {
    const result = parseReview(response(decision("art:1")), [candidate()], new Set(), criteria).get("art:1");
    expect(result).toMatchObject({ verdict: "reject", basis: "metadata", quote: "Self-Portrait", imageProvided: false });
  });
  it("does not turn a missing or duplicate decision into a silent removal", () => {
    expect(parseReview(response(), [candidate()], new Set()).get("art:1")?.verdict).toBe("uncertain");
    expect(parseReview(response(decision("art:1"), decision("art:1")), [candidate()], new Set()).get("art:1")?.verdict).toBe("uncertain");
    expect(() => parseReview(response(decision("art:1"), decision("art:forged")), [candidate()], new Set())).toThrow("不属于当前批次");
  });
  it("requires a real textual quote, sufficient confidence, and an attached image for visual claims", () => {
    expect(parseReview(response(decision("art:1", { quote: "imaginary source" })), [candidate()], new Set()).get("art:1")?.verdict).toBe("uncertain");
    expect(parseReview(response(decision("art:1", { confidence: 0.6 })), [candidate()], new Set()).get("art:1")?.verdict).toBe("uncertain");
    expect(parseReview(response(decision("art:1", { basis: "image", quote: "" })), [candidate()], new Set()).get("art:1")?.verdict).toBe("uncertain");
    expect(parseReview(response(decision("art:1", { basis: "image", quote: "" })), [candidate()], new Set(["art:1"])).get("art:1")?.verdict).toBe("reject");
  });
  it("uses webpage text only when it is actually about the web hit", () => {
    const web = { ...candidate("web:0"), title: "Monet Water Lilies", page: {
      status: "read" as const, url: "https://gallery.example/list", title: "Gallery",
      text: `Monet Water Lilies painted in blue. ${"Other artworks. ".repeat(80)} Self-Portrait by a different painter.`,
    } };
    const result = parseReview(response(decision("web:0", { basis: "page", quote: "Self-Portrait" })), [web], new Set());
    expect(result.get("web:0")?.verdict).toBe("uncertain");
    const supported = { ...web, page: { ...web.page, text: "Monet Water Lilies — a portrait, not a landscape." } };
    expect(parseReview(response(decision("web:0", { basis: "page", quote: "a portrait" })), [supported], new Set()).get("web:0")?.verdict).toBe("reject");
  });
  it("will not borrow a quote from a different artwork block on the same page", () => {
    const web = { ...candidate("web:0"), title: "Quiet River", page: {
      status: "read" as const, url: "https://gallery.example/list", title: "Exhibition",
      text: "Quiet River is blue. Red Portrait depicts a person.",
      blocks: [
        { title: "Quiet River", text: "Quiet River is blue.", imageUrls: [] },
        { title: "Red Portrait", text: "Red Portrait depicts a person.", imageUrls: [] },
      ],
    } };
    expect(parseReview(response(decision("web:0", { basis: "page", quote: "depicts a person" })), [web], new Set()).get("web:0")?.verdict).toBe("uncertain");
  });
  it("does not confirm image-dependent matches from text alone", () => {
    const result = parseReview(response(decision("art:1", { verdict: "keep" })), [candidate()], new Set(), criteria);
    expect(result.get("art:1")?.verdict).toBe("uncertain");
  });
  it("does not reject a candidate merely because a soft preference is unmet", () => {
    const softOnly = { required: [], preferred: ["冷色"], excluded: [], requiresImage: false };
    const judged = decision("art:1", { assessments: [{ criterionId: "preferred-0", verdict: "contradicts", reason: "暖色" }] });
    const result = parseReview(response(judged), [candidate()], new Set(), softOnly).get("art:1");
    expect(result?.verdict).toBe("uncertain");
    expect(result?.assessments?.[0].criterionId).toBe("preferred-0");
  });
});

describe("review batch recovery", () => {
  const artwork = (id: number): Artwork => ({ id, file: String(id), title: `Painting ${id}`, artist: "Artist",
    date: "1900", description: "Landscape", thumb: "", original: "", source: `https://museum.example/${id}`,
    width: 1, height: 1, license: "Public domain", licenseUrl: "", attribution: "" });
  it("keeps failed batches uncertain while applying supported decisions from other batches", async () => {
    invoke.mockImplementation(async (...call) => {
      const args = call[1];
      const payload = JSON.parse(args.messages.at(-1).content);
      if (payload.candidates.some((item: ReviewCandidate) => item.key === "art:7")) throw new Error("fixture model outage");
      return response(...payload.candidates.map((item: ReviewCandidate) => decision(item.key, { quote: item.title })));
    });
    const result = await reviewCandidates("不要肖像", [] as Message[], { query: "art", explanation: "search" },
      Array.from({ length: 7 }, (_, index) => artwork(index + 1)), [] as WebResult[], defaultLibrary.settings, new AbortController().signal);
    expect(result.rejectedArtworks).toHaveLength(6);
    expect(result.artworks).toHaveLength(1);
    expect(result.artworks[0].review?.verdict).toBe("uncertain");
    expect(result.warning).toContain("部分 AI 复核失败");
  });
  it("does not publish late model decisions after cancellation", async () => {
    const controller = new AbortController();
    invoke.mockImplementation(async () => { controller.abort(); return response(decision("art:1")); });
    await expect(reviewCandidates("不要肖像", [], { query: "art", explanation: "search" },
      [artwork(1)], [], defaultLibrary.settings, controller.signal)).rejects.toThrow("已停止");
  });
});
