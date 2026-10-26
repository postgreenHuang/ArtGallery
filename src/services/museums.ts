import { invoke } from "@tauri-apps/api/core";
import type { Artwork } from "../types";
import { desktop } from "./storage";
import { plain } from "./commons";
import { parseAttribution, providerFacet, providerFacets } from "../domain/artwork";

export type Museum = "cleveland" | "chicago";
const OFFSET = { cleveland: 1_000_000_000_000, chicago: 2_000_000_000_000 };
const hosts = { cleveland: "openaccess-cdn.clevelandart.org", chicago: "www.artic.edu" };
export const museumName = { cleveland: "克利夫兰艺术博物馆", chicago: "芝加哥艺术博物馆", met: "大都会艺术博物馆" };

export function museumId(museum: Museum, id: number): number | null {
  return Number.isSafeInteger(id) && id > 0 && id < 1_000_000_000_000
    ? OFFSET[museum] + id
    : null;
}

export function safeMuseumImage(url: string, museum: Museum): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === hosts[museum] &&
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash &&
      (museum === "chicago" ? /^\/iiif\/2\/[a-f0-9-]+\/full\/(?:600,|843,|1686,|full)\/0\/default\.jpg$/i.test(parsed.pathname)
        : /^\/[\w.-]+\/[\w.-]+_(?:web|print)\.jpg$/i.test(parsed.pathname));
  } catch {
    return false;
  }
}

interface ClevelandRecord {
  id: number;
  title?: string;
  creators?: { description?: string; role?: string }[];
  creation_date?: string;
  description?: string;
  technique?: string;
  creditline?: string;
  accession_number?: string;
  share_license_status?: string;
  type?: string;
  culture?: string | string[];
  images?: { web?: { url?: string; width?: number; height?: number }; print?: { url?: string; width?: number; height?: number } };
}
interface ChicagoRecord {
  id: number;
  title?: string;
  artist_display?: string;
  artist_title?: string;
  date_display?: string;
  description?: string;
  image_id?: string;
  is_public_domain?: boolean;
  credit_line?: string;
  thumbnail?: { width?: number; height?: number };
  medium_display?: string;
  classification_title?: string;
  style_titles?: string[];
  subject_titles?: string[];
}
export function normalizeCleveland(record: ClevelandRecord): Artwork | null {
  const id = museumId("cleveland", record.id);
  const thumb = record.images?.web?.url || "";
  const original = record.images?.print?.url || "";
  if (!id || record.share_license_status !== "CC0" || !safeMuseumImage(thumb, "cleveland") || !safeMuseumImage(original, "cleveland")) return null;
  const artist = record.creators?.find((creator) => creator.role === "artist")?.description || record.creators?.[0]?.description;
  const source = `https://www.clevelandart.org/art/${encodeURIComponent(record.accession_number || String(record.id))}`;
  const culture = Array.isArray(record.culture) ? record.culture.join("; ") : record.culture;
  return {
    id, provider: "cleveland", recordKey: `cleveland:${record.id}`, file: `CMA:${record.id}`,
    title: plain(record.title) || "未命名作品", artist: plain(artist) || "艺术家未标注",
    artistAttribution: parseAttribution(plain(artist) || "艺术家未标注", source),
    facets: { objectType: providerFacet(plain(record.type), source), medium: providerFacet(plain(record.technique), source), culture: providerFacet(plain(culture), source) },
    date: plain(record.creation_date) || "年代未标注",
    description: plain(record.description), thumb, medium: thumb, hd: original,
    original, source,
    width: Number(record.images?.print?.width) || 0, height: Number(record.images?.print?.height) || 0,
    license: "CC0 · 馆方高清 JPEG", licenseUrl: "https://www.clevelandart.org/open-access",
    attribution: `The Cleveland Museum of Art${record.creditline ? ` · ${plain(record.creditline)}` : ""}`,
  };
}

