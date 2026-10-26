import type { Artwork, SearchCriteria, Settings } from "../../types";
import { searchArt } from "../commons";
import { providers, searchAcrossProviders, type ArtProvider, type ProviderOffsets } from "../artSearch";

export interface ContinuationDiagnostics {
  runId: string;
  sourceCalls: number;
  sourceLimit: number;
  attemptedProviders: ArtProvider[];
}

export function continuationProviders(offsets: ProviderOffsets, rotation = 0, limit = 2): ArtProvider[] {
  const available = providers.filter((provider) => offsets[provider] !== undefined);
  if (!available.length) return [];
  const start = rotation % available.length;
  return [...available.slice(start), ...available.slice(0, start)].slice(0, limit);
}

export async function runContinuationSearch(args: {
  query: string;
  scope: Settings["scope"];
  offsets?: ProviderOffsets;
  legacyOffset?: number;
  rotation?: number;
  targetArtist?: string;
  artistAliases?: string[];
  criteria?: SearchCriteria;
  signal: AbortSignal;
}): Promise<{ artworks: Artwork[]; offsets?: ProviderOffsets; legacyOffset?: number; warning: string;
  rotation: number; diagnostics: ContinuationDiagnostics }> {
  const runId = crypto.randomUUID();
  const sourceLimit = 2;
  if (args.offsets) {
    const selected = continuationProviders(args.offsets, args.rotation, sourceLimit);
    if (!selected.length) return { artworks: [], offsets: {}, warning: "", rotation: args.rotation || 0,
      diagnostics: { runId, sourceCalls: 0, sourceLimit, attemptedProviders: [] } };
    const selectedOffsets = Object.fromEntries(selected.map((provider) => [provider, args.offsets![provider]])) as ProviderOffsets;
    const result = await searchAcrossProviders(args.query, args.scope, args.signal, selectedOffsets,
      { targetArtist: args.targetArtist, artistAliases: args.artistAliases, criteria: args.criteria, providers: selected });
    if (args.signal.aborted) throw new DOMException("已停止", "AbortError");
    const offsets = { ...args.offsets };
    for (const provider of selected) {
      if (result.offsets[provider] === undefined) delete offsets[provider];
      else offsets[provider] = result.offsets[provider];
    }
    return { artworks: result.artworks, offsets, warning: result.warning,
      rotation: (args.rotation || 0) + selected.length,
      diagnostics: { runId, sourceCalls: selected.length, sourceLimit, attemptedProviders: selected } };
  }
  const result = await searchArt(args.query, args.scope, args.legacyOffset || 0, args.signal);
  if (args.signal.aborted) throw new DOMException("已停止", "AbortError");
  return { artworks: result.artworks, legacyOffset: result.offset, warning: "", rotation: args.rotation || 0,
    diagnostics: { runId, sourceCalls: 1, sourceLimit, attemptedProviders: ["commons"] } };
}
