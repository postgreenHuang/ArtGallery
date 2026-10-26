import { describe, expect, it } from "vitest";
import { buildExploreIntent, structuredCriteria } from "./intent";

describe("intent preserves distinct art dimensions", () => {
  it("keeps portrait exclusion distinct from mood and color preferences", () => {
    const criteria = structuredCriteria({ required: ["乡间风景"], preferred: ["宁静", "冷色更好"],
      excluded: ["人物肖像"], requiresImage: true });
    expect(criteria).toMatchObject([
      { dimension: "subject", strength: "hard" },
      { dimension: "mood", strength: "soft", evidenceNeeded: "visual" },
      { dimension: "color", strength: "soft", evidenceNeeded: "visual" },
      { dimension: "object_type", operator: "exclude", strength: "hard" },
    ]);
  });
  it("versions a continuing search without replacing its session identity", () => {
    const first = buildExploreIntent({ request: "找风景画", query: "landscape", criteria: { required: ["风景"], preferred: ["冷色"], excluded: [], requiresImage: false } });
    const second = buildExploreIntent({ request: "更冷一些", query: "quiet landscape", previous: first,
      criteria: { required: ["风景"], preferred: ["冷色"], excluded: [], requiresImage: true } });
    expect(second.id).toBe(first.id);
    expect(second.revision).toBe(2);
    expect(second.criteria.find((item) => item.dimension === "subject")?.strength).toBe("hard");
    expect(second.criteria.find((item) => item.dimension === "color")?.strength).toBe("soft");
    expect(second.changes).toMatchObject({ added: [], removed: [], moved: [], queryChanged: true, artistChanged: false });
  });
  it("reports a direct tag revision without losing hard conditions", () => {
    const first = buildExploreIntent({ request: "找风景", criteria: { required: ["风景"], preferred: ["冷色"], excluded: ["肖像"], requiresImage: true } });
    const second = buildExploreIntent({ request: "调整", previous: first,
      criteria: { required: ["风景", "冷色"], preferred: ["安静"], excluded: [], requiresImage: true } });
    expect(second.changes).toMatchObject({ added: ["偏好：安静"], removed: ["排除：肖像"], moved: [{ value: "冷色", from: "偏好", to: "必须" }] });
  });
});
