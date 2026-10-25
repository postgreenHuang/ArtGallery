import { invoke } from "@tauri-apps/api/core";
import type { Artwork, PageEvidence, WebResult } from "../types";
import { desktop } from "./storage";
import { plain } from "./commons";
import { publicHttps } from "./webSearch";

export function extractPageText(html: string): { title: string; text: string } {
  const input = html.slice(0, 512 * 1024);
  const title = plain(input.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || "").slice(0, 300);
  // Keep parsing inert and omit scripts, styles, frames and external resources.
  const cleaned = input.replace(/<!--[^]*?-->/g, " ")
    .replace(/<(script|style|svg|noscript|iframe|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(?:img|link|meta|source|video|audio|embed|object)\b[^>]*>/gi, " ");
  const main = cleaned.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)\s*>/i)?.[1] || cleaned;
  return { title, text: plain(main).slice(0, 4000) };
}
const cache = new Map<string, { time: number; evidence: PageEvidence }>();
export async function readPageEvidence(url: string, signal: AbortSignal): Promise<PageEvidence> {
  const valid = publicHttps(url);
  const unavailable = (error: string): PageEvidence => ({ url, title: "", text: "", status: "unavailable", error });
  if (!valid) return unavailable("来源地址不符合公开 HTTPS 网页要求");
  if (signal.aborted) throw new DOMException("已停止", "AbortError");
  const cached = cache.get(valid);
  if (cached && Date.now() - cached.time < 10 * 60 * 1000) return cached.evidence;
  if (!desktop) return unavailable("来源页读取仅在桌面版可用");
  try {
    const response = await invoke<{ url: string; html: string }>("read_source_page", { url: valid });
    if (signal.aborted) throw new DOMException("已停止", "AbortError");
    const extracted = extractPageText(response.html);
    const evidence: PageEvidence = extracted.text.length >= 40
      ? { url: publicHttps(response.url) || valid, ...extracted, status: "read" }
      : unavailable("页面没有足够的可读文字，可能需要登录或由脚本加载");
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(valid, { time: Date.now(), evidence });
    return evidence;
  } catch (error) {
    if (signal.aborted) throw new DOMException("已停止", "AbortError");
    return unavailable(String(error).slice(0, 240));
  }
}
export async function enrichSources(artworks: Artwork[], webResults: WebResult[], signal: AbortSignal) {
  // Museum API records already contain authoritative object metadata. Read pages
  // for sparse records and the first web clues, with a bounded total request count.
  const urls = [...new Set([
    ...webResults.slice(0, 6).map((item) => item.url),
    ...artworks.filter((art) => art.description.length < 80).slice(0, 6).map((art) => art.source),
  ])].slice(0, 12);
  const evidence = new Map<string, PageEvidence>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, urls.length) }, async () => {
    while (next < urls.length) {
      if (signal.aborted) throw new DOMException("已停止", "AbortError");
      const url = urls[next++];
      evidence.set(url, await readPageEvidence(url, signal));
    }
  }));
  return {
    artworks: artworks.map((art) => ({ ...art, pageEvidence: evidence.get(art.source) || art.pageEvidence })),
    webResults: webResults.map((item) => ({ ...item, pageEvidence: evidence.get(item.url) || item.pageEvidence })),
  };
}
