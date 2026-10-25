import { invoke } from "@tauri-apps/api/core";
import { desktop } from "./storage";
import type { WebResult } from "../types";

export const SEARCH_KEY_ADDRESS = "https://api.search.brave.com";
export function publicHttps(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !url.hostname.includes(".") || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname) ||
      /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(":")) return;
    return url.href;
  } catch { return; }
}
export function normalizeWebResults(value: unknown): WebResult[] {
  if (!value || typeof value !== "object") return [];
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const seen = new Set<string>();
  return results.flatMap((item) => {
    const url = publicHttps(item?.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    const thumb = publicHttps(item?.thumbnail?.src);
    return [{ url, title: String(item.title || "网页作品线索").slice(0, 300),
      description: String(item.description || "").replace(/<[^>]*>/g, "").slice(0, 600),
      source: new URL(url).hostname,
      // Only the search service's thumbnail proxy is embedded. Arbitrary sites open externally.
      thumbnail: thumb && new URL(thumb).hostname === "imgs.search.brave.com" ? thumb : undefined,
    }];
  }).slice(0, 12);
}
export async function searchWeb(query: string, signal: AbortSignal): Promise<WebResult[]> {
  if (!desktop) throw new Error("全网搜图请在桌面版配置 Brave Search 密钥");
  const value = await invoke("web_image_search", { query });
  if (signal.aborted) throw new DOMException("已停止", "AbortError");
  return normalizeWebResults(value);
}
