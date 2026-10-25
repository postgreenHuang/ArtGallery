import type { Artwork } from "../types";

export type SourceProvider = "commons" | "cleveland" | "chicago" | "met";
export type AttributionKind = "by" | "attributed_to" | "workshop" | "follower" | "after" | "unknown";
export type EvidenceKind = "provider" | "page" | "visual" | "user";
export type Relevance = "supports" | "contradicts" | "unknown";

export interface ArtworkFacet {
  value: string;
  rawValue: string;
  source: string;
  language?: string;
  evidence: EvidenceKind;
}
export interface ArtworkFacets {
  objectType?: ArtworkFacet;
  medium?: ArtworkFacet;
  techniques?: ArtworkFacet[];
  subjects?: ArtworkFacet[];
  styles?: ArtworkFacet[];
  culture?: ArtworkFacet;
  dateStart?: number;
  dateEnd?: number;
}
export interface ArtistAttribution {
  name: string;
  raw: string;
  kind: AttributionKind;
  entityId?: string;
  source: string;
}
export interface ImageAsset {
  assetKey: string;
  role: "thumbnail" | "preview" | "high" | "original";
  url: string;
  width?: number;
  height?: number;
  rights?: string;
  source: string;
}
export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  source: string;
  quote?: string;
  fetchedAt?: number;
  objectKey?: string;
}
export interface CriterionAssessment {
  criterionId: string;
  verdict: Relevance;
  evidenceIds: string[];
  reason: string;
}
export interface WorkRecord {
  recordKey: string;
  provider: SourceProvider;
  providerId: string;
  title: string;
  attribution: ArtistAttribution;
  facets: ArtworkFacets;
  assets: ImageAsset[];
  source: string;
}

const qualified = [
  { kind: "attributed_to", pattern: /^(?:attributed to|attribution to|归于|传为)\s*[:：]?\s*/i },
  { kind: "workshop", pattern: /^(?:workshop of|studio of|工作室)\s*[:：]?\s*/i },
  { kind: "follower", pattern: /^(?:follower of|circle of|追随者|门人)\s*[:：]?\s*/i },
  { kind: "after", pattern: /^(?:after|copy after|based on|仿|摹)\s*[:：]?\s*/i },
] as const;

export function parseAttribution(raw: string, source: string): ArtistAttribution {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || /^(?:艺术家未标注|unknown|unidentified|anonymous|佚名)$/i.test(text))
    return { name: text || "艺术家未标注", raw, kind: "unknown", source };
  for (const item of qualified) {
    if (item.pattern.test(text)) return {
      name: text.replace(item.pattern, "").trim() || text,
      raw, kind: item.kind, source,
    };
  }
  return { name: text, raw, kind: "by", source };
}

export function artworkRecordKey(art: Pick<Artwork, "id" | "provider">): string {
  if (art.provider === "cleveland") return `cleveland:${art.id - 1_000_000_000_000}`;
  if (art.provider === "chicago") return `chicago:${art.id - 2_000_000_000_000}`;
  if (art.provider === "met") return `met:${art.id - 3_000_000_000_000}`;
  return `commons:${art.id}`;
}

export function legacyWorkRecord(art: Artwork): WorkRecord {
  const recordKey = art.recordKey || artworkRecordKey(art);
  const [provider, ...id] = recordKey.split(":");
  const assets: ImageAsset[] = [];
  for (const [role, url] of [["thumbnail", art.thumb], ["preview", art.medium], ["high", art.hd], ["original", art.original]] as const) {
    if (url && !assets.some((asset) => asset.url === url)) assets.push({ assetKey: `${recordKey}:${role}`, role, url, source: art.source });
  }
  return { recordKey, provider: provider as SourceProvider, providerId: id.join(":"), title: art.title,
    attribution: art.artistAttribution || parseAttribution(art.artist, art.source), facets: art.facets || {},
    assets: art.assets || assets, source: art.source };
}

export function providerFacet(value: string | undefined, source: string): ArtworkFacet | undefined {
  const rawValue = value?.replace(/\s+/g, " ").trim();
  return rawValue ? { value: rawValue, rawValue, source, evidence: "provider" } : undefined;
}

export function providerFacets(values: (string | undefined)[] | undefined, source: string): ArtworkFacet[] {
  return (values || []).flatMap((value) => {
    const facet = providerFacet(value, source);
    return facet ? [facet] : [];
  });
}
