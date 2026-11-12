import type { Artwork, Settings } from "../types";

export interface FloatingArtworkPayload {
  art: Artwork;
  originalLocal?: string;
  theme: Settings["theme"];
}

export function floatingArtworkUrl(art: Artwork, originalLocal: string | undefined, theme: Settings["theme"]): string {
  const compact: FloatingArtworkPayload = { art: {
    id: art.id, provider: art.provider, file: art.file, title: art.title, artist: art.artist,
    date: art.date, description: "", thumb: art.thumb, medium: art.medium, hd: art.hd,
    original: art.original, source: art.source, width: art.width, height: art.height,
    license: art.license, licenseUrl: art.licenseUrl, attribution: art.attribution,
  }, originalLocal, theme };
  return `/?floatingArtwork=${encodeURIComponent(JSON.stringify(compact))}`;
}

export function parseFloatingArtworkPayload(raw: string | null): FloatingArtworkPayload | null {
  if (!raw || raw.length > 9000) return null;
  try {
    const value = JSON.parse(raw) as FloatingArtworkPayload;
    const art = value.art;
    if (!art || !Number.isSafeInteger(art.id) || art.id <= 0 || typeof art.title !== "string" ||
      art.title.length > 400 || typeof art.thumb !== "string" || typeof art.original !== "string") return null;
    const allowed = new Set(["upload.wikimedia.org", "thumb.wikimedia.org", "openaccess-cdn.clevelandart.org",
      "www.artic.edu", "images.metmuseum.org"]);
    for (const image of [art.thumb, art.medium, art.hd, art.original]) {
      if (!image) continue;
      const url = new URL(image);
      if (url.protocol !== "https:" || !allowed.has(url.hostname) || url.username || url.password) return null;
    }
    if (value.originalLocal !== undefined && (typeof value.originalLocal !== "string" || value.originalLocal.length > 500)) return null;
    if (!["light", "contrast", "warm", "dark", "system"].includes(value.theme)) return null;
    return value;
  } catch { return null; }
}
