import type { Artwork, CandidateReview, Library } from "../types";

const interruptedReview: CandidateReview = {
  verdict: "uncertain",
  reason: "应用在复核完成前关闭；候选已保留，尚未确认。",
  confidence: 0,
  basis: "unavailable",
  imageProvided: false,
  pageRead: false,
};

function workKey(art: Artwork): string {
  return art.recordKey || `${art.provider || "commons"}:${art.id}`;
}

export function recoverInterruptedReviews(library: Library): Library {
  let changed = false;
  const conversations = library.conversations.map((conversation) => ({
    ...conversation,
    messages: conversation.messages.map((message) => {
      if (!message.reviewPending && !message.pageReviewPending) return message;
      changed = true;
      if (message.reviewPending) return {
        ...message,
        reviewPending: false,
        reviewCompleted: false,
        pageReviewPending: false,
        pendingPageArtworks: undefined,
        text: "上次复核被应用退出打断。已找到的候选仍在下方，均标为待核实。",
        artworks: [...(message.artworks || []), ...(message.pendingPageArtworks || [])]
          .map((art) => ({ ...art, review: interruptedReview })),
        webResults: message.webResults?.map((item) => ({ ...item, review: interruptedReview })),
      };
      const existing = message.artworks || [];
      const keys = new Set(existing.map(workKey));
      const pending = (message.pendingPageArtworks || []).filter((art) => {
        const key = workKey(art);
        if (keys.has(key)) return false;
        keys.add(key);
        return true;
      });
      return {
        ...message,
        pageReviewPending: false,
        pendingPageArtworks: undefined,
        artworks: [...existing, ...pending.map((art) => ({ ...art, review: interruptedReview }))],
        searchWarning: [message.searchWarning, "上次分页复核被退出打断；新增候选保留为待核实。"].filter(Boolean).join(" "),
      };
    }),
  }));
  return changed ? { ...library, conversations } : library;
}
