import { invoke } from "@tauri-apps/api/core";
import { desktop } from "./storage";
import type { Artwork } from "../types";
import { plain } from "./commons";
import { parseAttribution, providerFacet, providerFacets } from "../domain/artwork";

interface MetRecord {
  objectID: number;
  isPublicDomain?: boolean;
  title?: string;
  artistDisplayName?: string;
  objectDate?: string;
  medium?: string;
  classification?: string;
  culture?: string;
  tags?: { term?: string }[];
  primaryImage?: string;
  primaryImageSmall?: string;
  creditLine?: string;
}
interface MetSearch { total?: number; objectIDs?: number[] }
async function metApi<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException("已停止", "AbortError");
  if (desktop) return invoke("met_query", { path });
  const response = await fetch(`https://collectionapi.metmuseum.org/public/collection/${path}`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`大都会馆藏暂不可用（HTTP ${response.status}）`);
  return response.json();
}
function metImage(value: unknown): value is string {
  try { const url = new URL(String(value)); return url.protocol === "https:" && url.hostname === "images.metmuseum.org" && !url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname.startsWith("/CRDImages/") && /\.jpe?g$/i.test(url.pathname); }
  catch { return false; }
}
export function normalizeMet(record: MetRecord | null): Artwork | null {
  if (!record || !Number.isSafeInteger(record.objectID) || record.objectID <= 0 || record.objectID >= 1_000_000_000_000 || !record.isPublicDomain ||
    (record.primaryImage && !metImage(record.primaryImage)) || (record.primaryImageSmall && !metImage(record.primaryImageSmall))) return null;
  const source = `https://www.metmuseum.org/art/collection/search/${record.objectID}`;
  const artist = plain(record.artistDisplayName) || "艺术家未标注";
  return { id: 3_000_000_000_000 + record.objectID, provider: "met", recordKey: `met:${record.objectID}`, file: `MET:${record.objectID}`,
    title: plain(record.title) || "未命名作品", artist, artistAttribution: parseAttribution(artist, source),
    date: plain(record.objectDate) || "年代未标注", description: plain(record.medium),
    facets: { objectType: providerFacet(plain(record.classification), source), medium: providerFacet(plain(record.medium), source),
      culture: providerFacet(plain(record.culture), source), subjects: providerFacets(record.tags?.map((tag) => plain(tag.term)), source) },
    thumb: record.primaryImageSmall || record.primaryImage || "", medium: record.primaryImageSmall || record.primaryImage || "", hd: record.primaryImage || "",
    original: record.primaryImage || "", source,
    width: 0, height: 0, license: "Public domain", licenseUrl: "https://www.metmuseum.org/policies/image-resources",
    attribution: `The Metropolitan Museum of Art · ${plain(record.creditLine)}` };
}
export async function searchMet(query: string, offset = 0, signal?: AbortSignal, artistOnly = false, medium?: string) {
  const params = new URLSearchParams({ q: query.slice(0, 160), offset: String(offset), limit: "8" });
  if (!artistOnly) params.set("hasImages", "true");
  if (artistOnly) params.set("artistOrCulture", "true");
  if (medium) params.set("medium", medium);
  const search = await metApi<MetSearch>(`v1.1/search?${params}`, signal);
  const ids = Array.isArray(search.objectIDs) ? search.objectIDs.filter((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0).slice(0, 8) : [];
  const results = await Promise.allSettled(ids.map(async (id: number) => normalizeMet(await metApi<MetRecord>(`v1/objects/${id}`, signal))));
  if (signal?.aborted) throw new DOMException("已停止", "AbortError");
  if (ids.length && results.every((r) => r.status === "rejected")) {
    const limited = results.find((result) => result.status === "rejected" && /429|限流|受限/i.test(String(result.reason)));
    throw Object.assign(new Error(limited && limited.status === "rejected" ? `大都会作品详情暂时限流（HTTP 429）：${String(limited.reason).slice(0, 120)}` : "大都会作品详情暂不可用"), { detailCalls: ids.length });
  }
  return { artworks: results.flatMap((r) => r.status === "fulfilled" && r.value && (artistOnly || r.value.thumb) ? [r.value] : []), offset: offset + 8 < Number(search.total || 0) ? offset + 8 : undefined, detailCalls: ids.length };
}
