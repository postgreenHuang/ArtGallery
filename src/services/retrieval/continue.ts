import type { Artwork, Message, SearchCriteria, Settings } from "../../types";
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
  artistCursors?: Message["artistCursors"];
  signal: AbortSignal;
}): Promise<{ artworks: Artwork[]; offsets?: ProviderOffsets; legacyOffset?: number; warning: string;
  artistCursors?: Message["artistCursors"]; rotation: number; diagnostics: ContinuationDiagnostics }> {
  const runId = crypto.randomUUID();
  const sourceLimit = 2;
  if (args.artistCursors?.length) {
    const cursors = args.artistCursors.map((cursor) => ({ ...cursor, offsets: { ...cursor.offsets } }));
    const pairs = cursors.flatMap((cursor, index) => providers.flatMap((provider) =>
      cursor.offsets[provider] === undefined ? [] : [{ index, provider, offset: cursor.offsets[provider]! }]));
    if (!pairs.length) return { artworks: [], artistCursors: cursors, warning: "", rotation: args.rotation || 0,
      diagnostics: { runId, sourceCalls: 0, sourceLimit, attemptedProviders: [] } };
    const start = (args.rotation || 0) % pairs.length;
    const selected = [...pairs.slice(start), ...pairs.slice(0, start)].slice(0, sourceLimit);
    const artworks: Artwork[] = [];
    const warnings: string[] = [];
    for (const { index, provider, offset } of selected) {
      const cursor = cursors[index];
      const result = await searchAcrossProviders(cursor.name, "commons", args.signal, { [provider]: offset },
        { targetArtist: cursor.name, providers: [provider], criteria: args.criteria });
      if (args.signal.aborted) throw new DOMException("已停止", "AbortError");
      if (result.offsets[provider] === undefined) delete cursor.offsets[provider];
      else cursor.offsets[provider] = result.offsets[provider];
      artworks.push(...result.artworks.map((art) => ({ ...art,
        selectionReason: `继续按画家姓名 ${cursor.name} 检索；${art.selectionReason || "作者字段待核实"}` })));
      if (result.warning) warnings.push(result.warning);
    }
    return { artworks: artworks.filter((art, index, all) => all.findIndex((other) =>
      (other.recordKey || `${other.provider || "commons"}:${other.id}`) === (art.recordKey || `${art.provider || "commons"}:${art.id}`)) === index),
      artistCursors: cursors, warning: [...new Set(warnings)].join(" "), rotation: (args.rotation || 0) + selected.length,
      diagnostics: { runId, sourceCalls: selected.length, sourceLimit, attemptedProviders: selected.map((item) => item.provider) } };
  }
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
