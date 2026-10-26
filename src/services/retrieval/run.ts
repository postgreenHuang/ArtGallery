import type { Settings, WebResult } from "../../types";
import { searchForCurator, type ArtProvider, type SearchConstraints, type SourceStatus } from "../artSearch";
import { searchWebPages } from "../webSearch";
import type { SourceQueryPlan } from "./compile";

export interface RetrievalDiagnostics {
  runId: string;
  sourceCalls: number;
  sourceLimit: number;
  attemptedQueries: string[];
  sourceQueries?: SourceQueryPlan[];
  sourceStatuses?: SourceStatus[];
  qualitySupplemented?: boolean;
}

export async function supplementAfterRejection(args: {
  query: string;
  settings: Settings;
  constraints: SearchConstraints;
  diagnostics?: RetrievalDiagnostics;
  signal: AbortSignal;
}) {
  const diagnostics = args.diagnostics;
  if (!diagnostics || diagnostics.qualitySupplemented || diagnostics.sourceCalls >= diagnostics.sourceLimit) return null;
  const tried = new Set((diagnostics.sourceQueries || []).map((plan) => plan.provider));
  const provider = (["met", "chicago", "cleveland", "commons"] as ArtProvider[]).find((source) => !tried.has(source));
  if (!provider) return null;
  const result = await searchForCurator(args.query, { ...args.settings, webSearch: false }, args.signal,
    { ...args.constraints, providers: [provider], allowScopeFallback: false });
  if (args.signal.aborted) throw new DOMException("已停止", "AbortError");
  return { ...result, diagnostics: { ...diagnostics, sourceCalls: diagnostics.sourceCalls + 1,
    sourceQueries: [...(diagnostics.sourceQueries || []), ...(result.sourceQueries || [])],
    sourceStatuses: [...(diagnostics.sourceStatuses || []), ...(result.sourceStatuses || [])], qualitySupplemented: true }, provider };
}

// Provider and Brave operations share one per-run budget. A failed operation
// still consumes a slot; retries inside a provider are not made here.
export async function runCuratorSearch(args: {
  query: string;
  alternativeQueries?: string[];
  settings: Settings;
  constraints: SearchConstraints;
  signal: AbortSignal;
  desktop: boolean;
  onPhase?: (phase: string) => void;
}) {
  const { settings, constraints, signal } = args;
  const runId = crypto.randomUUID();
  const sourceLimit = 6;
  let sourceCalls = 0;
  const attemptedQueries: string[] = [];
  const warnings: string[] = [];
  const firstProviders: ArtProvider[] = settings.webSearch
    ? ["commons", "cleveland", "chicago"] : ["commons", "cleveland", "chicago", "met"];
  const initialWeb = !!settings.webSearch;
  sourceCalls += firstProviders.length + Number(initialWeb);
  attemptedQueries.push(args.query);
  let result = await searchForCurator(args.query, settings, signal,
    { ...constraints, providers: firstProviders, allowScopeFallback: false });
  const sourceQueries: SourceQueryPlan[] = [...(result.sourceQueries || [])];
  const sourceStatuses: SourceStatus[] = [...(result.sourceStatuses || [])];
  if (signal.aborted) throw new DOMException("已停止", "AbortError");
  if (result.warning) warnings.push(result.warning);
  const firstWebResults: WebResult[] = result.webResults;
  let finalQuery = args.query;

  if (!result.artworks.length && sourceCalls < sourceLimit) {
    const alternative = [...new Set((args.alternativeQueries || []).map((query) => query.trim()).filter(Boolean))]
      .find((query) => query !== args.query) || args.query;
    const supplementProviders: ArtProvider[] = settings.webSearch ? ["met"] : ["met", "commons"];
    const permitted = supplementProviders.slice(0, sourceLimit - sourceCalls - Number(settings.webSearch && args.desktop));
    if (permitted.length) {
      args.onPhase?.("相关馆藏不足，正在预算内补查其他来源…");
      sourceCalls += permitted.length;
      attemptedQueries.push(alternative);
      const supplemental = await searchForCurator(alternative, { ...settings, webSearch: false }, signal,
        { ...constraints, providers: permitted, allowScopeFallback: false });
      sourceQueries.push(...(supplemental.sourceQueries || []));
      sourceStatuses.push(...(supplemental.sourceStatuses || []));
      if (signal.aborted) throw new DOMException("已停止", "AbortError");
      if (supplemental.warning) warnings.push(supplemental.warning);
      result = { ...supplemental, offsets: { ...result.offsets, ...supplemental.offsets },
        webResults: firstWebResults.map((item) => ({ ...item,
        selectionReason: item.selectionReason || "网页图片线索，作者待核实。" })) };
      finalQuery = alternative;
    }
  }

  if (!result.artworks.length && settings.webSearch && args.desktop && sourceCalls < sourceLimit) {
    args.onPhase?.("馆藏作品不足，正在补充来源网页…");
    sourceCalls++;
    try {
      const pages = await searchWebPages(args.query, signal);
      if (signal.aborted) throw new DOMException("已停止", "AbortError");
      const seen = new Set(result.webResults.map((item) => item.url));
      result = { ...result, webResults: [...result.webResults,
        ...pages.filter((item) => !seen.has(item.url)).map((item) => ({ ...item,
          selectionReason: item.selectionReason || "网页来源线索，待与馆藏记录核对。" }))] };
    } catch (error) {
      if (signal.aborted) throw error;
      warnings.push(`网页来源检索暂不可用：${String(error).slice(0, 180)}`);
    }
  }
  const diagnostics: RetrievalDiagnostics = { runId, sourceCalls, sourceLimit, attemptedQueries, sourceQueries, sourceStatuses };
  return { ...result, failed: result.failed && !result.webResults.length,
    artworks: result.artworks.slice(0, 48), query: finalQuery,
    queries: attemptedQueries, warning: [...new Set(warnings)].join(" "), diagnostics };
}