export function normalizeChicago(record: ChicagoRecord, iiifBase: string): Artwork | null {
  const id = museumId("chicago", record.id);
  if (!id || !record.is_public_domain || !/^[a-f0-9-]{36}$/i.test(record.image_id || "") || iiifBase !== "https://www.artic.edu/iiif/2") return null;
  const base = `${iiifBase}/${record.image_id}/full/`;
  const thumb = `${base}600,/0/default.jpg`;
  const medium = `${base}843,/0/default.jpg`;
  const hd = `${base}1686,/0/default.jpg`;
  const original = `${base}full/0/default.jpg`;
  const source = `https://www.artic.edu/artworks/${record.id}`;
  const artist = plain(record.artist_display || record.artist_title) || "艺术家未标注";
  return {
    id, provider: "chicago", recordKey: `chicago:${record.id}`, file: `AIC:${record.id}`,
    title: plain(record.title) || "未命名作品",
    artist, artistAttribution: parseAttribution(artist, source),
    facets: { objectType: providerFacet(plain(record.classification_title), source), medium: providerFacet(plain(record.medium_display), source),
      styles: providerFacets(record.style_titles?.map(plain), source), subjects: providerFacets(record.subject_titles?.map(plain), source) },
    date: plain(record.date_display) || "年代未标注",
    description: plain(record.description), thumb, medium, hd, original,
    source,
    width: Number(record.thumbnail?.width) || 0, height: Number(record.thumbnail?.height) || 0,
    license: "Public domain", licenseUrl: "https://www.artic.edu/image-licensing",
    attribution: `Art Institute of Chicago${record.credit_line ? ` · ${plain(record.credit_line)}` : ""}`,
  };
}

export function clevelandSearchParams(query: string, offset = 0, targetArtist?: string,
  filters: { type?: string; technique?: string } = {}): URLSearchParams {
  const params = new URLSearchParams({ q: query.slice(0, 160), skip: String(offset), limit: "8", has_image: "1" });
  params.set("cc0", "");
  if (targetArtist) params.set("artists", targetArtist.slice(0, 120));
  // Watercolor may be catalogued as a painting or a drawing. Keep that query broad.
  if (filters.type) params.set("type", filters.type);
  else if (/\b(?:woodcut|etching|lithograph|printmaking|prints?)\b|版画|木刻|蚀刻|石版画/i.test(query)) params.set("type", "Print");
  else if (/\b(?:drawings?|sketches?)\b|素描|速写/i.test(query)) params.set("type", "Drawing");
  if (filters.technique) params.set("technique", filters.technique);
  return params;
}

const cooldown = new Map<Museum, number>();
async function museumApi(museum: Museum, params: URLSearchParams, signal?: AbortSignal): Promise<unknown> {
  if ((cooldown.get(museum) || 0) > Date.now()) throw new Error(`${museumName[museum]}暂时限流，请稍后重试`);
  if (signal?.aborted) throw new DOMException("已停止", "AbortError");
  if (desktop) return invoke("museum_query", { provider: museum, query: params.toString() });
  const base = museum === "cleveland" ? "https://openaccess-api.clevelandart.org/api/artworks/" : "https://api.artic.edu/api/v1/artworks/search";
  const response = await fetch(`${base}?${params}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  if (response.status === 429) {
    const seconds = Math.max(60, Math.min(3600, Number(response.headers.get("Retry-After")) || 300));
    cooldown.set(museum, Date.now() + seconds * 1000);
    throw new Error(`${museumName[museum]}暂时限流（HTTP 429），请稍后重试`);
  }
  if (!response.ok) throw new Error(`${museumName[museum]}暂时不可用（HTTP ${response.status}）`);
  return response.json();
}

export async function searchMuseum(museum: Museum, query: string, offset = 0, signal?: AbortSignal, targetArtist?: string,
  filters: { type?: string; technique?: string } = {}): Promise<{ artworks: Artwork[]; offset?: number }> {
  const size = 8;
  if (museum === "cleveland") {
    const params = clevelandSearchParams(query, offset, targetArtist, filters);
    const result = await museumApi(museum, params, signal) as { info?: { total?: number }; data?: ClevelandRecord[] };
    const records = Array.isArray(result.data) ? result.data : [];
    return { artworks: records.map(normalizeCleveland).filter((art): art is Artwork => !!art), offset: offset + size < (result.info?.total || 0) ? offset + size : undefined };
  }
  const params = new URLSearchParams();
  params.set("q", query.slice(0, 160));
  params.set("page", String(Math.floor(offset / size) + 1));
  params.set("limit", String(size));
  params.set("query[term][is_public_domain]", "true");
  params.set("fields", "id,title,artist_display,artist_title,date_display,description,image_id,is_public_domain,credit_line,thumbnail,medium_display,classification_title,style_titles,subject_titles");
  const result = await museumApi(museum, params, signal) as { data?: ChicagoRecord[]; config?: { iiif_url?: string }; pagination?: { total?: number } };
  const records = Array.isArray(result.data) ? result.data : [];
  return { artworks: records.map((record) => normalizeChicago(record, result.config?.iiif_url || "")).filter((art): art is Artwork => !!art), offset: offset + size < (result.pagination?.total || 0) ? offset + size : undefined };
}
