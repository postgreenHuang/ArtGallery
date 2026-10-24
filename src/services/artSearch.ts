import type { Artwork, Settings } from "../types";
import { searchArt } from "./commons";
import { searchMuseum, type Museum } from "./museums";

export type ArtProvider = "commons" | Museum;
export type ProviderOffsets = Partial<Record<ArtProvider, number>>;
export const providers: ArtProvider[] = ["commons", "cleveland", "chicago"];

export function searchProvider(provider: ArtProvider, query: string, scope: Settings["scope"], offset = 0, signal?: AbortSignal) {
  return provider === "commons"
    ? searchArt(query, scope, offset, signal)
    : searchMuseum(provider, query, offset, signal);
}

export async function searchAcrossProviders(
  query: string,
  scope: Settings["scope"],
  signal: AbortSignal,
  offsets?: ProviderOffsets,
): Promise<{ artworks: Artwork[]; offsets: ProviderOffsets; warning: string }> {
  const selected = providers.filter((provider) => !offsets || offsets[provider] !== undefined);
  const results = await Promise.allSettled(selected.map((provider) =>
    searchProvider(provider, query, scope, offsets?.[provider] || 0, signal),
  ));
  if (signal.aborted) throw new DOMException("已停止", "AbortError");
  const next: ProviderOffsets = {};
  const groups: Artwork[][] = [];
  const errors: string[] = [];
  results.forEach((result, index) => {
    const provider = selected[index];
    if (result.status === "fulfilled") {
      groups.push(result.value.artworks);
      if (result.value.offset !== undefined) next[provider] = result.value.offset;
    } else {
      groups.push([]);
      errors.push(`${provider}: ${String(result.reason)}`);
      // Keep the cursor so a temporarily limited source can be retried later.
      if (offsets?.[provider] !== undefined) next[provider] = offsets[provider];
    }
  });
  const artworks: Artwork[] = [];
  for (let index = 0; groups.some((group) => index < group.length); index++)
    for (const group of groups) if (group[index]) artworks.push(group[index]);
  if (!artworks.length && errors.length) throw new Error(`开放馆藏暂时不可用：${errors.join("；")}`);
  return { artworks, offsets: next, warning: errors.length ? "部分馆藏暂不可用，已展示其他来源的作品。" : "" };
}
