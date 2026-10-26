import type { SearchCriteria } from "../types";

export type CriteriaGroup = "required" | "preferred" | "excluded";
export const criteriaGroups: { key: CriteriaGroup; label: string }[] = [
  { key: "required", label: "必须" }, { key: "preferred", label: "偏好" }, { key: "excluded", label: "排除" },
];

export function normalizeIntentEdit(query: string, criteria: SearchCriteria): { query: string; criteria: SearchCriteria } {
  const cleanedQuery = query.trim().replace(/\s+/g, " ");
  if (!cleanedQuery || cleanedQuery.length > 160) throw new Error("检索词需为 1–160 个字符。");
  const next = { required: [] as string[], preferred: [] as string[], excluded: [] as string[], requiresImage: criteria.requiresImage };
  for (const { key } of criteriaGroups) {
    if (criteria[key].length > 8) throw new Error("每类条件最多 8 项。");
    const seen = new Set<string>();
    for (const raw of criteria[key]) {
      const value = raw.trim().replace(/\s+/g, " ");
      if (!value) continue;
      if (value.length > 80) throw new Error("单项条件最多 80 个字符。");
      if (seen.has(value.toLocaleLowerCase())) continue;
      seen.add(value.toLocaleLowerCase());
      next[key].push(value);
    }
  }
  const required = new Set(next.required.map((value) => value.toLocaleLowerCase()));
  if (next.excluded.some((value) => required.has(value.toLocaleLowerCase())))
    throw new Error("同一条件不能同时为“必须”和“排除”。");
  return { query: cleanedQuery, criteria: next };
}

export function describeIntentEdit(query: string, criteria: SearchCriteria): string {
  return `按“${query}”重新检索。以下条件替代上次条件：必须 ${criteria.required.join("、") || "无"}；偏好 ${criteria.preferred.join("、") || "无"}；排除 ${criteria.excluded.join("、") || "无"}。`;
}
