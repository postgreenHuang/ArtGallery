import { describe, expect, it } from "vitest";
import type { Artwork } from "../types";
import { planArtworkBranch } from "./exploreBranch";

const art = { title: "Quiet River", medium: "Oil on canvas", facets: { subjects: [{ value: "River", rawValue: "River", source: "museum", evidence: "provider" }] } } as Artwork;
describe("artwork exploration branches", () => {
  it("makes distinct plans without asserting unverified visual matches", () => {
    const composition = planArtworkBranch(art, "composition");
    const medium = planArtworkBranch(art, "medium");
    expect(composition.query).not.toBe(medium.query);
    expect(composition.criteria).toMatchObject({ required: ["River"], preferred: ["构图相近"], requiresImage: true });
    expect(medium.criteria.required).toEqual(["River", "版画"]);
    expect(composition.request).toContain("需要看图核实");
  });
  it("switches a print reference to paintings", () => {
    expect(planArtworkBranch({ ...art, medium: "woodcut" }, "medium").criteria.required).toContain("绘画");
  });
});
