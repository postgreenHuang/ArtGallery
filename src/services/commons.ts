import { invoke } from "@tauri-apps/api/core";
import { desktop } from "./storage";
import type { Artwork } from "../types";
import { parseAttribution, providerFacet } from "../domain/artwork";
type Meta = Record<string, { value?: string }>;
interface Page {
  pageid: number;
  title: string;
  index?: number;
  imageinfo?: {
    url: string;
    thumburl?: string;
    descriptionurl: string;
    width: number;
    height: number;
    mime: string;
    extmetadata?: Meta;
  }[];
}
export function plain(value = ""): string {
  // Commons metadata is untrusted HTML; never insert it into the DOM as HTML.
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(value, "text/html");
    doc
      .querySelectorAll(
        'script,style,.noprint,[style*="display: none"],[style*="display:none"]',
      )
      .forEach((node) => node.remove());
    return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
  }
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(
      /&(?:nbsp|amp|quot|lt|gt|#39);/g,
      (s) =>
        ({
          "&nbsp;": " ",
          "&amp;": "&",
          "&quot;": '"',
          "&lt;": "<",
          "&gt;": ">",
          "&#39;": "'",
        })[s] || s,
    )
    .replace(/\s+/g, " ")
    .trim();
}
export function safeImage(url: string) {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      ["upload.wikimedia.org", "thumb.wikimedia.org"].includes(u.hostname) &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
export function normalize(page: Page): Artwork | null {
  const i = page.imageinfo?.[0];
  if (
    !i ||
    !i.thumburl ||
    !safeImage(i.thumburl) ||
    !safeImage(i.url) ||
    !/^image\/(jpeg|png|webp)$/.test(i.mime)
  )
    return null;
  const m = i.extmetadata || {};
  const field = (key: string) => plain(m[key]?.value);
  const artist = field("Artist") || "艺术家未标注";
  const source = `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`;
  return {
    id: page.pageid,
    recordKey: `commons:${page.pageid}`,
    file: page.title,
    title:
      field("ObjectName") ||
      page.title.replace(/^File:/, "").replace(/\.[^.]+$/, ""),
    artist,
    artistAttribution: parseAttribution(artist, source),
    facets: { medium: providerFacet(field("Medium"), source) },
    date: field("DateTimeOriginal") || "年代未标注",
    description: field("ImageDescription"),
    thumb: i.thumburl,
    original: i.url,
    source,
    width: i.width,
    height: i.height,
    license: field("LicenseShortName") || "授权待核实",
    licenseUrl: /^https:\/\//.test(m.LicenseUrl?.value || "")
      ? m.LicenseUrl!.value!
      : "",
    attribution: field("Attribution") || field("Credit"),
  };
}
async function api(params: Record<string, string>, signal?: AbortSignal) {
  const query = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    origin: "*",
    ...params,
  }).toString();
  let data;
  if (desktop)
    data = await invoke<Record<string, unknown>>("commons_query", { query });
  else {
    const response = await fetch(
      `https://commons.wikimedia.org/w/api.php?${query}`,
      {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
      },
    );
    if (!response.ok)
      throw new Error(`Wikimedia 暂时不可用 (${response.status})`);
    data = await response.json();
  }
  if (signal?.aborted) throw new DOMException("已停止", "AbortError");
  if (data.error)
    throw new Error(`Wikimedia: ${(data.error as { info: string }).info}`);
  return data as {
    query?: { pages?: Page[] };
    continue?: { gsroffset?: number };
    warnings?: unknown;
  };
}
export function buildSearch(query: string, scope: "google" | "commons") {
  const clean = query.replace(/[\r\n]/g, " ").slice(0, 220);
  // Google Art Project contains nested categories. Search its file metadata instead of only direct members.
  return `${clean} ${scope === "google" ? '"Google Art Project"' : ""} filetype:bitmap`.trim();
}
export async function searchArt(
  query: string,
  scope: "google" | "commons",
  offset = 0,
  signal?: AbortSignal,
) {
  const data = await api(
    {
      generator: "search",
      gsrsearch: buildSearch(query, scope),
      gsrnamespace: "6",
      gsrlimit: "12",
      gsroffset: String(offset),
      prop: "imageinfo",
      iiprop: "url|size|mime|extmetadata",
      iiurlwidth: "640",
      iiurlheight: "640",
    },
    signal,
  );
  const artworks = (data.query?.pages || [])
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map(normalize)
    .filter((a): a is Artwork => !!a);
  return { artworks, offset: data.continue?.gsroffset };
}
export async function sizedImage(art: Artwork, maxEdge: 1280 | 2400) {
  if (art.provider) return maxEdge === 1280 ? art.medium || art.thumb : art.hd || art.original;
  const data = await api({
    pageids: String(art.id),
    prop: "imageinfo",
    iiprop: "url",
    iiurlwidth: String(maxEdge),
    iiurlheight: String(maxEdge),
  });
  const url = data.query?.pages?.[0]?.imageinfo?.[0]?.thumburl;
  if (!url || !safeImage(url)) throw new Error("暂时无法获取高清版本");
  return url;
}
export const highResolution = (art: Artwork) => sizedImage(art, 2400);
