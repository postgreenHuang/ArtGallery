import { invoke } from "@tauri-apps/api/core";
import { desktop } from "./storage";

export interface ArtistIdentityCandidate {
  id: string;
  label: string;
  description: string;
  matchedName: string;
}
export interface ArtistProfile {
  name: string;
  id?: string;
  description?: string;
  intro?: string;
  url?: string;
  status: "read" | "ambiguous" | "unavailable";
  assessment?: "supported" | "uncertain" | "contradicted";
  assessmentReason?: string;
  evidenceQuote?: string;
}
interface SearchHit { id?: unknown; label?: unknown; description?: unknown; match?: { text?: unknown } }
const cache = new Map<string, { until: number; hits: ArtistIdentityCandidate[] }>();
const profileCache = new Map<string, { until: number; value: { intro?: unknown; url?: unknown } }>();
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

export function clearArtistIdentityCache(): void { cache.clear(); profileCache.clear(); }

export async function researchArtistLeads(names: string[], signal: AbortSignal): Promise<ArtistProfile[]> {
  if (!desktop) return [];
  return Promise.all(names.slice(0, 3).map(async (name): Promise<ArtistProfile> => {
    const safeName = name.trim().slice(0, 120);
    if (!safeName || signal.aborted) return { name: safeName, status: "unavailable" };
    try {
      const hits = await lookup(safeName, /[\u3400-\u9fff]/.test(safeName) ? "zh" : "en", signal);
      if (signal.aborted) throw new DOMException("已停止", "AbortError");
      const exact = hits.filter((hit) => normalized(hit.label) === normalized(safeName) || normalized(hit.matchedName) === normalized(safeName));
      if (exact.length !== 1) return { name: safeName, status: exact.length ? "ambiguous" : "unavailable" };
      const hit = exact[0];
      const savedProfile = profileCache.get(hit.id);
      const raw = savedProfile && savedProfile.until > Date.now() ? savedProfile.value
        : await invoke<{ intro?: unknown; url?: unknown }>("wikidata_artist_profile", { id: hit.id });
      if (!savedProfile || savedProfile.until <= Date.now()) {
        if (profileCache.size >= 100) profileCache.delete(profileCache.keys().next().value!);
        profileCache.set(hit.id, { until: Date.now() + 24 * 60 * 60 * 1000, value: raw });
      }
      if (signal.aborted) throw new DOMException("已停止", "AbortError");
      const intro = typeof raw.intro === "string" ? raw.intro.trim().slice(0, 1800) : "";
      const url = typeof raw.url === "string" && /^https:\/\/(?:zh|en)\.wikipedia\.org\/wiki\//.test(raw.url) ? raw.url : undefined;
      return { name: hit.label, id: hit.id, description: hit.description, intro, url,
        status: intro && url ? "read" : "unavailable" };
    } catch (error) {
      if (signal.aborted) throw error;
      return { name: safeName, status: "unavailable" };
    }
  }));
}
