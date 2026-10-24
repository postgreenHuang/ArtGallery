import type { Artwork, Settings } from "../types";
import { providers, searchProvider } from "./artSearch";

interface ArtistSeed {
  name: string;
  match: RegExp;
}

// One painter from each period keeps the discovery wall varied.
const periods: ArtistSeed[][] = [
  [
    { name: "Claude Monet", match: /monet/i },
    { name: "Paul Cezanne", match: /c[eé]zanne/i },
    { name: "Berthe Morisot", match: /morisot/i },
  ],
  [
    { name: "Sandro Botticelli", match: /botticelli/i },
    { name: "Albrecht Durer", match: /d[uü]rer/i },
    { name: "Leonardo da Vinci", match: /leonardo|da vinci/i },
  ],
  [
    { name: "Rembrandt", match: /rembrandt/i },
    { name: "Johannes Vermeer", match: /vermeer/i },
    { name: "Diego Velazquez", match: /vel[aá]zquez/i },
  ],
  [
    { name: "Francisco Goya", match: /goya/i },
    { name: "Canaletto", match: /canaletto/i },
    { name: "Katsushika Hokusai", match: /hokusai|北斎|北斋/i },
  ],
  [
    { name: "Wassily Kandinsky", match: /kandinsky/i },
    { name: "Gustav Klimt", match: /klimt/i },
    { name: "Edvard Munch", match: /munch/i },
  ],
];

export function chooseDiscoveryArtists(previous: string[] = []): ArtistSeed[] {
  return periods.map((options, index) => {
    if (!previous.length && index === 0) return options[0];
    const alternatives = options.filter(
      (seed) => !previous.includes(seed.name),
    );
    const pool = alternatives.length ? alternatives : options;
    return pool[Math.floor(Math.random() * pool.length)];
  });
}

export async function discoverArt(
  scope: Settings["scope"],
  previousArtists: string[],
  previousIds: number[],
  seenIds: ReadonlySet<number>,
  offsets: Record<string, number>,
  signal: AbortSignal,
): Promise<{ artworks: Artwork[]; artists: string[]; offsets: Record<string, number>; warning: string }> {
  const seeds = chooseDiscoveryArtists(previousArtists);
  const artworks: Artwork[] = [];
  const artists: string[] = [];
  const nextOffsets = { ...offsets };
  let lastError: unknown;
  for (const [index, seed] of seeds.entries()) {
    if (signal.aborted) throw new DOMException("已停止", "AbortError");
    // Rotate the first choice between independent collections. If a source
    // is limited or has no matching painting, try another without hammering it.
    const order = [...providers.slice(index % providers.length), ...providers.slice(0, index % providers.length)];
    let fallback: Artwork | null = null;
    let selected = false;
    for (const provider of order) {
      const key = `${provider}:${seed.name}`;
      try {
        const result = await searchProvider(provider, seed.name, scope, offsets[key] || 0, signal);
        nextOffsets[key] = result.offset || 0;
        const matches = result.artworks.filter((art) =>
          seed.match.test(`${art.artist} ${art.title} ${art.file}`),
        );
        const unique = matches.filter((art) => !artworks.some((a) => a.id === art.id));
        const unseen = unique.filter((art) => !seenIds.has(art.id));
        const notPrevious = unique.filter((art) => !previousIds.includes(art.id));
        if (unseen.length) {
          artworks.push(unseen[Math.floor(Math.random() * unseen.length)]);
          artists.push(seed.name);
          selected = true;
          break;
        }
        const oldPool = notPrevious.length ? notPrevious : unique;
        if (!fallback && oldPool.length) fallback = oldPool[Math.floor(Math.random() * oldPool.length)];
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
      }
    }
    if (!selected && fallback) {
      artworks.push(fallback);
      artists.push(seed.name);
    }
  }
  if (!artworks.length && lastError) throw lastError;
  return {
    artworks,
    artists,
    offsets: nextOffsets,
    warning:
      lastError && artworks.length < seeds.length
        ? "部分馆藏暂时不可用，已展示这次找到的作品；请稍后再刷新。"
        : "",
  };
}
