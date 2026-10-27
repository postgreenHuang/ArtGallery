import type { Artwork, Settings } from "../types";
import { providers, searchProvider } from "./artSearch";

export interface DiscoveryTopic { key: string; label: string; query: string }

// Topics are query entry points, not an artist whitelist. Each source can return
// unfamiliar creators; groups keep a wall from collapsing into one subject.
export const discoveryTopics: DiscoveryTopic[][] = [
  [
    { key: "country-road", label: "乡间道路", query: "country road landscape" },
    { key: "seascape", label: "海上风景", query: "seascape" },
    { key: "mountains", label: "山峦与云", query: "mountain landscape" },
    { key: "river", label: "河畔", query: "river landscape" },
    { key: "garden", label: "庭园", query: "garden painting" },
    { key: "winter", label: "冬日风景", query: "winter landscape" },
  ],
  [
    { key: "reading", label: "阅读的人", query: "woman reading painting" },
    { key: "market", label: "市集", query: "market scene painting" },
    { key: "musicians", label: "音乐与人物", query: "musicians painting" },
    { key: "interior", label: "室内一隅", query: "interior painting" },
    { key: "workers", label: "劳作", query: "workers painting" },
    { key: "family", label: "家庭生活", query: "family painting" },
  ],
  [
    { key: "woodcut", label: "木刻", query: "woodcut landscape" },
    { key: "watercolor", label: "水彩", query: "watercolor landscape" },
    { key: "etching", label: "蚀刻版画", query: "etching landscape" },
    { key: "ink", label: "水墨", query: "ink landscape" },
    { key: "drawing", label: "纸上素描", query: "landscape drawing" },
    { key: "lithograph", label: "石版画", query: "lithograph landscape" },
  ],
  [
    { key: "japan", label: "日本风景版画", query: "Japanese landscape woodcut" },
    { key: "china", label: "中国山水", query: "Chinese ink landscape" },
    { key: "india", label: "印度细密画", query: "Indian miniature painting" },
    { key: "persia", label: "波斯细密画", query: "Persian miniature painting" },
    { key: "korea", label: "韩国水墨", query: "Korean ink painting" },
    { key: "west-africa", label: "西非艺术", query: "West African art painting" },
  ],
  [
    { key: "abstract", label: "抽象构成", query: "abstract composition" },
    { key: "still-life", label: "静物", query: "still life painting" },
    { key: "city-night", label: "城市夜景", query: "city night painting" },
    { key: "architecture", label: "建筑与空间", query: "architecture painting" },
    { key: "botanical", label: "植物", query: "botanical painting" },
    { key: "animal", label: "动物", query: "animal painting" },
  ],
];

export function chooseDiscoveryTopics(previous: string[] = [], random = Math.random): DiscoveryTopic[] {
  return discoveryTopics.map((options) => {
    const alternatives = options.filter((topic) => !previous.includes(topic.key));
    const pool = alternatives.length ? alternatives : options;
    return pool[Math.floor(random() * pool.length)];
  });
}

const artistKey = (art: Artwork) => art.artist.trim().toLocaleLowerCase();
const knownArtist = (art: Artwork) => !/^(?:|艺术家未标注|佚名|匿名|unknown|anonymous)$/i.test(artistKey(art));
const facetKey = (value?: string) => value?.trim().toLocaleLowerCase() || "";
const workKey = (art: Artwork) => knownArtist(art) && art.title.length > 5
  ? `${artistKey(art)}:${facetKey(art.title)}` : "";
export interface DiscoveryCoverage { newArtists: number; newCultures: number; newTypes: number; unknownCulture: number; unknownType: number }

export function rankDiscoveryCandidates(candidates: Artwork[], context: {
  selected: Artwork[]; seenIds: ReadonlySet<number>; seenArtists: ReadonlySet<string>;
  seenCultures: ReadonlySet<string>; seenTypes: ReadonlySet<string>; previousIds: readonly number[];
}): Artwork[] {
  const selectedWorks = new Set(context.selected.map(workKey).filter(Boolean));
  const selectedArtists = new Set(context.selected.filter(knownArtist).map(artistKey));
  const selectedSources = new Set(context.selected.map((art) => art.provider || "commons"));
  const selectedCultures = new Set(context.selected.map((art) => facetKey(art.facets?.culture?.value)).filter(Boolean));
  const selectedTypes = new Set(context.selected.map((art) => facetKey(art.facets?.objectType?.value)).filter(Boolean));
  return candidates.filter((art) => !context.selected.some((item) => item.id === art.id) &&
    (!workKey(art) || !selectedWorks.has(workKey(art)))).map((art) => {
      const culture = facetKey(art.facets?.culture?.value);
      const type = facetKey(art.facets?.objectType?.value);
      const artist = artistKey(art);
      const score = (context.seenIds.has(art.id) ? 0 : 100) +
        (context.previousIds.includes(art.id) ? 0 : 20) +
        (knownArtist(art) && !context.seenArtists.has(artist) ? 40 : 0) +
        (knownArtist(art) && !selectedArtists.has(artist) ? 25 : 0) +
        (!selectedSources.has(art.provider || "commons") ? 10 : 0) +
        (culture && !context.seenCultures.has(culture) && !selectedCultures.has(culture) ? 12 : 0) +
        (type && !context.seenTypes.has(type) && !selectedTypes.has(type) ? 8 : 0);
      return { art, score };
    }).sort((a, b) => b.score - a.score || a.art.id - b.art.id).map(({ art }) => art);
}

