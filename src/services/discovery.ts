import type { Artwork, Settings } from "../types";
import { searchArt } from "./commons";

interface ArtistSeed {
  name: string;
  match: RegExp;
}

// One painter from each period keeps the discovery wall varied without
// making a large batch of requests to Wikimedia on every refresh.
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
  signal: AbortSignal,
): Promise<{ artworks: Artwork[]; artists: string[]; warning: string }> {
  const seeds = chooseDiscoveryArtists(previousArtists);
  const artworks: Artwork[] = [];
  const artists: string[] = [];
  let lastError: unknown;
  for (const seed of seeds) {
    if (signal.aborted) throw new DOMException("已停止", "AbortError");
    try {
      const result = await searchArt(seed.name, scope, 0, signal);
      const matches = result.artworks.filter((art) =>
        seed.match.test(`${art.artist} ${art.title} ${art.file}`),
      );
      const available = matches.filter(
        (art) =>
          !previousIds.includes(art.id) &&
          !artworks.some((a) => a.id === art.id),
      );
      const pool = available.length ? available : matches;
      if (pool.length) {
        artworks.push(pool[Math.floor(Math.random() * pool.length)]);
        artists.push(seed.name);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
      if (/429|请求过于频繁/.test(String(error))) break;
    }
  }
  if (!artworks.length && lastError) throw lastError;
  return {
    artworks,
    artists,
    warning:
      lastError && /429|请求过于频繁/.test(String(lastError))
        ? "Wikimedia 暂时限制查询，已展示这次找到的部分作品；请稍后再刷新。"
        : "",
  };
}
