import type { Artwork, SearchCriteria, Settings } from "../types";
import { searchArt } from "./commons";
import { searchMuseum, type Museum } from "./museums";
import { searchMet } from "./met";
import { searchWeb } from "./webSearch";
import { parseAttribution } from "../domain/artwork";
import { compileSourceQuery, type SourceQueryPlan } from "./retrieval/compile";

export type ArtProvider = "commons" | Museum | "met";
export type ProviderOffsets = Partial<Record<ArtProvider, number>>;
export const providers: ArtProvider[] = ["commons", "cleveland", "chicago", "met"];

export interface SearchConstraints {
  targetArtist?: string;
  artistAliases?: string[];
  providers?: readonly ArtProvider[];
  allowScopeFallback?: boolean;
  criteria?: SearchCriteria;
}
const nameTokens = (value: string): string[] => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}]+/gu) || [];
export function matchesArtist(art: Artwork, constraints: SearchConstraints): boolean {
  if (!constraints.targetArtist) return true;
  // Match the author field only: descriptions and filenames can mention other artists.
  const attribution = art.artistAttribution || parseAttribution(art.artist, art.source);
  if (attribution.kind !== "by") return false;
  const author = nameTokens(attribution.name);
  return [constraints.targetArtist, ...(constraints.artistAliases || [])].some((name) => {
    const tokens = nameTokens(name);
    return tokens.length > 0 && tokens.every((token) => author.includes(token));
  });
}

export function searchProvider(provider: ArtProvider, query: string, scope: Settings["scope"], offset = 0, signal?: AbortSignal, artistOnly = false,
  plan: SourceQueryPlan = compileSourceQuery(provider), targetArtist?: string) {
  return provider === "commons"
    ? searchArt(query, scope, offset, signal)
    : provider === "met" ? searchMet(query, offset, signal, artistOnly, plan.filters.medium)
    : searchMuseum(provider, query, offset, signal, artistOnly ? targetArtist || query : undefined, plan.filters);
}

export async function searchAcrossProviders(
  query: string,
  scope: Settings["scope"],
  signal: AbortSignal,
  offsets?: ProviderOffsets,
  constraints: SearchConstraints = {},
): Promise<{ artworks: Artwork[]; offsets: ProviderOffsets; warning: string; sourceQueries: SourceQueryPlan[] }> {
  const selected = providers.filter((provider) => (!constraints.providers || constraints.providers.includes(provider)) &&
    (!offsets || offsets[provider] !== undefined));
  const sourceQueries = selected.map((provider) => compileSourceQuery(provider, constraints.criteria));
  const results = await Promise.allSettled(selected.map((provider, index) =>
    searchProvider(provider, query, scope, offsets?.[provider] || 0, signal, !!constraints.targetArtist,
      sourceQueries[index], constraints.targetArtist),
  ));
  if (signal.aborted) throw new DOMException("已停止", "AbortError");
  const next: ProviderOffsets = {};
  const groups: Artwork[][] = [];
  const errors: string[] = [];
  results.forEach((result, index) => {
    const provider = selected[index];
    if (result.status === "fulfilled") {
      groups.push(result.value.artworks);
      if (result.value.offset !== undefined) next[provider] = result.value.offset;
    } else {
      groups.push([]);
      errors.push(`${provider}: ${String(result.reason)}`);
      // Keep the cursor so a temporarily limited source can be retried later.
      if (offsets?.[provider] !== undefined) next[provider] = offsets[provider];
    }
  });
  const artworks: Artwork[] = [];
  for (let index = 0; groups.some((group) => index < group.length); index++)
    for (const group of groups) if (group[index]) artworks.push(group[index]);
  if (!artworks.length && errors.length) throw new Error(`开放馆藏暂时不可用：${errors.join("；")}`);
  const matched = artworks.filter((art) => matchesArtist(art, constraints));
  const rejected = artworks.length - matched.length;
  return { artworks: matched.map((art) => ({ ...art,
    selectionReason: constraints.targetArtist
      ? `作者字段匹配“${constraints.targetArtist.slice(0, 50)}”。`
      : `馆藏按“${query.slice(0, 40)}”返回的候选，相关性待核实。`,
  })), offsets: next, sourceQueries, warning: [errors.length ? "部分馆藏暂不可用，本次结果可能不完整。" : "", rejected ? `已排除 ${rejected} 件作者不匹配的作品。` : ""].filter(Boolean).join(" ") };
}

export async function searchForCurator(query: string, settings: Settings, signal: AbortSignal, constraints: SearchConstraints = {}) {
  const warnings: string[] = [];
  const [collection, web] = await Promise.allSettled([
    (async () => {
      let found = await searchAcrossProviders(query, settings.scope, signal, undefined, constraints);
      if (!found.artworks.length && settings.scope === "google" && constraints.allowScopeFallback !== false) {
        const broad = await searchAcrossProviders(query, "commons", signal, undefined, constraints);
        found = { ...broad, warning: [found.warning, broad.warning, "本次已扩大到全部 Wikimedia Commons。"].filter(Boolean).join(" ") };
        return { ...found, scope: "commons" as const };
      }
      return { ...found, scope: settings.scope };
    })(),
    settings.webSearch ? searchWeb(query, signal) : Promise.resolve([]),
  ]);
  if (signal.aborted) throw new DOMException("已停止", "AbortError");
  if (collection.status === "rejected") warnings.push(`馆藏搜索失败：${String(collection.reason)}`);
  else if (collection.value.warning) warnings.push(collection.value.warning);
  if (web.status === "rejected") warnings.push(`全网搜图失败：${String(web.reason)}`);
  return { artworks: collection.status === "fulfilled" ? collection.value.artworks : [],
    offsets: collection.status === "fulfilled" ? collection.value.offsets : {},
    scope: collection.status === "fulfilled" ? collection.value.scope : settings.scope,
    sourceQueries: collection.status === "fulfilled" ? collection.value.sourceQueries : [],
    webResults: web.status === "fulfilled" ? web.value.map((item) => ({ ...item, selectionReason: `按“${query.slice(0, 40)}”搜到的网页线索，作者待核实。` })) : [], warning: warnings.join(" "),
    failed: (collection.status === "rejected" || web.status === "rejected") &&
      (collection.status !== "fulfilled" || !collection.value.artworks.length) &&
      (web.status !== "fulfilled" || !web.value.length),
  };
}
