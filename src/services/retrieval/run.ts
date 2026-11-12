import type { ArtistSuggestion, Artwork, Message, Settings, WebResult } from "../../types";
import type { ArtistProfile } from "../entityResolver";
import { searchForCurator, type ArtProvider, type SearchConstraints, type SourceStatus } from "../artSearch";
import { searchWebPages } from "../webSearch";
import type { SourceQueryPlan } from "./compile";

export interface RetrievalDiagnostics {
  runId: string;
  sourceCalls: number;
  sourceLimit: number;
  detailCalls?: number;
  attemptedQueries: string[];
  sourceQueries?: SourceQueryPlan[];
  sourceStatuses?: SourceStatus[];
  qualitySupplemented?: boolean;
}

async function searchArtistLeads(args: {
  profiles: ArtistProfile[]; query: string; settings: Settings; signal: AbortSignal;
  constraints: SearchConstraints; desktop: boolean; onPhase?: (phase: string) => void;
  onCandidatePreview?: (artworks: Artwork[]) => void;
}) {
  // A model may call a valid painter "uncertain" because the biography has no
  // artwork image. Keep that uncertainty visible and still search by author.
  const leads = args.profiles.filter((profile) => profile.name && profile.assessment !== "contradicted")
    .sort((left, right) => Number(right.status === "read") - Number(left.status === "read")).slice(0, 2);
  const sourceQueries: SourceQueryPlan[] = [];
  const sourceStatuses: SourceStatus[] = [];
  const attemptedQueries: string[] = [];
  const artworks: Artwork[] = [];
  const warnings: string[] = [];
  let detailCalls = 0;
  let sourceCalls = 0;
  const artistCursors: NonNullable<Message["artistCursors"]> = leads.map((profile) => ({ name: profile.name, id: profile.id, offsets: {} }));
  let failed = false;
  const run = async (profile: ArtistProfile, providers: ArtProvider[]) => {
    if (args.signal.aborted) throw new DOMException("已停止", "AbortError");
    sourceCalls += providers.length;
    attemptedQueries.push(profile.name);
    const found = await searchForCurator(profile.name, { ...args.settings, scope: "commons", webSearch: false }, args.signal,
      { ...args.constraints, targetArtist: profile.name, artistAliases: [], providers, allowScopeFallback: false }, args.onCandidatePreview);
    sourceQueries.push(...(found.sourceQueries || []));
    sourceStatuses.push(...(found.sourceStatuses || []));
    detailCalls += found.detailCalls || 0;
    const cursor = artistCursors.find((item) => item.name === profile.name);
    if (cursor) cursor.offsets = { ...cursor.offsets, ...found.offsets };
    failed ||= found.failed;
    if (found.warning) warnings.push(found.warning);
    artworks.push(...found.artworks.map((art) => ({ ...art,
      selectionReason: `按画家姓名 ${profile.name}（${profile.id || "身份未核实"}）检索；${art.selectionReason || "作者仍待核实"}` })));
  };
  args.onPhase?.("先按画家资料线索查询 Wikimedia Commons…");
  for (const profile of leads) await run(profile, ["commons"]);
  args.onPhase?.("正在按画家姓名补查其他开放馆藏…");
  for (const [index, profile] of leads.entries()) await run(profile, index === 0 ? ["cleveland", "chicago"] : ["met", "cleveland"]);
  const unique = artworks.filter((art, index, all) => all.findIndex((other) =>
    (other.recordKey || `${other.provider || "commons"}:${other.id}`) === (art.recordKey || `${art.provider || "commons"}:${art.id}`)) === index);
  const webResults: WebResult[] = [];
  if (!unique.length && args.settings.webSearch && args.desktop) {
    args.onPhase?.("馆藏尚无作品，最后查询公开网页线索…");
    sourceCalls++;
    try { webResults.push(...await searchWebPages(args.query, args.signal)); }
    catch (error) {
      if (args.signal.aborted) throw error;
      warnings.push(`网页来源检索暂不可用：${String(error).slice(0, 180)}`);
    }
  }
  if (args.signal.aborted) throw new DOMException("已停止", "AbortError");
  return { artworks: unique.slice(0, 48), webResults, offsets: {}, artistCursors, scope: "commons" as const,
    warning: [...new Set(warnings)].join(" "), failed: failed && !unique.length && !webResults.length,
    query: args.query, queries: attemptedQueries,
    diagnostics: { runId: crypto.randomUUID(), sourceCalls, sourceLimit: 7, detailCalls,
      attemptedQueries, sourceQueries, sourceStatuses } satisfies RetrievalDiagnostics };
}

