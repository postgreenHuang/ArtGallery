import type { SearchCriteria } from "../types";

export type SearchMode = "exact" | "thematic" | "explore";
export type CriterionDimension = "artist" | "object_type" | "medium" | "subject" | "color" | "composition" | "mood" | "date" | "culture" | "style" | "other";
export interface Criterion {
  id: string;
  dimension: CriterionDimension;
  operator: "include" | "exclude";
  strength: "hard" | "soft";
  value: string;
  originalPhrase: string;
  evidenceNeeded: "metadata" | "visual" | "either";
}
export interface ExploreIntent {
  id: string;
  revision: number;
  mode: SearchMode;
  originalRequest: string;
  targetArtist?: string;
  criteria: Criterion[];
  anchorWorkKeys: string[];
  relation?: "composition" | "color" | "subject" | "medium" | "history" | "contrast";
}

export function classifyCriterion(value: string): Pick<Criterion, "dimension" | "evidenceNeeded"> {
  if (/肖像|portrait|版画|print|素描|drawing|绘画|painting|摄影|photo|书法|calligraphy/i.test(value))
    return { dimension: "object_type", evidenceNeeded: "either" };
  if (/油画|水彩|woodcut|etching|lithograph|媒材|技法|material|watercolor|oil paint|木刻|蚀刻|水墨/i.test(value))
    return { dimension: "medium", evidenceNeeded: "metadata" };
  if (/冷色|暖色|蓝色|红色|绿色|色彩|色调|饱和|颜色|color|colour|blue|red/i.test(value))
    return { dimension: "color", evidenceNeeded: "visual" };
  if (/构图|透视|视角|留白|composition|perspective/i.test(value))
    return { dimension: "composition", evidenceNeeded: "visual" };
  if (/安静|宁静|忧郁|怀旧|压迫|热烈|心情|氛围|mood|quiet|melanchol/i.test(value))
    return { dimension: "mood", evidenceNeeded: "visual" };
  if (/世纪|年代|时期|年间|century|year|\b\d{4}\b/i.test(value))
    return { dimension: "date", evidenceNeeded: "metadata" };
  if (/中国|日本|韩国|印度|非洲|欧洲|波斯|Chinese|Japanese|Korean|Indian|African|Persian/i.test(value))
    return { dimension: "culture", evidenceNeeded: "metadata" };
  if (/流派|印象派|抽象主义|巴洛克|style|impressionis|expressionis/i.test(value))
    return { dimension: "style", evidenceNeeded: "metadata" };
  if (/风景|山|海|花|园|街|路|人物|船|动物|landscape|mountain|sea|garden|road|figure|boat/i.test(value))
    return { dimension: "subject", evidenceNeeded: "either" };
  return { dimension: "other", evidenceNeeded: "either" };
}

export function structuredCriteria(criteria?: SearchCriteria): Criterion[] {
  if (!criteria) return [];
  return ([
    ["required", criteria.required, "include", "hard"],
    ["preferred", criteria.preferred, "include", "soft"],
    ["excluded", criteria.excluded, "exclude", "hard"],
  ] as const).flatMap(([group, values, operator, strength]) => values.map((originalPhrase, index) => ({
    id: `${group}-${index}`, ...classifyCriterion(originalPhrase), operator, strength,
    value: originalPhrase, originalPhrase,
  })));
}

export function buildExploreIntent(args: {
  request: string;
  targetArtist?: string;
  criteria?: SearchCriteria;
  previous?: ExploreIntent;
  anchorWorkKeys?: string[];
  relation?: ExploreIntent["relation"];
}): ExploreIntent {
  const { request, targetArtist, criteria, previous, anchorWorkKeys = [], relation } = args;
  return { id: previous?.id || crypto.randomUUID(), revision: (previous?.revision || 0) + 1,
    mode: targetArtist ? "exact" : anchorWorkKeys.length || relation ? "explore" : "thematic",
    originalRequest: request, targetArtist, criteria: structuredCriteria(criteria), anchorWorkKeys, relation };
}
