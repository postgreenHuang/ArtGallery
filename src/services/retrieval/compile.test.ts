import { describe, expect, it } from "vitest";
import { compileSourceQuery } from "./compile";

const criteria = { required: ["版画", "水彩", "安静"], preferred: ["蓝色"], excluded: ["肖像"], requiresImage: true };

describe("source-specific query compilation", () => {
  it("uses only documented metadata filters and defers unsupported judgements", () => {
    const cleveland = compileSourceQuery("cleveland", criteria);
    expect(cleveland.filters).toEqual({ type: "Print", technique: "watercolor" });
    expect(cleveland.applied).toEqual(["版画", "水彩"]);
    expect(cleveland.deferred).toEqual(["安静", "蓝色", "肖像"]);
    expect(compileSourceQuery("met", criteria)).toMatchObject({ filters: { medium: "watercolor" }, applied: ["水彩"] });
    expect(compileSourceQuery("chicago", criteria).applied).toEqual([]);
    expect(compileSourceQuery("commons", criteria).deferred).toHaveLength(5);
  });
  it("does not choose one of conflicting hard filters", () => {
    const plan = compileSourceQuery("cleveland", { required: ["版画", "绘画"], preferred: [], excluded: [], requiresImage: true });
    expect(plan.filters).toEqual({});
    expect(plan.deferred).toEqual(["版画", "绘画"]);
  });
  it("does not treat a portrait subject as a museum object type", () => {
    const plan = compileSourceQuery("cleveland", { required: ["肖像"], preferred: [], excluded: [], requiresImage: true });
    expect(plan.filters).toEqual({});
    expect(plan.deferred).toEqual(["肖像"]);
  });
});