export async function runRecommendationSearch(args: {
  recommendations: ArtistSuggestion[];
  settings: Settings;
  signal: AbortSignal;
  anchor?: Artwork;
  onCandidatePreview?: (artworks: Artwork[]) => void;
  onPhase?: (phase: string) => void;
}) {
  const recommendations = args.recommendations.filter((candidate, index, all) =>
    all.findIndex((other) => other.query.trim().toLocaleLowerCase() === candidate.query.trim().toLocaleLowerCase()) === index).slice(0, 3);
  const settings = { ...args.settings, scope: "commons" as const, webSearch: false };
  args.onPhase?.("先按推荐画家的姓名查询整个 Wikimedia Commons…");
  const commons = await Promise.all(recommendations.map((candidate) => searchForCurator(candidate.query, settings, args.signal,
    { targetArtist: candidate.query, artistAliases: [candidate.nameZh, candidate.nameEn],
      providers: ["commons"], allowScopeFallback: false, pageSize: 8 }, args.onCandidatePreview)));
  if (args.signal.aborted) throw new DOMException("已停止", "AbortError");
  const museumByArtist: ArtProvider[] = ["cleveland", "chicago", "met"];
  const missing = recommendations.flatMap((candidate, index) => commons[index].artworks.length ? [] : [{ candidate, index }]);
  if (missing.length) args.onPhase?.("Commons 暂无匹配作品，按画家姓名补查其他开放馆藏…");
  const supplemental = await Promise.all(missing.map(async ({ candidate, index }) => ({ index,
    result: await searchForCurator(candidate.query, settings, args.signal,
      { targetArtist: candidate.query, artistAliases: [candidate.nameZh, candidate.nameEn],
        providers: [museumByArtist[index]], allowScopeFallback: false }, args.onCandidatePreview),
  })));
  if (args.signal.aborted) throw new DOMException("已停止", "AbortError");
  const byArtist = recommendations.map((candidate, index) => {
    const extra = supplemental.find((item) => item.index === index)?.result;
    return { candidate, result: commons[index], extra };
  });
  const anchorKey = args.anchor?.recordKey || (args.anchor ? `${args.anchor.provider || "commons"}:${args.anchor.id}` : "");
  const artworks = byArtist.flatMap(({ candidate, result, extra }) => [...result.artworks, ...(extra?.artworks || [])].map((art) => ({ ...art,
    selectionReason: `候选画家 ${candidate.nameZh}：${candidate.reason.slice(0, 55)}；作者字段已核对，作品与参照画的相似性仍需逐件复核。` })))
    .filter((art, index, all) => {
      const key = art.recordKey || `${art.provider || "commons"}:${art.id}`;
      return key !== anchorKey && all.findIndex((other) => (other.recordKey || `${other.provider || "commons"}:${other.id}`) === key) === index;
    });
  const artistCursors: NonNullable<Message["artistCursors"]> = byArtist.map(({ candidate, result, extra }) => ({
    name: candidate.query, offsets: { ...result.offsets, ...extra?.offsets },
  }));
  const diagnostics: RetrievalDiagnostics = { runId: crypto.randomUUID(), sourceCalls: recommendations.length + supplemental.length,
    sourceLimit: 6, detailCalls: byArtist.reduce((sum, item) => sum + (item.result.detailCalls || 0) + (item.extra?.detailCalls || 0), 0),
    attemptedQueries: recommendations.map((item) => item.query),
    sourceQueries: byArtist.flatMap((item) => [...(item.result.sourceQueries || []), ...(item.extra?.sourceQueries || [])]),
    sourceStatuses: byArtist.flatMap((item) => [...(item.result.sourceStatuses || []), ...(item.extra?.sourceStatuses || [])]) };
  return { artworks, webResults: [] as WebResult[], artistCursors, diagnostics, scope: "commons" as const,
    queries: recommendations.map((item) => item.query),
    warning: byArtist.map((item) => `${item.candidate.nameEn}：${item.candidate.reason} ${item.result.warning} ${item.extra?.warning || ""} ${!item.result.artworks.length && !item.extra?.artworks.length ? "本次无作者匹配的馆藏作品。" : ""}`).join("\n"),
    suggestions: byArtist.filter((item) => item.result.artworks.length || item.extra?.artworks.length).map((item) => ({ ...item.candidate, scope: "commons" as const })) };
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
    detailCalls: (diagnostics.detailCalls || 0) + (result.detailCalls || 0),
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
  onCandidatePreview?: (artworks: Artwork[]) => void;
  artistProfiles?: ArtistProfile[];
}) {
  const { settings, constraints, signal } = args;
  const namedProfiles = args.artistProfiles?.filter((profile) => profile.name && profile.assessment !== "contradicted") || [];
  // An explicit artist must not fall back to the default Google Art Project
  // keyword scope just because the identity service was unavailable.
  const directArtist = constraints.targetArtist?.trim();
  if (namedProfiles.length || directArtist)
    return searchArtistLeads({ profiles: namedProfiles.length ? namedProfiles : [{ name: directArtist!, status: "unavailable", assessment: "uncertain" }], query: args.query, settings, constraints, signal,
      desktop: args.desktop, onPhase: args.onPhase, onCandidatePreview: args.onCandidatePreview });
  const runId = crypto.randomUUID();
  const sourceLimit = 6;
  let sourceCalls = 0;
  let detailCalls = 0;
  const attemptedQueries: string[] = [];
  const warnings: string[] = [];
  const firstProviders: ArtProvider[] = settings.webSearch
    ? ["commons", "cleveland", "chicago"] : ["commons", "cleveland", "chicago", "met"];
  const initialWeb = !!settings.webSearch;
  sourceCalls += firstProviders.length + Number(initialWeb);
  attemptedQueries.push(args.query);
  let result = await searchForCurator(args.query, settings, signal,
    { ...constraints, providers: firstProviders, allowScopeFallback: false }, args.onCandidatePreview);
  detailCalls += result.detailCalls || 0;
  const sourceQueries: SourceQueryPlan[] = [...(result.sourceQueries || [])];
  const sourceStatuses: SourceStatus[] = [...(result.sourceStatuses || [])];
  if (signal.aborted) throw new DOMException("已停止", "AbortError");
  if (result.warning) warnings.push(result.warning);
  const firstWebResults: WebResult[] = result.webResults;
  let finalQuery = args.query;

  if (!result.artworks.length && sourceCalls < sourceLimit) {
    const alternative = [...new Set((args.alternativeQueries || []).map((query) => query.trim()).filter(Boolean))]
      .find((query) => query !== args.query);
    const limited = new Set(sourceStatuses.filter((status) => status.state === "limited").map((status) => status.provider));
    const supplementProviders: ArtProvider[] = settings.webSearch ? ["met"] : ["met", "commons"];
    const permitted = supplementProviders.filter((provider) => !limited.has(provider))
      .slice(0, sourceLimit - sourceCalls - Number(settings.webSearch && args.desktop));
    if (alternative && permitted.length) {
      args.onPhase?.("相关馆藏不足，正在预算内补查其他来源…");
      sourceCalls += permitted.length;
      attemptedQueries.push(alternative);
      const supplemental = await searchForCurator(alternative, { ...settings, webSearch: false }, signal,
        { ...constraints, providers: permitted, allowScopeFallback: false }, args.onCandidatePreview);
      detailCalls += supplemental.detailCalls || 0;
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
  const diagnostics: RetrievalDiagnostics = { runId, sourceCalls, sourceLimit, detailCalls, attemptedQueries, sourceQueries, sourceStatuses };
  return { ...result, failed: result.failed && !result.webResults.length,
    artworks: result.artworks.slice(0, 48), query: finalQuery,
    queries: attemptedQueries, warning: [...new Set(warnings)].join(" "), diagnostics };
}