export function sourceOrderDiscoveryCandidates(candidates: Artwork[], selected: Artwork[]): Artwork[] {
  const ids = new Set(selected.map((art) => art.id));
  const works = new Set(selected.map(workKey).filter(Boolean));
  return candidates.filter((art) => !ids.has(art.id) && (!workKey(art) || !works.has(workKey(art))));
}

export function discoveryCoverage(artworks: Artwork[], seenArtists: ReadonlySet<string>, seenCultures: ReadonlySet<string>, seenTypes: ReadonlySet<string>): DiscoveryCoverage {
  const artists = new Set<string>(), cultures = new Set<string>(), types = new Set<string>();
  let unknownCulture = 0, unknownType = 0;
  for (const art of artworks) {
    if (knownArtist(art) && !seenArtists.has(artistKey(art))) artists.add(artistKey(art));
    const culture = facetKey(art.facets?.culture?.value), type = facetKey(art.facets?.objectType?.value);
    if (culture && !seenCultures.has(culture)) cultures.add(culture);
    if (type && !seenTypes.has(type)) types.add(type);
    if (!culture) unknownCulture++;
    if (!type) unknownType++;
  }
  return { newArtists: artists.size, newCultures: cultures.size, newTypes: types.size, unknownCulture, unknownType };
}
// Each topic gets at most one primary provider and one Commons fallback.
// This caps a five-topic refresh at ten searches even when museums are slow
// or empty, while still rotating the institution used for the first try.
export function discoveryProviderOrder(topicIndex: number): readonly [typeof providers[number], typeof providers[number]] {
  const primary = providers[topicIndex % providers.length];
  return primary === "commons" ? ["commons", "cleveland"] : [primary, "commons"];
}
export function discoveryRateLimited(error: unknown): boolean {
  return /(?:HTTP\s*)?429|限流|冷却|rate.?limit/i.test(String(error));
}
export async function discoverArt(
  scope: Settings["scope"], previousTopics: string[], previousIds: number[],
  seenIds: ReadonlySet<number>, offsets: Record<string, number>, signal: AbortSignal,
  seenArtists: ReadonlySet<string> = new Set(),
  seenCultures: ReadonlySet<string> = new Set(), seenTypes: ReadonlySet<string> = new Set(),
  rankNovelty = true,
): Promise<{ artworks: Artwork[]; artists: string[]; offsets: Record<string, number>; warning: string; coverage: DiscoveryCoverage; sourceCalls: number }> {
  const topics = chooseDiscoveryTopics(previousTopics);
  const artworks: Artwork[] = [];
  const nextOffsets = { ...offsets };
  let lastError: unknown;
  let sourceCalls = 0;
  const limitedProviders = new Set<string>();
  for (const [index, topic] of topics.entries()) {
    if (signal.aborted) throw new DOMException("已停止", "AbortError");
    let fallback: Artwork | undefined;
    let selected = false;
    for (const provider of discoveryProviderOrder(index)) {
      if (limitedProviders.has(provider)) continue;
      const key = `${provider}:${topic.key}`;
      if (offsets[key] === -1) continue;
      sourceCalls++;
      try {
        const result = await searchProvider(provider, topic.query, scope, offsets[key] || 0, signal);
        // An exhausted cursor stays exhausted across refreshes; 0 would replay page one.
        nextOffsets[key] = result.offset ?? -1;
        const ranked = rankNovelty
          ? rankDiscoveryCandidates(result.artworks, { selected: artworks, seenIds, seenArtists,
            seenCultures, seenTypes, previousIds })
          : sourceOrderDiscoveryCandidates(result.artworks, artworks);
        if (!rankNovelty && ranked[0]) {
          artworks.push({ ...ranked[0], selectionReason: `从“${topic.label}”主题按馆藏返回顺序展示；多样性排序已关闭。` });
          selected = true;
          break;
        }
        const novel = ranked.filter((art) => !seenIds.has(art.id) &&
          (!knownArtist(art) || !seenArtists.has(artistKey(art))) &&
          (!knownArtist(art) || !artworks.some((current) => artistKey(current) === artistKey(art))));
        const pick = novel[0];
        if (pick) {
          artworks.push({ ...pick, selectionReason: `从“${topic.label}”主题的馆藏结果中发现；具体关联可继续核对。` });
          selected = true;
          break;
        }
        const lessRecent = ranked.filter((art) => !previousIds.includes(art.id) &&
          (!knownArtist(art) || !artworks.some((current) => artistKey(current) === artistKey(art))));
        fallback ||= lessRecent[0] || ranked[0];
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
        if (discoveryRateLimited(error)) limitedProviders.add(provider);
      }
    }
    if (!selected && fallback) artworks.push({ ...fallback,
      selectionReason: `从“${topic.label}”主题重访；新候选暂未找到。` });
  }
  if (!artworks.length && lastError) throw lastError;
  return { artworks, artists: topics.map((topic) => topic.key), offsets: nextOffsets,
    coverage: discoveryCoverage(artworks, seenArtists, seenCultures, seenTypes),
    sourceCalls,
    warning: lastError && artworks.length < topics.length ? "部分馆藏暂时不可用，本组只展示已找到的作品。" : "" };
}
