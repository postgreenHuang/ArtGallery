import type { SearchCriteria } from "../../types";
import { structuredCriteria, type Criterion } from "../../domain/intent";
import type { ArtProvider } from "../artSearch";

export interface SourceQueryPlan {
  provider: ArtProvider;
  filters: { type?: string; technique?: string; medium?: string };
  applied: string[];
  deferred: string[];
}

// These are metadata filters documented by the providers, not visual judgements.
export const sourceCapabilities: Record<ArtProvider, readonly string[]> = {
  commons: [],
  cleveland: ["type", "technique"],
  chicago: [],
  met: ["medium"],
};

function typeValue(value: string): string | undefined {
  if (/^(?:版画|prints?|printmaking)$/i.test(value.trim())) return "Print";
  if (/^(?:素描|速写|drawings?|sketches?)$/i.test(value.trim())) return "Drawing";
  if (/^(?:绘画|paintings?)$/i.test(value.trim())) return "Painting";
}

function mediumValue(value: string): string | undefined {
  const term = value.trim();
  if (/^(?:水彩|watercolou?r)$/i.test(term)) return "watercolor";
  if (/^(?:木刻|woodcut)$/i.test(term)) return "woodcut";
  if (/^(?:蚀刻|etching)$/i.test(term)) return "etching";
  if (/^(?:石版画|lithograph)$/i.test(term)) return "lithograph";
  if (/^(?:油画|oil painting)$/i.test(term)) return "oil";
}

export function compileSourceQuery(provider: ArtProvider, criteria?: SearchCriteria): SourceQueryPlan {
  const filters: SourceQueryPlan["filters"] = {};
  const applied: string[] = [];
  const deferred: string[] = [];
  const hard = structuredCriteria(criteria).filter((item) => item.operator === "include" && item.strength === "hard");
  const chosen = new Map<string, { value: string; items: Criterion[] }>();
  for (const item of hard) {
    const field = item.dimension === "object_type" && sourceCapabilities[provider].includes("type") ? "type"
      : item.dimension === "medium" && sourceCapabilities[provider].includes("technique") ? "technique"
      : item.dimension === "medium" && sourceCapabilities[provider].includes("medium") ? "medium" : undefined;
    const value = field === "type" ? typeValue(item.value) : field ? mediumValue(item.value) : undefined;
    if (!field || !value) { deferred.push(item.originalPhrase); continue; }
    const group = chosen.get(field);
    if (group) group.items.push(item);
    else chosen.set(field, { value, items: [item] });
  }
  for (const [field, group] of chosen) {
    // A single-value provider filter must not silently discard another hard condition.
    if (group.items.some((item) => (field === "type" ? typeValue(item.value) : mediumValue(item.value)) !== group.value)) {
      deferred.push(...group.items.map((item) => item.originalPhrase));
      continue;
    }
    filters[field as keyof typeof filters] = group.value;
    applied.push(...group.items.map((item) => item.originalPhrase));
  }
  deferred.push(...structuredCriteria(criteria).filter((item) => item.operator === "exclude" || item.strength === "soft")
    .map((item) => item.originalPhrase));
  return { provider, filters, applied, deferred };
}
