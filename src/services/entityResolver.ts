import { invoke } from "@tauri-apps/api/core";
import { desktop } from "./storage";

export interface ArtistIdentityCandidate {
  id: string;
  label: string;
  description: string;
  matchedName: string;
}
interface SearchHit { id?: unknown; label?: unknown; description?: unknown; match?: { text?: unknown } }
const cache = new Map<string, { until: number; hits: ArtistIdentityCandidate[] }>();
const normalized = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
const artistDescription = /(?:artist|painter|printmaker|engraver|illustrator|watercolorist|sculptor|画家|藝術家|艺术家|版画家|插画家|雕塑家|绘师|繪師)/i;

export function normalizeArtistSearch(value: unknown): ArtistIdentityCandidate[] {
  const hits = value && typeof value === "object" ? (value as { search?: unknown }).search : undefined;
  if (!Array.isArray(hits)) return [];
  return hits.slice(0, 5).flatMap((raw: SearchHit) => {
    const id = typeof raw?.id === "string" ? raw.id : "";
    const label = typeof raw?.label === "string" ? raw.label.trim().slice(0, 120) : "";
    const description = typeof raw?.description === "string" ? raw.description.trim().slice(0, 180) : "";
    const matchedName = typeof raw?.match?.text === "string" ? raw.match.text.trim().slice(0, 120) : label;
    return /^Q\d+$/.test(id) && label && artistDescription.test(description)
      ? [{ id, label, description, matchedName }] : [];
  });
}

async function lookup(name: string, language: "zh" | "en", signal: AbortSignal): Promise<ArtistIdentityCandidate[]> {
  if (signal.aborted) throw new DOMException("已停止", "AbortError");
  const key = `${language}:${normalized(name)}`;
  const saved = cache.get(key);
  if (saved && saved.until > Date.now()) return saved.hits;
  const value = await invoke("wikidata_artist_search", { query: name, language });
  if (signal.aborted) throw new DOMException("已停止", "AbortError");
  const hits = normalizeArtistSearch(value);
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(key, { until: Date.now() + 24 * 60 * 60 * 1000, hits });
  return hits;
}

export async function resolveArtistIdentity(targetArtist: string, originalRequest: string, signal: AbortSignal): Promise<{
  aliases: string[]; choices: ArtistIdentityCandidate[];
}> {
  if (signal.aborted) throw new DOMException("已停止", "AbortError");
  if (!desktop || !targetArtist.trim()) return { aliases: [], choices: [] };
  const name = targetArtist.trim().slice(0, 120);
  const terms: { name: string; language: "zh" | "en" }[] = [{ name, language: /[\u3400-\u9fff]/.test(name) ? "zh" : "en" }];
  const original = originalRequest.trim();
  const standaloneName = /^(?:[\p{Script=Han}·]{2,12}|[A-ZÀ-ž][\p{L}'-]+(?: [A-ZÀ-ž][\p{L}'-]+){1,3})$/u.test(original);
  if (standaloneName && normalized(original) !== normalized(name))
    terms.push({ name: original, language: /[\u3400-\u9fff]/.test(original) ? "zh" : "en" });
  const found = await Promise.allSettled(terms.slice(0, 2).map((term) => lookup(term.name, term.language, signal)));
  if (signal.aborted) throw new DOMException("已停止", "AbortError");
  const all = found.flatMap((entry) => entry.status === "fulfilled" ? entry.value : []);
  const matching = all.filter((item) => [item.label, item.matchedName].some((value) =>
    normalized(value) === normalized(name) || normalized(value) === normalized(original)));
  const byId = new Map<string, ArtistIdentityCandidate>();
  for (const item of matching) if (!byId.has(item.id)) byId.set(item.id, item);
  const choices = [...byId.values()];
  if (choices.length !== 1) return { aliases: [], choices: choices.length > 1 ? choices : [] };
  return { aliases: [...new Set(all.filter((item) => item.id === choices[0].id)
    .flatMap((item) => [item.label, item.matchedName]).filter((value) => normalized(value) !== normalized(name)))].slice(0, 4), choices: [] };
}

export function clearArtistIdentityCache(): void { cache.clear(); }
