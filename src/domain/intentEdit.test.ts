import { describe, expect, it } from "vitest";
import { describeIntentEdit, normalizeIntentEdit } from "./intentEdit";

describe("direct intent editing", () => {
  it("normalizes terms without changing their strengths", () => {
    const edited = normalizeIntentEdit("  garden   watercolor  ", { required: [" 水彩 ", "水彩"], preferred: ["安静"], excluded: ["肖像"], requiresImage: true });
    expect(edited).toEqual({ query: "garden watercolor", criteria: { required: ["水彩"], preferred: ["安静"], excluded: ["肖像"], requiresImage: true } });
    expect(describeIntentEdit(edited.query, edited.criteria)).toContain("以下条件替代上次条件");
  });
  it("rejects contradictory and oversized edits", () => {
    expect(() => normalizeIntentEdit("garden", { required: ["肖像"], preferred: [], excluded: ["肖像"], requiresImage: true })).toThrow("同时");
    expect(() => normalizeIntentEdit("", { required: [], preferred: [], excluded: [], requiresImage: false })).toThrow("检索词");
  });
});
