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
export async function discoverArt(
  scope: Settings["scope"], previousTopics: string[], previousIds: number[],
  seenIds: ReadonlySet<number>, offsets: Record<string, number>, signal: AbortSignal,
  seenArtists: ReadonlySet<string> = new Set(),
): Promise<{ artworks: Artwork[]; artists: string[]; offsets: Record<string, number>; warning: string }> {
  const topics = chooseDiscoveryTopics(previousTopics);
  const artworks: Artwork[] = [];
  const nextOffsets = { ...offsets };
  let lastError: unknown;
  for (const [index, topic] of topics.entries()) {
    if (signal.aborted) throw new DOMException("已停止", "AbortError");
    const order = [...providers.slice(index % providers.length), ...providers.slice(0, index % providers.length)];
    const attempts = order.slice(0, 2);
    if (!attempts.includes("commons")) attempts.push("commons");
    let fallback: Artwork | undefined;
    let selected = false;
    for (const provider of attempts) {
      const key = `${provider}:${topic.key}`;
      try {
        const result = await searchProvider(provider, topic.query, scope, offsets[key] || 0, signal);
        nextOffsets[key] = result.offset ?? 0;
        const unique = result.artworks.filter((art) => !artworks.some((current) => current.id === art.id));
        const novel = unique.filter((art) => !seenIds.has(art.id) && !seenArtists.has(artistKey(art)) &&
          !artworks.some((current) => artistKey(current) === artistKey(art)));
        const pick = novel[Math.floor(Math.random() * novel.length)];
        if (pick) {
          artworks.push({ ...pick, selectionReason: `从“${topic.label}”主题的馆藏结果中发现；具体关联可继续核对。` });
          selected = true;
          break;
        }
        const lessRecent = unique.filter((art) => !previousIds.includes(art.id) &&
          !artworks.some((current) => artistKey(current) === artistKey(art)));
        fallback ||= lessRecent[0] || unique[0];
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
      }
    }
    if (!selected && fallback) artworks.push({ ...fallback,
      selectionReason: `从“${topic.label}”主题重访；新候选暂未找到。` });
  }
  if (!artworks.length && lastError) throw lastError;
  return { artworks, artists: topics.map((topic) => topic.key), offsets: nextOffsets,
    warning: lastError && artworks.length < topics.length ? "部分馆藏暂时不可用，本组只展示已找到的作品。" : "" };
}
