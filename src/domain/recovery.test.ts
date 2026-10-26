import { describe, expect, it } from "vitest";
import type { Artwork, Library } from "../types";
import { defaultLibrary } from "../types";
import { recoverInterruptedReviews } from "./recovery";

const art = (id: number): Artwork => ({
  id, provider: "met", file: String(id), title: `Work ${id}`, artist: "Artist", date: "", description: "",
  thumb: "", original: "", source: "https://example.org", width: 0, height: 0,
  license: "", licenseUrl: "", attribution: "",
});
const withMessages = (messages: Library["conversations"][number]["messages"]): Library => ({
  ...defaultLibrary, saved: [{ artwork: art(9), savedAt: 1, local: "images/9-original.jpg" }],
  conversations: [{ id: "chat", title: "Search", updated: 1, messages }],
});

describe("interrupted review recovery", () => {
  it("keeps first-page candidates and web clues visible as uncertain", () => {
    const library = withMessages([{ id: "answer", role: "assistant", text: "正在复核", reviewPending: true,
      artworks: [art(1)], webResults: [{ title: "Exhibition", url: "https://example.org/art", description: "", source: "Web" }] }]);
    const recovered = recoverInterruptedReviews(library);
    const answer = recovered.conversations[0].messages[0];
    expect(answer.reviewPending).toBe(false);
    expect(answer.reviewCompleted).toBe(false);
    expect(answer.artworks?.[0].review?.verdict).toBe("uncertain");
    expect(answer.webResults?.[0].review?.verdict).toBe("uncertain");
    expect(recovered.saved).toEqual(library.saved);
    expect(library.conversations[0].messages[0].reviewPending).toBe(true);
  });

  it("appends only new pending-page works while preserving reviewed cards and order", () => {
    const kept = { ...art(1), review: { verdict: "keep" as const, reason: "Verified", confidence: 1,
      basis: "metadata" as const, imageProvided: false, pageRead: false } };
    const library = withMessages([{ id: "answer", role: "assistant", text: "Results", artworks: [kept],
      pageReviewPending: true, pendingPageArtworks: [art(1), art(2)] }]);
    const answer = recoverInterruptedReviews(library).conversations[0].messages[0];
    expect(answer.artworks?.map((item) => item.id)).toEqual([1, 2]);
    expect(answer.artworks?.[0].review?.verdict).toBe("keep");
    expect(answer.artworks?.[1].review?.verdict).toBe("uncertain");
    expect(answer.pendingPageArtworks).toBeUndefined();
    expect(answer.pageReviewPending).toBe(false);
  });

  it("leaves completed conversations unchanged", () => {
    const library = withMessages([{ id: "answer", role: "assistant", text: "Done", artworks: [art(1)] }]);
    expect(recoverInterruptedReviews(library)).toBe(library);
  });
});
