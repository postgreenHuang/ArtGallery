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
    .replace(/<([a-z][\w-]*)\b[^>]*(?:\bhidden\b|aria-hidden=["']true["']|style=["'][^"']*display\s*:\s*none)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(?:img|link|meta|source|video|audio|embed|object)\b[^>]*>/gi, " ");
  const main = cleaned.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)\s*>/i)?.[1] || cleaned;
  return { title, text: plain(main).slice(0, 4000) };
}
export function extractPageBlocks(html: string, baseUrl: string): NonNullable<PageEvidence["blocks"]> {
  if (typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(html.slice(0, 512 * 1024), "text/html");
  doc.querySelectorAll("script,style,svg,noscript,iframe,nav,footer,header,[hidden],[aria-hidden='true']").forEach((node) => node.remove());
  const regions = [...doc.querySelectorAll("article,figure")];
  const targets = regions.length ? regions : [...doc.querySelectorAll("main")].slice(0, 1);
  return targets.slice(0, 8).flatMap((node) => {
    const title = plain(node.querySelector("h1,h2,h3,h4")?.textContent || node.querySelector("figcaption")?.textContent || (regions.length ? "" : doc.title)).slice(0, 200);
    const text = plain(node.textContent || "").slice(0, 700);
    if (text.length < 30) return [];
    const imageUrls = [...node.querySelectorAll("img")].slice(0, 4).flatMap((image) => {
      try {
        const url = new URL(image.getAttribute("src") || image.getAttribute("data-src") || "", baseUrl);
        const valid = publicHttps(url.href);
        return valid ? [valid] : [];
      } catch { return []; }
    });
    return [{ title, text, imageUrls }];
  });
}
export function isGatePage(title: string, text: string): boolean {
  return /^(?:access denied|forbidden|just a moment|checking your browser|robot check|captcha|sign in|log in|please enable javascript)/i.test(title.trim()) ||
    /(?:verify you are human|complete the captcha|enable javascript to continue)/i.test(text.slice(0, 350));
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
    const finalUrl = publicHttps(response.url) || valid;
    const evidence: PageEvidence = extracted.text.length >= 40 && !isGatePage(extracted.title, extracted.text)
      ? { url: finalUrl, ...extracted, blocks: extractPageBlocks(response.html, finalUrl), status: "read" }
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
    ...webResults.slice(0, 2).map((item) => item.url),
    ...artworks.filter((art) => art.description.length < 80).slice(0, 6).map((art) => art.source),
  ])].slice(0, 6);
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
