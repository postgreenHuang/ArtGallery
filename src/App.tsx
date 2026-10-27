import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  Bookmark,
  Check,
  Clock3,
  ExternalLink,
  FolderOpen,
  Image as ImageIcon,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  MessageCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import FullscreenViewer from "./components/FullscreenViewer";
import FloatingArtwork from "./components/FloatingArtwork";
import IntentEditor from "./components/IntentEditor";
import type {
  Artwork,
  Conversation,
  Library,
  Message,
  SavedArtwork,
  Settings,
  ArtistSuggestion,
  CandidateReview,
  SearchCriteria,
  WebResult,
} from "./types";
import { defaultLibrary } from "./types";
import {
  cacheArtwork,
  cachedArtwork,
  clearTemporaryImages,
  desktop,
  localImage,
  readLibrary,
  writeLibrary,
} from "./services/storage";

import { highResolution } from "./services/commons";
import { searchForCurator } from "./services/artSearch";
import { reviewCandidates } from "./services/review";
import { SEARCH_KEY_ADDRESS } from "./services/webSearch";
import { runCuratorSearch, supplementAfterRejection } from "./services/retrieval/run";
import { runContinuationSearch } from "./services/retrieval/continue";
import { museumName } from "./services/museums";
import { discoverArt, type DiscoveryCoverage } from "./services/discovery";
import { buildExploreIntent } from "./domain/intent";
import { describeIntentEdit } from "./domain/intentEdit";
import { planArtworkBranch, type BranchPlan } from "./domain/exploreBranch";
import { ViewerFullscreenController } from "./services/viewerFullscreen";
import {
  artworkIntroductionPrompt,
  explainArtwork,
  isRecommendationRequest,
  localArtworkIntroduction,
  planSearch,
  replyFromResults,
  curateResults,
  type CuratorReply,
  type Plan,
} from "./services/ai";

const isOriginalLocal = (local?: string) =>
  !!local &&
  (local.startsWith("collection/originals/") ||
    local.includes("-original.") ||
    local.endsWith(":original") ||
    local.endsWith(":collection"));
const fullImageLabel = (art: Artwork) => art.provider === "cleveland" ? "馆方高清 JPEG" : "原图";
const hasArtworkImage = (art: Artwork) => !!(art.thumb || art.medium || art.hd || art.original);

const prompts = [
  {
    label: "在莫奈的花园里",
    query: "推荐莫奈的睡莲",
    sub: "光与水的诗意",
    color: "sage",
  },
  {
    label: "走进梵高的世界",
    query: "推荐梵高的风景画",
    sub: "笔触中的生命力",
    color: "ochre",
  },
  {
    label: "借一片海，放空",
    query: "寻找描绘海洋的画作",
    sub: "关于蓝色的想象",
    color: "blue",
  },
];
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pageEvidenceLabel = (item: Artwork | WebResult) => item.pageEvidence?.status === "read"
  ? "已读来源页" : item.pageEvidence?.status === "unavailable" ? "来源页不可读" : "来源页未请求";
function ArtImage({
  art,
  saved,
  className = "",
  onClick,
  preferOriginal = false,
  retryToken = 0,
  onFailure,
}: {
  art: Artwork;
  saved?: SavedArtwork;
  className?: string;
  onClick?: () => void;
  preferOriginal?: boolean;
  retryToken?: number;
  onFailure?: (failed: boolean) => void;
}) {
  const [src, setSrc] = useState(saved || (desktop && !art.provider) ? "" : art.thumb);
  const [failed, setFailed] = useState(false);
  const attempts = useRef(new Set<string>());
  const generation = useRef(0);
  const fallbackBlob = useRef("");
  useEffect(() => {
    let alive = true;
    let blob = "";
    generation.current += 1;
    attempts.current.clear();
    setFailed(false);
    onFailure?.(false);
    setSrc(saved || (desktop && !art.provider) ? "" : art.thumb);
    const image =
      !hasArtworkImage(art) && !saved?.local ? null
      : saved && preferOriginal && isOriginalLocal(saved.local)
        ? localImage(saved.local)
        : saved
          ? cacheArtwork(art.id, art.thumb, "preview")
              .then(localImage)
              .catch(() => saved.local ? localImage(saved.local) : art.thumb)
          : desktop && !art.provider
            ? cacheArtwork(art.id, art.thumb).then(localImage)
            : art.provider
              ? cachedArtwork(art.id, "preview")
                  .then((local) => local || cachedArtwork(art.id, "medium"))
                  .then((local) => local ? localImage(local) : art.thumb)
            : null;
    if (image)
      image
        .then((url) => {
          blob = url;
          if (alive && !attempts.current.has("cache")) setSrc(url);
        })
        .catch(() => {
          if (alive && !attempts.current.has("cache")) setSrc(art.thumb);
        });
    const useViewerCache = (event: Event) => {
      if ((event as CustomEvent<number>).detail !== art.id) return;
      void cachedArtwork(art.id, "preview")
        .then((local) => local || cachedArtwork(art.id, "medium"))
        .then((local) => local ? localImage(local) : null)
        .then((url) => {
          if (!url) return;
          if (!alive) {
            if (url.startsWith("blob:")) URL.revokeObjectURL(url);
            return;
          }
          if (blob.startsWith("blob:")) URL.revokeObjectURL(blob);
          blob = url;
          setFailed(false);
          onFailure?.(false);
          setSrc(url);
        })
        .catch(() => {});
    };
    window.addEventListener("art-image-cached", useViewerCache);
    return () => {
      alive = false;
      window.removeEventListener("art-image-cached", useViewerCache);
      if (blob.startsWith("blob:")) URL.revokeObjectURL(blob);
      if (fallbackBlob.current.startsWith("blob:")) URL.revokeObjectURL(fallbackBlob.current);
      fallbackBlob.current = "";
    };
  }, [saved?.local, art.id, art.thumb, preferOriginal, retryToken, onFailure]);
  function imageError() {
    if (src !== art.thumb && src !== art.medium && !attempts.current.has("thumb")) {
      attempts.current.add("thumb");
      setSrc(art.thumb);
      return;
    }
    if (art.provider && !attempts.current.has("cache")) {
      attempts.current.add("cache");
      const current = generation.current;
      const url = art.provider === "chicago" ? art.medium || art.thumb : art.thumb;
      const variant = art.provider === "chicago" ? "medium" : "preview";
      setSrc("");
      void cacheArtwork(art.id, url, variant).then(localImage).then((local) => {
        if (generation.current === current) {
          fallbackBlob.current = local;
          setFailed(false);
          onFailure?.(false);
          setSrc(local);
        }
        else if (local.startsWith("blob:")) URL.revokeObjectURL(local);
      }).catch(() => {
        if (generation.current === current) {
          setFailed(true);
          onFailure?.(true);
        }
      });
      return;
    }
    setFailed(true);
    onFailure?.(true);
  }
  return (
    <div className={`art-image ${className}`} onClick={onClick}>
      {!failed && src ? (
        <img
          src={src}
          alt={art.title}
          loading="lazy"
          onError={imageError}
        />
      ) : (
        <div className="image-placeholder">
          <ImageIcon size={28} />
          <span>{!hasArtworkImage(art) && !saved?.local ? "馆藏未提供图片" : failed ? "图片暂不可用" : "正在装裱…"}</span>
        </div>
      )}
    </div>
  );
}
function ArtCard({
  art,
  saved,
  onOpen,
  onSave,
  onContext,
  onSimilar,
  pending,
  position,
}: {
  art: Artwork;
  saved?: SavedArtwork;
  onOpen: () => void;
  onSave: () => void;
  onContext: (x: number, y: number) => void;
  onSimilar?: () => void;
  pending: boolean;
  position?: number;
}) {
  const originalSaved = isOriginalLocal(saved?.local);
  const hasImage = hasArtworkImage(art) || !!saved?.local;
  const [imageFailed, setImageFailed] = useState(false);
  const [imageRetry, setImageRetry] = useState(0);
  return (
    <article
      className="art-card"
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(e.clientX, e.clientY);
      }}
    >
      {position !== undefined && <span className="art-number">作品 {position}</span>}
      <button
        className="art-open"
        onClick={onOpen}
        aria-label={`${hasImage ? "欣赏" : "查看馆藏资料"} ${art.title}`}
      >
        <ArtImage art={art} saved={saved} retryToken={imageRetry} onFailure={setImageFailed} />
        <span className="view-art">
          <Maximize2 size={16} /> {hasImage ? "欣赏作品" : "查看馆藏资料"}
        </span>
      </button>
      {imageFailed && (
        <button className="art-image-retry" onClick={() => setImageRetry((value) => value + 1)}>
          <RefreshCw size={13} /> 重试缩略图
        </button>
      )}
      <div className="art-caption">
        <div>
          <p>{art.artist.slice(0, 100)}</p>
          <h3 title={art.title}>{art.title}</h3>
          {saved && !originalSaved && art.original && <small className="art-pending">{fullImageLabel(art)}待下载 · 点击书签重试</small>}
        </div>
        <button
          className={`icon-button save ${saved ? "is-saved" : ""}`}
          aria-label={
            saved
              ? !art.original ? "已在画架 · 馆藏资料卡" : originalSaved
                ? `已在画架 · ${fullImageLabel(art)}`
                : `重试下载${fullImageLabel(art)}`
              : art.original ? "加入画架" : "保存馆藏资料到画架"
          }
          title={
            saved
              ? !art.original ? "已在画架 · 馆藏资料卡" : originalSaved
                ? `已在画架 · ${fullImageLabel(art)}`
                : `重试下载${fullImageLabel(art)}`
              : art.original ? `加入画架 · 下载${fullImageLabel(art)}` : "加入画架 · 保存馆藏资料"
          }
          onClick={onSave}
          disabled={pending}
        >
          {pending ? (
            <LoaderCircle className="spin" size={18} />
          ) : (
            <Bookmark size={18} fill={saved ? "currentColor" : "none"} />
          )}
        </button>
      </div>
      <p className="art-selection-reason"><span>选择原因</span> {art.curatorReason || art.review?.reason || art.selectionReason || "历史记录未保存当时的选择依据。"}
        {(art.curatorReason || art.review?.reason) && art.selectionReason && <small>检索依据：{art.selectionReason}</small>}
      </p>
      {art.review && <p className={`review-status ${art.review.verdict}`} title={art.review.quote ? `引用依据：${art.review.quote}` : undefined}>
        复核：{art.review.verdict === "keep" ? "相关" : "待核实"} · {art.review.imageProvided ? "已提供缩略图" : "未提供图片"} · {pageEvidenceLabel(art)}
      </p>}
      <div className="art-meta">
        <span>{art.date.slice(0, 38)}</span>
        <span>{art.provider ? museumName[art.provider] : art.license}</span>
        {onSimilar && (
          <button className="similar-button" onClick={onSimilar}>
            <Sparkles size={13} /> 查看相似
          </button>
        )}
        <button
          className="icon-button"
          aria-label={`更多操作 ${art.title}`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onContext(r.left, r.bottom);
          }}
        >
          <MoreHorizontal size={17} />
        </button>
      </div>
    </article>
  );
}
function CollectionOrganizer({ saved, groups, onSave }: {
  saved: SavedArtwork; groups: string[]; onSave: (group: string, note: string) => void;
}) {
  const [group, setGroup] = useState(saved.collectionGroup || "");
  const [note, setNote] = useState(saved.note || "");
  return <form className="collection-organizer" onSubmit={(event) => {
    event.preventDefault();
    onSave(group.trim().slice(0, 40), note.trim().slice(0, 500));
  }}>
    <h3>我的画架整理</h3>
    <label>主题分组
      <input list="saved-collection-groups" maxLength={40} value={group} onChange={(event) => setGroup(event.target.value)}
        placeholder="例如：喜欢的风景" />
    </label>
    <datalist id="saved-collection-groups">{groups.map((name) => <option key={name} value={name} />)}</datalist>
    <label>私人笔记
      <textarea maxLength={500} value={note} onChange={(event) => setNote(event.target.value)}
        placeholder="记下喜欢它的原因，只有你能在本机看到" />
    </label>
    <button className="secondary-button" type="submit">保存画架整理</button>
  </form>;
}

export default function App() {
  const [library, setLibrary] = useState<Library>(
    structuredClone(defaultLibrary),
  );
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState("");
  const [backupSummary, setBackupSummary] = useState<{ saved: number; conversations: number } | null>(null);
  const [backupNotice, setBackupNotice] = useState("");
  const [restoringBackup, setRestoringBackup] = useState(false);
  const [persistError, setPersistError] = useState("");
  const [view, setView] = useState<"discover" | "easel" | "viewed" | "history" | "chat">(
    "discover",
  );
  const [active, setActive] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [editingCriteriaId, setEditingCriteriaId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [easelGroup, setEaselGroup] = useState("");
  const [historyKind, setHistoryKind] = useState<"inspiration" | "artwork">(
    "inspiration",
  );
  const [discover, setDiscover] = useState<Artwork[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(true);
  const [discoverError, setDiscoverError] = useState("");
  const [discoverCoverage, setDiscoverCoverage] = useState<DiscoveryCoverage | null>(null);
  const discoverRequest = useRef<AbortController | null>(null);
  const discoverArtists = useRef<string[]>([]);
  const discoverSeen = useRef(new Set<number>());
  const discoverArtistSeen = useRef(new Set<string>());
  const discoverCultureSeen = useRef(new Set<string>());
  const discoverTypeSeen = useRef(new Set<string>());
  const discoverOffsets = useRef<Record<string, number>>({});
  const discoverScope = useRef(library.settings.scope);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const request = useRef<AbortController | null>(null);
  const [saving, setSaving] = useState<number[]>([]);
  const [detail, setDetail] = useState<Artwork | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [floatingArtworkOpen, setFloatingArtworkOpen] = useState(false);
  const [viewerArts, setViewerArts] = useState<Artwork[]>([]);
  const viewerFromDetail = useRef(false);
  const browserFullscreen = useRef(false);
  const desktopFullscreen = useRef<ViewerFullscreenController | null>(null);
  const [hd, setHd] = useState<Record<number, string>>({});
  const [hdBusy, setHdBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [context, setContext] = useState<{
    art: Artwork;
    x: number;
    y: number;
  } | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [removeArt, setRemoveArt] = useState<Artwork | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const current = library.conversations.find((c) => c.id === active);
  useEffect(() => setFloatingArtworkOpen(false), [view, active]);
  useEffect(() => {
    readLibrary()
      .then((l) => {
        setLibrary(l);
        setReady(true);
      })
      .catch((e) => setFatal(errorText(e)));
    return () => request.current?.abort();
  }, []);
  useEffect(() => {
    if (!fatal || !desktop) return;
    void invoke<{ saved: number; conversations: number } | null>("library_backup_summary")
      .then((summary) => { setBackupSummary(summary); if (!summary) setBackupNotice("没有可用的本地备份。"); })
      .catch((error) => setBackupNotice(`备份不可用：${errorText(error)}`));
  }, [fatal]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      document.documentElement.dataset.theme =
        library.settings.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : library.settings.theme;
    };
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [library.settings.theme]);
  useEffect(() => {
    if (ready)
      writeLibrary(library).catch((e) => setPersistError(errorText(e)));
  }, [library, ready]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".fullscreen-viewer")) {
        setContext(null);
        setDetail(null);
        setShowSettings(false);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  const closeViewer = useCallback(() => {
    setViewerOpen(false);
    if (!viewerFromDetail.current) setDetail(null);
    if (desktop)
      void desktopFullscreen.current?.exit().catch(() => {});
    else if (document.fullscreenElement)
      void document.exitFullscreen().catch(() => {});
    browserFullscreen.current = false;
  }, []);
  function rememberViewed(art: Artwork) {
    setLibrary((current) => ({
      ...current,
      viewed: [art, ...current.viewed.filter((item) => item.id !== art.id)].slice(0, 50),
    }));
  }
  function viewArtwork(art: Artwork) {
    rememberViewed(art);
    setDetail(art);
  }
  useEffect(() => {
    const changed = () => {
      if (!document.fullscreenElement && browserFullscreen.current)
        closeViewer();
    };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, [closeViewer]);
  function openViewer(art: Artwork, fromDetail = false, arts?: Artwork[]) {
    if (!hasArtworkImage(art) && !savedFor(art.id)?.local) {
      viewArtwork(art);
      setContext(null);
      return;
    }
    viewerFromDetail.current = fromDetail;
    if (arts) setViewerArts(arts.filter((item) => hasArtworkImage(item) || !!savedFor(item.id)?.local));
    else if (!viewerArts.some((item) => item.id === art.id)) setViewerArts([art]);
    viewArtwork(art);
    setContext(null);
    setViewerOpen(true);
    if (desktop) {
      desktopFullscreen.current ??= new ViewerFullscreenController(getCurrentWindow());
      void desktopFullscreen.current.enter().catch(() => {});
    }
    else
      void document.documentElement
        .requestFullscreen()
        .then(() => {
          browserFullscreen.current = true;
        })
        .catch(() => {});
  }
  useEffect(() => {
    if (!desktop) return;
    const external = (event: MouseEvent) => {
      const link = (event.target as Element)?.closest?.("a[href]");
      if (link) {
        event.preventDefault();
        void invoke("open_external", { url: link.getAttribute("href") }).catch(
          (e) => setToast(errorText(e)),
        );
      }
    };
    document.addEventListener("click", external);
    return () => document.removeEventListener("click", external);
  }, []);
  useEffect(() => {
    if (!detail && !showSettings && !deleteId && !removeArt) return;
    const previous = document.activeElement as HTMLElement;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialogs = document.querySelectorAll(
        '[role="dialog"],[role="alertdialog"]',
      );
      const modal = dialogs[dialogs.length - 1];
      const items = modal?.querySelectorAll<HTMLElement>(
        "button:not(:disabled),a[href],input:not(:disabled),select,textarea",
      );
      if (!items?.length) return;
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const frame = requestAnimationFrame(() => {
      const dialogs = document.querySelectorAll(
        '[role="dialog"],[role="alertdialog"]',
      );
      dialogs[dialogs.length - 1]
        ?.querySelector<HTMLElement>("button:not(:disabled),input")
        ?.focus();
    });
    document.addEventListener("keydown", trap);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [!!detail, showSettings, deleteId, !!removeArt]);
  useEffect(() => {
    if (view === "chat")
      bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [current?.messages.length, busy, view]);
  useEffect(() => {
    if (!ready) return;
    discoverSeen.current = new Set(library.discoveryExposure?.ids || []);
    discoverArtistSeen.current = new Set(library.discoveryExposure?.artistKeys || []);
    discoverCultureSeen.current = new Set(library.discoveryExposure?.cultureKeys || []);
    discoverTypeSeen.current = new Set(library.discoveryExposure?.typeKeys || []);
    discoverArtists.current = library.discoveryExposure?.topics || [];
    discoverOffsets.current = library.discoveryExposure?.offsets || {};
    if (discoverScope.current !== library.settings.scope) {
      discoverScope.current = library.settings.scope;
      discoverArtists.current = [];
      discoverOffsets.current = {};
    }
    void refreshDiscovery();
    return () => discoverRequest.current?.abort();
  }, [ready, library.settings.scope, library.settings.discoveryRanking]);
  async function refreshDiscovery() {
    discoverRequest.current?.abort();
    const controller = new AbortController();
    discoverRequest.current = controller;
    setDiscoverLoading(true);
    setDiscoverError("");
    try {
      const result = await discoverArt(
        library.settings.scope,
        discoverArtists.current,
        discover.map((art) => art.id),
        discoverSeen.current,
        discoverOffsets.current,
        controller.signal,
        discoverArtistSeen.current,
        discoverCultureSeen.current,
        discoverTypeSeen.current,
        library.settings.discoveryRanking !== false,
      );
      if (controller.signal.aborted) return;
      if (!result.artworks.length) {
        setDiscoverError("这组主题暂时没有可展示的作品，请再刷新一次。");
      } else {
        discoverArtists.current = result.artists;
        setDiscoverCoverage(result.coverage);
        discoverOffsets.current = result.offsets;
        result.artworks.forEach((art) => discoverSeen.current.add(art.id));
        result.artworks.forEach((art) => {
          const key = art.artist.trim().toLocaleLowerCase();
          if (key && key !== "艺术家未标注") discoverArtistSeen.current.add(key);
          const culture = art.facets?.culture?.value.trim().toLocaleLowerCase();
          const type = art.facets?.objectType?.value.trim().toLocaleLowerCase();
          if (culture) discoverCultureSeen.current.add(culture);
          if (type) discoverTypeSeen.current.add(type);
        });
        setLibrary((current) => ({ ...current, discoveryExposure: {
          ids: [...new Set([...(current.discoveryExposure?.ids || []), ...result.artworks.map((art) => art.id)])].slice(-500),
          artistKeys: [...new Set([...(current.discoveryExposure?.artistKeys || []), ...result.artworks.map((art) => art.artist.trim().toLocaleLowerCase()).filter((key) => key && key !== "艺术家未标注")])].slice(-200),
          cultureKeys: [...new Set([...(current.discoveryExposure?.cultureKeys || []), ...result.artworks.map((art) => art.facets?.culture?.value.trim().toLocaleLowerCase()).filter((key): key is string => !!key)])].slice(-200),
          typeKeys: [...new Set([...(current.discoveryExposure?.typeKeys || []), ...result.artworks.map((art) => art.facets?.objectType?.value.trim().toLocaleLowerCase()).filter((key): key is string => !!key)])].slice(-200),
          topics: result.artists, offsets: result.offsets,
        } }));
        setDiscover(result.artworks);
        setDiscoverError(result.warning);
      }
    } catch (error) {
      if (!controller.signal.aborted) setDiscoverError(errorText(error));
    } finally {
      if (!controller.signal.aborted) setDiscoverLoading(false);
    }
  }
  const savedFor = (id: number) =>
    library.saved.find((s) => s.artwork.id === id);
  const collectionGroups = [...new Set(library.saved.map((item) => item.collectionGroup?.trim()).filter((name): name is string => !!name))].sort();
  function updateConversation(
    id: string,
    fn: (c: Conversation) => Conversation,
  ) {
    setLibrary((l) => ({
      ...l,
      conversations: l.conversations.map((c) => (c.id === id ? fn(c) : c)),
    }));
  }
  function openArtworkChat(art: Artwork) {
    if (busy) return;
    const existing = library.conversations.find(
      (conversation) =>
        conversation.kind === "artwork" && conversation.artwork?.id === art.id,
    );
    const id = existing?.id || crypto.randomUUID();
    const intro = localArtworkIntroduction(art);
    const replaceIntro =
      !!existing &&
      existing.messages.length === 1 &&
      /^(我们来慢慢看|先来认识)/.test(existing.messages[0].text);
    const introId = !existing
      ? crypto.randomUUID()
      : replaceIntro
        ? existing.messages[0].id
        : null;
    if (!existing) {
      const greeting: Message = {
        id: introId || crypto.randomUUID(),
        role: "assistant",
        text: intro,
      };
      setLibrary((value) => ({
        ...value,
        conversations: [
          {
            id,
            title: `《${art.title}》的讲解`,
            updated: Date.now(),
            kind: "artwork",
            artwork: art,
            messages: [greeting],
          },
          ...value.conversations,
        ],
      }));
    } else if (replaceIntro) {
      updateConversation(id, (conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) =>
          message.id === introId ? { ...message, text: intro } : message,
        ),
      }));
    }
    if (viewerOpen) closeViewer();
    setDetail(null);
    setContext(null);
    setActive(id);
    setInput("");
    setView("chat");
    if (introId && library.settings.useAi && desktop)
      void introduceArtwork(art, id, introId);
  }
  async function introduceArtwork(art: Artwork, id: string, introId: string) {
    setBusy(true);
    setPhase("正在准备作品导览…");
    const controller = new AbortController();
    request.current = controller;
    try {
      const reply = await explainArtwork(
        art,
        artworkIntroductionPrompt,
        [],
        library.settings,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      updateConversation(id, (conversation) => ({
        ...conversation,
        updated: Date.now(),
        messages: conversation.messages.map((message) =>
          message.id === introId
            ? { ...message, text: reply.usedImage ? reply.text : `当前模型未读取图片，以下导览依据馆藏资料。\n${reply.text}` }
            : message,
        ),
      }));
    } catch (error) {
      if (!controller.signal.aborted)
        updateConversation(id, (conversation) => ({
          ...conversation,
          messages: conversation.messages.map((message) =>
            message.id === introId
              ? { ...message, text: `${localArtworkIntroduction(art)}\n\nAI 导览暂不可用：${errorText(error)}` }
              : message,
          ),
        }));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  async function sendArtwork(text: string) {
    const conversation = current;
    const question = text.trim();
    if (!conversation?.artwork || !question || busy || !ready) return;
    setInput("");
    setBusy(true);
    setPhase("正在讲解这幅作品…");
    const controller = new AbortController();
    request.current = controller;
    const id = conversation.id;
    const history = conversation.messages;
    updateConversation(id, (c) => ({
      ...c,
      updated: Date.now(),
      messages: [
        ...c.messages,
        { id: crypto.randomUUID(), role: "user", text: question },
      ],
    }));
    try {
      if (!library.settings.useAi)
        throw new Error(
          "请先在偏好中开启 AI 并配置模型，即可围绕这幅画持续提问。",
        );
      const reply = await explainArtwork(
        conversation.artwork,
        question,
        history,
        library.settings,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      updateConversation(id, (c) => ({
        ...c,
        updated: Date.now(),
        messages: [
          ...c.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: reply.usedImage
              ? reply.text
              : `当前模型未读取图片，以下讲解依据馆藏资料和对话。\n${reply.text}`,
          },
        ],
      }));
    } catch (error) {
      if (!controller.signal.aborted)
        updateConversation(id, (c) => ({
          ...c,
          messages: [
            ...c.messages,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              text: errorText(error),
              error: true,
            },
          ],
        }));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  async function send(
    value = input,
    chosen?: { query: string; scope?: Settings["scope"] },
    similarTo?: Artwork,
    edited?: { source: Message; query: string; criteria: SearchCriteria },
    branch?: { plan: BranchPlan; parent: NonNullable<Conversation["parent"]> },
  ) {
    const text = value.trim();
    if (!text || busy || !ready) return;
    if (!similarTo && view === "chat" && current?.kind === "artwork")
      return sendArtwork(text);
    setInput("");
    setView("chat");
    setBusy(true);
    setPhase(
      library.settings.useAi ? "策展人正在理解你的想法…" : "正在寻找馆藏…",
    );
    const controller = new AbortController();
    request.current = controller;
    let previewResponseId: string | undefined;
    const continueExisting =
      !similarTo && !!active && current?.kind !== "artwork";
    const id = continueExisting ? active! : crypto.randomUUID();
    const contextMessage: Message | null = similarTo
      ? {
          id: crypto.randomUUID(),
          role: "assistant",
          text: branch?.plan.request || `以《${similarTo.title}》（${similarTo.artist}，${similarTo.date}）为参照，比较艺术风格并寻找可核对的开放馆藏作品。`,
          artworks: [similarTo],
        }
      : null;
    const history = continueExisting
      ? current?.messages || []
      : contextMessage
        ? [contextMessage]
        : [];
    setActive(id);
    const user: Message = { id: crypto.randomUUID(), role: "user", text };
    if (!continueExisting)
      setLibrary((l) => ({
        ...l,
        conversations: [
          {
            id,
            title: text.slice(0, 40),
            updated: Date.now(),
            parent: branch?.parent,
            messages: [...history, user],
          },
          ...l.conversations,
        ],
      }));
    else
      updateConversation(id, (c) => ({
        ...c,
        updated: Date.now(),
        messages: [...c.messages, user],
      }));
    try {
      const plan: Plan = edited
        ? { action: "search", query: edited.query, targetArtist: edited.source.targetArtist,
            artistAliases: edited.source.artistAliases, identityCandidates: edited.source.identityCandidates,
            criteria: edited.criteria, explanation: "按直接修订的条件重新检索。" }
        : branch
        ? { action: "search", query: branch.plan.query, criteria: branch.plan.criteria,
            explanation: `沿“${branch.plan.label}”方向寻找候选，关联性仍需复核。` }
        : chosen
        ? {
            query: chosen.query,
            targetArtist: chosen.query,
            action: "search",
            explanation: "已按你选择的画家名称重新检索开放馆藏。",
          }
        : await planSearch(
            text,
            history,
            library.settings,
            "",
            controller.signal,
          );
      if (controller.signal.aborted) return;
      if (!chosen && !edited && !branch && isRecommendationRequest(text) && !library.settings.useAi) {
        updateConversation(id, (c) => ({
          ...c,
          messages: [
            ...c.messages,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              text: plan.explanation,
              artworks: [],
            },
          ],
        }));
        return;
      }
      if (plan.action === "discuss") {
        setPhase("策展人正在结合刚才的作品回答…");
        const reply = await replyFromResults(text, history, library.settings, controller.signal);
        if (controller.signal.aborted) return;
        updateConversation(id, (c) => ({ ...c, messages: [...c.messages, { id: crypto.randomUUID(), role: "assistant", text: reply }] }));
        return;
      }
      const present = async (result: { artworks: Artwork[]; webResults: WebResult[]; warning: string; scope: Settings["scope"]; offsets?: Message["providerOffsets"]; suggestions?: ArtistSuggestion[]; failed?: boolean; queries?: string[]; diagnostics?: Message["retrievalDiagnostics"] }, existingResponseId?: string) => {
        const responseId = existingResponseId || crypto.randomUUID();
        const needsReview = library.settings.useAi && desktop && (result.artworks.length > 0 || result.webResults.length > 0);
        const previousIntent = [...history].reverse().find((item) => item.exploreIntent)?.exploreIntent;
        const exploreIntent = buildExploreIntent({ request: text, query: plan.query, targetArtist: plan.targetArtist, criteria: plan.criteria,
          previous: continueExisting ? previousIntent : undefined, anchorWorkKeys: similarTo ? [similarTo.recordKey || `${similarTo.provider || "commons"}:${similarTo.id}`] : [],
          relation: branch?.plan.relation });
        const message: Message = { id: responseId, role: "assistant", text: needsReview ? "已搜到候选，正在逐件复核资料与缩略图…" : "正在整理搜索结果…", error: result.failed,
          artworks: result.artworks, webResults: result.webResults, searchWarning: result.warning,
          query: plan.query, targetArtist: plan.targetArtist, artistAliases: plan.artistAliases,
          identityCandidates: plan.identityCandidates,
          searchCriteria: plan.criteria, exploreIntent, originalRequest: text, searchQueries: result.queries || [plan.query],
          retrievalDiagnostics: result.diagnostics,
          reviewPending: needsReview, scope: result.scope, providerOffsets: result.offsets, suggestions: result.suggestions };
        if (controller.signal.aborted) return;
        // Save all candidates before review; the main wall waits for review to finish.
        updateConversation(id, (c) => ({ ...c, messages: c.messages.some((m) => m.id === responseId)
          ? c.messages.map((m) => m.id === responseId ? message : m) : [...c.messages, message] }));
        let selected = { artworks: result.artworks, webResults: result.webResults, rejectedArtworks: [] as Artwork[], rejectedWebResults: [] as WebResult[], warning: "" };
        if (needsReview) {
          try { selected = await reviewCandidates(text, history, plan, result.artworks, result.webResults, library.settings, controller.signal, setPhase); }
          catch (error) {
            if (controller.signal.aborted) return;
            const unknown: CandidateReview = { verdict: "uncertain", reason: "复核暂不可用，保留待核实。", confidence: 0, basis: "unavailable", imageProvided: false, pageRead: false };
            selected = { ...selected, artworks: result.artworks.map((art) => ({ ...art, review: unknown })), webResults: result.webResults.map((item) => ({ ...item, review: unknown })), warning: `复核暂不可用：${errorText(error)}` };
          }
        }
        if (needsReview && result.artworks.length && !selected.artworks.length && result.diagnostics) {
          setPhase("首批候选均未通过复核，正在预算内补查另一馆藏…");
          try {
            const supplemental = await supplementAfterRejection({ query: plan.query, settings: library.settings,
              constraints: plan, diagnostics: result.diagnostics, signal: controller.signal });
            if (supplemental) {
              result.diagnostics = supplemental.diagnostics;
              result.offsets = { ...result.offsets, ...supplemental.offsets };
              result.warning = [result.warning, supplemental.warning].filter(Boolean).join(" ");
              if (supplemental.artworks.length) {
                const extra = await reviewCandidates(text, history, plan, supplemental.artworks, [], library.settings,
                  controller.signal, setPhase, 0);
                selected = { artworks: extra.artworks, webResults: selected.webResults,
                  rejectedArtworks: [...selected.rejectedArtworks, ...extra.rejectedArtworks],
                  rejectedWebResults: selected.rejectedWebResults,
                  warning: [selected.warning, extra.warning].filter(Boolean).join(" ") };
              }
            }
          } catch (error) {
            if (controller.signal.aborted) return;
            result.warning = [result.warning, `补查暂不可用：${errorText(error)}`].filter(Boolean).join(" ");
          }
        }
        if (controller.signal.aborted) return;
        const uncertain = selected.artworks.filter((art) => art.review?.verdict === "uncertain").length;
        const removed = selected.rejectedArtworks.length + selected.rejectedWebResults.length;
        const fallback = result.failed ? "搜索服务暂时不可用，尚未取得匹配结果。请稍后重新尝试。" : selected.artworks.length
          ? `${needsReview ? "复核后保留" : "找到"} ${selected.artworks.length} 件馆藏作品${uncertain ? `，其中 ${uncertain} 件待核实` : ""}。可以按下方顺序继续提问。`
          : selected.webResults.length ? "本次未找到符合条件的馆藏作品。下方保留相关或待核实的网页线索，作者归属与授权仍需核实。"
          : removed ? `本次候选中有 ${removed} 项被判为明显不符，已移入复核记录。没有用其他作品补齐。`
          : "当前接入来源未找到符合条件的作品。可在 Google 图片中继续找，或调整检索条件。";
        const warning = [result.warning, selected.warning].filter(Boolean).join(" ");
        updateConversation(id, (c) => ({ ...c, messages: c.messages.map((m) => m.id === responseId ? {
          ...m, text: fallback, artworks: selected.artworks, webResults: selected.webResults,
          rejectedArtworks: selected.rejectedArtworks, rejectedWebResults: selected.rejectedWebResults,
          reviewPending: false, reviewCompleted: needsReview, searchWarning: warning,
          retrievalDiagnostics: result.diagnostics, providerOffsets: result.offsets,
        } : m) }));
        if (library.settings.useAi && desktop) {
          setPhase("策展人正在根据复核后的结果回答…");
          let reply: CuratorReply;
          try {
            reply = await curateResults(text, history, library.settings, controller.signal, {
              query: plan.query, targetArtist: plan.targetArtist, criteria: plan.criteria, artworks: selected.artworks,
              webResults: selected.webResults, warning,
              rejected: [...selected.rejectedArtworks, ...selected.rejectedWebResults].map((item) => ({ title: item.title, reason: item.review?.reason || "" })),
            });
          } catch (error) {
            if (controller.signal.aborted) return;
            reply = { text: `${fallback}\n\nAI 结果解读暂不可用：${errorText(error)}`, reasons: {} };
          }
          if (controller.signal.aborted) return;
          updateConversation(id, (c) => ({ ...c, messages: c.messages.map((m) => m.id === responseId ? { ...m, text: reply.text, artworks: m.artworks?.map((art) => ({ ...art, curatorReason: reply.reasons[String(art.id)] })) } : m) }));
        }
      };
      if (plan.recommendations?.length) {
        setPhase("正在核对推荐画家的实际作品…");
        const providerPairs = [["commons", "cleveland"], ["chicago", "met"], ["commons", "chicago"]] as const;
        const checked = await Promise.all(plan.recommendations.slice(0, 3).map(async (candidate, index) => ({
          candidate,
          result: await searchForCurator(candidate.query, { ...library.settings, webSearch: false }, controller.signal,
            { targetArtist: candidate.query, artistAliases: [candidate.nameZh, candidate.nameEn], providers: providerPairs[index], allowScopeFallback: false }),
        })));
        if (controller.signal.aborted) return;
        const artworks = checked.flatMap((item) => item.result.artworks.slice(0, 4).map((art) => ({ ...art, selectionReason: `风格推荐 ${item.candidate.nameZh}：${item.candidate.reason.slice(0, 45)}；已核对作者。` }))).filter((art, index, all) => all.findIndex((other) => other.id === art.id) === index);
        const webResults = checked.flatMap((item) => item.result.webResults.slice(0, 3)).filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index);
        await present({ artworks, webResults, warning: checked.map((item) => `${item.candidate.nameEn}：${item.candidate.reason} ${item.result.warning} ${!item.result.artworks.length ? "本次无作者匹配的馆藏作品。" : ""}`).join("\n"),
          scope: library.settings.scope,
          suggestions: checked.filter((item) => item.result.artworks.length).map((item) => ({ ...item.candidate, scope: item.result.scope })),
        });
        return;
      }
      setPhase("正在搜索馆藏与作品来源…");
      previewResponseId = crypto.randomUUID();
      const previewId = previewResponseId;
      updateConversation(id, (c) => ({ ...c, messages: [...c.messages, {
        id: previewId, role: "assistant", text: "正在从各馆藏搜集候选…", query: plan.query,
        artworks: [], reviewPending: true,
      }] }));
      const result = await runCuratorSearch({ query: plan.query, alternativeQueries: plan.alternativeQueries,
        settings: { ...library.settings, scope: chosen?.scope || library.settings.scope }, constraints: plan,
        signal: controller.signal, desktop, onPhase: setPhase,
        onCandidatePreview: (artworks) => {
          if (controller.signal.aborted) return;
          updateConversation(id, (c) => ({ ...c, messages: c.messages.map((m) => {
            if (m.id !== previewId || !m.reviewPending) return m;
            const existing = new Set((m.artworks || []).map((art) => art.recordKey || art.id));
            const additions = artworks.filter((art) => !existing.has(art.recordKey || art.id));
            return { ...m, text: "已有馆藏返回候选，其他来源仍在查找；作品尚未复核。",
              artworks: [...(m.artworks || []), ...additions] };
          }) }));
        } });
      if (controller.signal.aborted) return;
      plan.query = result.query;
      await present({ ...result, warning: [result.warning, plan.identityWarning].filter(Boolean).join(" ") }, previewId);

    } catch (e) {
      if (!controller.signal.aborted) {
        const pendingId = previewResponseId;
        const uncertain: CandidateReview = { verdict: "uncertain", reason: "检索中断，候选尚未核实。", confidence: 0,
          basis: "unavailable", imageProvided: false, pageRead: false };
        updateConversation(id, (c) => ({ ...c, messages: pendingId && c.messages.some((m) => m.id === pendingId)
          ? c.messages.map((m) => m.id === pendingId ? { ...m, text: `检索中断：${errorText(e)}。已返回的候选保留待核实。`,
            error: true, reviewPending: false, artworks: m.artworks?.map((art) => ({ ...art, review: uncertain })) } : m)
          : [...c.messages, { id: crypto.randomUUID(), role: "assistant", text: errorText(e), error: true }] }));
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  function stop() {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    const stoppedReview: CandidateReview = { verdict: "uncertain", reason: "复核已停止，尚未确认。", confidence: 0, basis: "unavailable", imageProvided: false, pageRead: false };
    if (active)
      updateConversation(active, (c) => ({
        ...c,
        messages: [
          ...c.messages.map((message) => message.reviewPending ? { ...message, reviewPending: false, reviewCompleted: false,
            text: "复核已停止，以下候选保留为待核实。",
            artworks: message.artworks?.map((art) => ({ ...art, review: stoppedReview })),
          } : message.pageReviewPending ? { ...message, pageReviewPending: false,
            artworks: [...(message.artworks || []), ...(message.pendingPageArtworks || []).map((art) => ({ ...art, review: stoppedReview }))],
            pendingPageArtworks: undefined,
            searchWarning: [message.searchWarning, "分页复核已停止；新增候选保留为待核实。"].filter(Boolean).join(" "),
          } : message),
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text:
              current?.kind === "artwork"
                ? "这次讲解已停止，随时可以接着问。"
                : "本次搜集已停止。你可以换个角度继续探索。",
          },
        ],
      }));
  }
  async function more(message: Message) {
    if (!current || busy || (message.offset === undefined && !Object.keys(message.providerOffsets || {}).length)) return;
    const id = current.id;
    setBusy(true);
    setPhase("继续搜集作品…");
    const controller = new AbortController();
    request.current = controller;
    try {
      const r = await runContinuationSearch({ query: message.query!, scope: message.scope || library.settings.scope,
        offsets: message.providerOffsets, legacyOffset: message.offset, rotation: message.continuationRotation,
        targetArtist: message.targetArtist, artistAliases: message.artistAliases, criteria: message.searchCriteria,
        signal: controller.signal });
      if (controller.signal.aborted) return;
      const newArtworks = r.artworks.filter((art) => ![...(message.artworks || []), ...(message.rejectedArtworks || [])].some((old) => old.id === art.id));
      const needsReview = library.settings.useAi && desktop && newArtworks.length > 0;
      if (needsReview) updateConversation(id, (c) => ({ ...c, messages: c.messages.map((m) => m.id === message.id
        ? { ...m, pageReviewPending: true, pendingPageArtworks: newArtworks } : m) }));
      let reviewed: { artworks: Artwork[]; rejectedArtworks: Artwork[]; warning: string } = { artworks: newArtworks, rejectedArtworks: [], warning: "" };
      if (needsReview) {
        try {
          reviewed = await reviewCandidates(message.originalRequest || message.query || "继续寻找", current.messages,
            { query: message.query || "", explanation: "继续检索", targetArtist: message.targetArtist, artistAliases: message.artistAliases, criteria: message.searchCriteria },
            newArtworks, [], library.settings, controller.signal, setPhase);
        } catch (error) {
          if (controller.signal.aborted) return;
          const unknown: CandidateReview = { verdict: "uncertain", reason: "分页复核暂不可用，保留待核实。", confidence: 0, basis: "unavailable", imageProvided: false, pageRead: false };
          reviewed = { artworks: newArtworks.map((art) => ({ ...art, review: unknown })), rejectedArtworks: [], warning: `分页复核暂不可用：${errorText(error)}` };
        }
      }
      if (controller.signal.aborted) return;
      updateConversation(id, (c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === message.id
            ? {
                ...m,
                artworks: [
                  ...(m.artworks || []),
                  ...reviewed.artworks.map((art) => ({ ...art, selectionReason: art.selectionReason || `继续检索“${message.query?.slice(0, 40)}”返回的候选。` })),
                ],
                rejectedArtworks: [...(m.rejectedArtworks || []), ...reviewed.rejectedArtworks],
                pageReviewPending: false,
                pendingPageArtworks: undefined,
                reviewCompleted: m.reviewCompleted || (library.settings.useAi && desktop && newArtworks.length > 0),
                searchWarning: [m.searchWarning, r.warning, reviewed.warning].filter(Boolean).join(" "),
                offset: r.legacyOffset,
                providerOffsets: r.offsets,
                continuationRotation: r.rotation,
                continuationRuns: [...(m.continuationRuns || []), r.diagnostics].slice(-12),
              }
            : m,
        ),
      }));
    } catch (e) {
      if (!controller.signal.aborted) setToast(errorText(e));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  async function save(art: Artwork) {
    const existing = savedFor(art.id);
    if (!art.original) {
      if (!existing) setLibrary((l) => ({ ...l, saved: [{ artwork: art, local: "", savedAt: Date.now() }, ...l.saved] }));
      setToast(existing ? "这条馆藏资料已在画架上" : "馆藏资料已收入画架；来源暂未提供可下载原图。");
      return;
    }
    if (existing && isOriginalLocal(existing.local)) {
      setToast(`这件作品的${fullImageLabel(art)}已经在画架上`);
      return;
    }
    if (saving.includes(art.id)) return;
    setSaving((s) => [...s, art.id]);
    if (!existing) {
      setLibrary((l) => ({
        ...l,
        saved: l.saved.some((s) => s.artwork.id === art.id)
          ? l.saved
          : [{ artwork: art, local: "", savedAt: Date.now() }, ...l.saved],
      }));
    }
    try {
      const local = await cacheArtwork(art.id, art.original, "collection");
      setLibrary((l) => ({
        ...l,
        saved: l.saved.some((s) => s.artwork.id === art.id)
          ? l.saved.map((s) =>
              s.artwork.id === art.id
                ? { ...s, artwork: art, local, savedAt: Date.now() }
                : s,
            )
          : [{ artwork: art, local, savedAt: Date.now() }, ...l.saved],
      }));
      setHd((h) => {
        const next = { ...h };
        delete next[art.id];
        return next;
      });
      setToast(
        existing
          ? art.provider === "cleveland" ? "画架作品已升级为馆方高清 JPEG" : "画架作品已升级为原始分辨率"
          : art.provider === "cleveland" ? "已收入画架 · 馆方高清 JPEG 已保存在本地" : "已收入画架 · 原图已保存在本地",
      );
    } catch (e) {
      setToast(`作品已在画架；${fullImageLabel(art)}暂未下载：${errorText(e)} 可稍后在画架中重试。`);
    } finally {
      setSaving((s) => s.filter((id) => id !== art.id));
    }
  }
  async function loadHd(art: Artwork) {
    if (!hasArtworkImage(art)) {
      setToast("馆藏来源暂未提供图片；可以查看来源资料。");
      return;
    }
    setDetail(art);
    setContext(null);
    setHdBusy(true);
    try {
      const url = await highResolution(art);
      let displayUrl = url;
      if (desktop || savedFor(art.id)) {
        const local = await cacheArtwork(art.id, url, "hd");
        if (desktop) displayUrl = await localImage(local);
        setLibrary((l) => ({
          ...l,
          saved: l.saved.map((s) =>
            s.artwork.id === art.id && !isOriginalLocal(s.local)
              ? { ...s, local, savedAt: Date.now() }
              : s,
          ),
        }));
      }
      setHd((h) => ({ ...h, [art.id]: displayUrl }));
      setToast("高清版本已加载 · 最长边 2400px");
    } catch (e) {
      setToast(errorText(e));
    } finally {
      setHdBusy(false);
    }
  }
  function newChat() {
    if (busy) return;
    setActive(null);
    setView("chat");
    setInput("");
    setFilter("");
  }
  function exploreFromArtwork(art: Artwork, relation: BranchPlan["relation"]) {
    if (busy) return;
    const plan = planArtworkBranch(art, relation);
    const source = [...(current?.messages || [])].reverse().find((message) => message.artworks?.some((item) => item.id === art.id));
    const parent: NonNullable<Conversation["parent"]> = { view, conversationId: view === "chat" ? active || undefined : undefined,
      messageId: source?.id, scrollY: window.scrollY, relation };
    setContext(null);
    void send(plan.request, undefined, art, undefined, { plan, parent });
  }
  function returnToParent(parent: NonNullable<Conversation["parent"]>) {
    if (busy) return;
    const available = parent.conversationId && library.conversations.some((conversation) => conversation.id === parent.conversationId);
    setActive(available ? parent.conversationId! : null);
    setView(available ? "chat" : parent.view === "chat" ? "discover" : parent.view);
    requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: parent.scrollY || 0 })));
  }
  function cards(arts: Artwork[], showSimilar = false, numbered = false) {
    return (
      <div className="gallery-grid">
        {arts.map((art, index) => (
          <ArtCard
            key={art.id}
            art={art}
            position={numbered ? index + 1 : undefined}
            saved={savedFor(art.id)}
            pending={saving.includes(art.id)}
            onOpen={() => openViewer(art, false, arts)}
            onSave={() => void save(art)}
            onSimilar={
              showSimilar
                ? () =>
                    void send(
                      `推荐与《${art.title}》风格相似的画作`,
                      undefined,
                      art,
                    )
                : undefined
            }
            onContext={(x, y) => {
              setViewerArts(arts.filter((item) => hasArtworkImage(item) || !!savedFor(item.id)?.local));
              setContext({
                art,
                x: Math.min(x, window.innerWidth - 250),
                y: Math.max(8, Math.min(y, window.innerHeight - 350)),
              });
            }}
          />
        ))}
      </div>
    );
  }
  function composer() {
    return (
      <form
        className="composer"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="composer-inner">
          <Sparkles size={19} />
          <textarea
            aria-label="向策展人描述想看的画作"
            placeholder={
              current?.kind === "artwork"
                ? "继续问这幅画：技法、构图、时代背景，或你注意到的细节…"
                : "描述你想遇见的艺术，比如：想看一些安静的、蓝色的风景…"
            }
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {busy ? (
            <button
              type="button"
              className="send-button"
              title="停止搜集"
              aria-label="停止搜集"
              onClick={stop}
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              className="send-button"
              disabled={!input.trim() || !ready}
              aria-label="发送"
            >
              <ArrowUp size={20} />
            </button>
          )}
        </div>
        <div className="composer-footer">
          <span>
            <span
              className={`status-dot ${library.settings.useAi ? "ai" : ""}`}
            />
            {current?.kind === "artwork"
              ? "作品讲解模式"
              : library.settings.useAi
                ? "AI 策展模式"
                : "直接检索模式"}
            <button type="button" onClick={() => setShowSettings(true)}>
              配置
            </button>
          </span>
          <span>
            {current?.kind === "artwork"
              ? "讲解可持续追问 · 模型会接收作品缩略图"
              : "缩略图优先 · 右键加载高清"}
          </span>
        </div>
      </form>
    );
  }
  if (fatal)
    return (
      <div className="startup-error">
        <h1>资料库暂时无法打开</h1>
        <p>{fatal}</p>
        <button onClick={() => location.reload()}>重新加载</button>
        <p>为保护原始文件，应用没有创建新资料覆盖它。</p>
        {backupSummary && <div>
          <p>找到上一次有效备份：{backupSummary.saved} 件收藏、{backupSummary.conversations} 个会话。恢复会保留目前损坏的文件副本，但备份可能缺少最近一次修改。</p>
          <button disabled={restoringBackup} onClick={() => {
            if (!window.confirm("确认从上一次有效备份恢复？当前损坏文件会另存保留，最近一次修改可能不在备份中。")) return;
            setRestoringBackup(true);
            void invoke<string>("restore_library_backup")
              .then((archived) => {
                setBackupNotice(`备份已恢复。${archived ? `原文件保存在：${archived}。` : "原资料库文件不存在。"}请重新加载应用。`);
                setBackupSummary(null);
              })
              .catch((error) => setBackupNotice(`恢复失败，原资料库未被覆盖：${errorText(error)}`))
              .finally(() => setRestoringBackup(false));
          }}>{restoringBackup ? "正在恢复…" : "从备份恢复资料库"}</button>
        </div>}
        {backupNotice && <p role="status">{backupNotice}</p>}
      </div>
    );
  return (
    <div className="app-shell" onClick={() => context && setContext(null)}>
      <aside className="sidebar">
        <button className="brand" onClick={() => setView("discover")}>
          <span className="brand-mark">拾</span>
          <span>
            拾色<small>ATELIER</small>
          </span>
        </button>
        <div className="sidebar-intro">把喜欢的艺术，留在身边。</div>
        <button className="new-chat" onClick={newChat} disabled={busy}>
          <Plus size={18} /> 开启一场艺术对话 <span>↗</span>
        </button>
        <nav>
          <button
            className={view === "discover" ? "active" : ""}
            onClick={() => setView("discover")}
          >
            <LayoutGrid size={18} />
            发现艺术<span>01</span>
          </button>
          <button
            className={view === "easel" ? "active" : ""}
            onClick={() => {
              setView("easel");
              setFilter("");
            }}
          >
            <Bookmark size={18} />
            我的画架<span>{String(library.saved.length).padStart(2, "0")}</span>
          </button>
          <button
            className={view === "viewed" ? "active" : ""}
            onClick={() => {
              setView("viewed");
              setFilter("");
            }}
          >
            <Clock3 size={18} />
            最近看过<span>{String(library.viewed.length).padStart(2, "0")}</span>
          </button>
          <button
            className={view === "history" ? "active" : ""}
            onClick={() => {
              setView("history");
              setFilter("");
            }}
          >
            <Clock3 size={18} />
            往日对话
          </button>
        </nav>
        <div className="sidebar-section">
          <span>最近的灵感</span>
          <MessageCircle size={13} />
        </div>
        <div className="recent-list">
          {library.conversations
            .filter((c) => c.kind !== "artwork")
            .slice(0, 5)
            .map((c) => (
              <button
                key={c.id}
                className={active === c.id && view === "chat" ? "selected" : ""}
                onClick={() => {
                  setActive(c.id);
                  setView("chat");
                }}
                disabled={busy && active !== c.id}
              >
                <span className="little-line" />
                {c.title}
              </button>
            ))}
          {!library.conversations.some((c) => c.kind !== "artwork") && (
            <p>
              每一段对话，
              <br />
              都是一场小小的私人展览。
            </p>
          )}
        </div>
        <div className="sidebar-section sidebar-artwork-section">
          <span>作品讲解</span>
          <ImageIcon size={13} />
        </div>
        <div className="recent-list explain-list">
          {library.conversations
            .filter((c) => c.kind === "artwork")
            .slice(0, 5)
            .map((c) => (
              <button
                key={c.id}
                className={active === c.id && view === "chat" ? "selected" : ""}
                onClick={() => {
                  setActive(c.id);
                  setView("chat");
                }}
                disabled={busy && active !== c.id}
              >
                <span className="little-line" />
                {c.artwork?.title || c.title}
              </button>
            ))}
          {!library.conversations.some((c) => c.kind === "artwork") && (
            <p>
              从一幅画开始，
              <br />
              聊得再久一点。
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="collection-note">
            <span className="tiny-sun">✳</span>
            <p>
              艺术不必遥远。
              <br />
              <em>Make room for wonder.</em>
            </p>
          </div>
          <button
            className="settings-nav"
            onClick={() => setShowSettings(true)}
          >
            <Settings2 size={17} />
            偏好与资料库<span>↗</span>
          </button>
          <div className="local-label">
            <span className="status-dot" />
            本地收藏 · 自在探索
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span className="breadcrumb">你的私人美术馆</span>
            <span className="crumb-slash">/</span>
            {view === "easel"
              ? "我的画架"
              : view === "viewed"
                ? "最近看过"
              : view === "history"
                ? "往日对话"
                : view === "chat"
                  ? current?.kind === "artwork"
                    ? "作品讲解"
                    : "灵感对话"
                  : "发现艺术"}
          </div>
          <div className="source-chip">
            <span className="status-dot" />
            Wikimedia · Cleveland · Chicago · Met
          </div>
        </header>
        {persistError && (
          <div className="error-banner" role="alert">
            保存失败：{persistError}{" "}
            <button
              onClick={() => {
                writeLibrary(library)
                  .then(() => setPersistError(""))
                  .catch((e) => setPersistError(errorText(e)));
              }}
            >
              重试保存
            </button>
          </div>
        )}
        <div className={`page-content ${view === "chat" ? "chat-page" : ""} ${floatingArtworkOpen && current?.kind === "artwork" ? "floating-open" : ""}`}>
          {view === "discover" && (
            <>
              <div className="eyebrow">A LITTLE ART, EVERY DAY</div>
              <section className="hero">
                <div>
                  <h1>
                    与艺术，
                    <br />
                    <span>不期而遇。</span>
                    <i>✳</i>
                  </h1>
                  <p>
                    从一段对话开始，发现世界馆藏里的动人之作。
                    <br />让 AI 为你寻画，为日常留一面艺术的墙。
                  </p>
                </div>
                <div className="hero-annotation">
                  <span>
                    THE ART OF
                    <br />
                    LOOKING CLOSER
                  </span>
                  <div className="annotation-line" />
                  <small>慢一点，看见更多。</small>
                </div>
              </section>
              {composer()}
              <div className="prompt-row">
                {prompts.map((p, i) => (
                  <button
                    className={`prompt-card ${p.color}`}
                    key={p.label}
                    disabled={busy}
                    onClick={() => void send(p.query)}
                  >
                    <span className="prompt-number">0{i + 1}</span>
                    <div>
                      <strong>{p.label}</strong>
                      <small>{p.sub}</small>
                    </div>
                    <ArrowRight size={17} />
                  </button>
                ))}
              </div>
              <section className="collection-section">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">THE CURATOR'S SELECTION</span>
                    <h2>
                      此刻，驻足 <span>精选馆藏</span>
                    </h2>
                  </div>
                  <button
                    className="text-button"
                    disabled={discoverLoading}
                    onClick={() => void refreshDiscovery()}
                  >
                    {discoverLoading ? "正在换一组" : "换一组画作"}{" "}
                    <RefreshCw
                      size={16}
                      className={discoverLoading ? "spin" : ""}
                    />
                  </button>
                </div>
                <div className="collection-toolbar">
                  <span>{discoverCoverage
                    ? `本组新见 ${discoverCoverage.newArtists} 位作者 · ${discoverCoverage.newCultures} 种文化标注 · ${discoverCoverage.newTypes} 种作品类型（缺失不计）`
                    : "跨越题材与媒材 · 发现不熟悉的画家"}</span>
                  <span>
                    WIKIMEDIA <span className="middle-dot">·</span> CLEVELAND <span className="middle-dot">·</span> CHICAGO
                  </span>
                </div>
                {discoverError && discover.length > 0 && (
                  <div className="error-banner" role="alert">
                    {discoverError}{" "}
                    <button onClick={() => void refreshDiscovery()}>
                      重试
                    </button>
                  </div>
                )}
                {discoverLoading && !discover.length ? (
                  <div className="skeleton-grid">
                    {[1, 2, 3].map((i) => (
                      <div className="skeleton" key={i} />
                    ))}
                  </div>
                ) : discoverError && !discover.length ? (
                  <div className="empty-state">
                    <ImageIcon />
                    <h3>馆藏正在远方</h3>
                    <p>{discoverError}</p>
                    <button onClick={() => void refreshDiscovery()}>
                      重新连接馆藏
                    </button>
                  </div>
                ) : discover.length ? (
                  cards(discover, true)
                ) : (
                  <div className="empty-state">
                    暂未找到作品，试试开始一段对话。
                  </div>
                )}
              </section>
              <footer className="page-footer">
                LOOK SLOWLY. FEEL DEEPLY.
                <span>每一幅画，都有值得停留的理由。</span>
              </footer>
            </>
          )}
          {view === "easel" && (
            <>
              <span className="eyebrow">YOUR PERSONAL COLLECTION</span>
              <div className="page-heading">
                <div>
                  <h1>
                    我的画架
                    <span className="count">{library.saved.length}</span>
                  </h1>
                  <p>留下心动的瞬间，慢慢看，常常看。</p>
                </div>
                <span className="offline-pill">
                  <Check size={14} /> {library.saved.some((s) => !isOriginalLocal(s.local)) ? "画架已保存 · 部分高清图待下载" : "本地图片 · 离线可看"}
                </span>
              </div>
              <label className="filter">
                <Search size={17} />
                <input
                  placeholder="寻找收藏的作品或艺术家"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </label>
              {collectionGroups.length > 0 && <div className="collection-groups" aria-label="画架主题筛选">
                <button className={!easelGroup ? "selected" : ""} onClick={() => setEaselGroup("")}>全部作品</button>
                {collectionGroups.map((group) => <button key={group} className={easelGroup === group ? "selected" : ""}
                  onClick={() => setEaselGroup(group)}>{group}</button>)}
                {easelGroup && <button disabled={busy} onClick={() => {
                  const examples = library.saved.filter((item) => item.collectionGroup === easelGroup).slice(0, 3);
                  if (!examples.length) return;
                  const clues = examples.map((item) => `《${item.artwork.title}》—${item.artwork.artist}${item.artwork.medium ? `（${item.artwork.medium}）` : ""}`).join("、");
                  const requestText = library.settings.useAi
                    ? `以我画架中“${easelGroup}”主题为线索，继续寻找相关但不重复的开放馆藏作品。参考收藏：${clues}。请避免只重复这些画家，也不要把主题名或私人笔记当成已核实的作品资料。`
                    : `寻找与“${easelGroup}”相关的其他画家作品`;
                  void send(requestText,
                    undefined, examples[0].artwork);
                }}>从此主题继续探索</button>}
                {easelGroup && <button className="remove-group" onClick={() => {
                  if (!window.confirm(`移除“${easelGroup}”分组？作品仍会留在画架。`)) return;
                  setLibrary((current) => ({ ...current, saved: current.saved.map((item) => item.collectionGroup === easelGroup
                    ? { ...item, collectionGroup: "" } : item) }));
                  setEaselGroup("");
                }}>移除当前分组（保留作品）</button>}
              </div>}
              {library.saved.length ? (
                cards(
                  library.saved
                    .filter((s) =>
                      (!easelGroup || s.collectionGroup === easelGroup) && `${s.artwork.title} ${s.artwork.artist} ${s.note || ""}`
                        .toLowerCase()
                        .includes(filter.toLowerCase()),
                    )
                    .map((s) => s.artwork),
                )
              ) : (
                <div className="empty-state large">
                  <Bookmark size={38} />
                  <h2>你的第一幅收藏，会是什么？</h2>
                  <p>在画作旁点击书签，将图片和作品资料一起保存。</p>
                  <button onClick={() => setView("discover")}>
                    去发现艺术 <ArrowRight size={16} />
                  </button>
                </div>
              )}
            </>
          )}
          {view === "viewed" && (
            <>
              <span className="eyebrow">RECENTLY VIEWED</span>
              <div className="page-heading">
                <div>
                  <h1>最近看过<span className="count">{library.viewed.length}</span></h1>
                  <p>最近打开的作品保存在本机，再看一眼也很方便。</p>
                </div>
              </div>
              {library.viewed.length ? (
                <>
                  <label className="filter">
                    <Search size={17} />
                    <input
                      placeholder="寻找看过的作品或艺术家"
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                    />
                  </label>
                  {cards(library.viewed.filter((art) =>
                    `${art.title} ${art.artist}`.toLowerCase().includes(filter.toLowerCase()),
                  ))}
                </>
              ) : (
                <div className="empty-state large">
                  <ImageIcon size={38} />
                  <h2>还没有浏览记录</h2>
                  <p>打开画作后，就能在这里找回最近看过的作品。</p>
                  <button onClick={() => setView("discover")}>去发现艺术 <ArrowRight size={16} /></button>
                </div>
              )}
            </>
          )}
          {view === "history" && (
            <>
              <span className="eyebrow">CONVERSATIONS, COLLECTED</span>
              <div className="page-heading">
                <div>
                  <h1>往日对话</h1>
                  <p>重访那些让你驻足的作品与灵感。</p>
                </div>
                <button
                  className="primary-button"
                  onClick={newChat}
                  disabled={busy}
                >
                  <Plus size={17} /> 新的对话
                </button>
              </div>
              <div
                className="history-tabs"
                role="tablist"
                aria-label="对话类型"
              >
                <button
                  role="tab"
                  aria-selected={historyKind === "inspiration"}
                  className={historyKind === "inspiration" ? "active" : ""}
                  onClick={() => setHistoryKind("inspiration")}
                >
                  灵感寻画{" "}
                  <span>
                    {
                      library.conversations.filter((c) => c.kind !== "artwork")
                        .length
                    }
                  </span>
                </button>
                <button
                  role="tab"
                  aria-selected={historyKind === "artwork"}
                  className={historyKind === "artwork" ? "active" : ""}
                  onClick={() => setHistoryKind("artwork")}
                >
                  作品讲解{" "}
                  <span>
                    {
                      library.conversations.filter((c) => c.kind === "artwork")
                        .length
                    }
                  </span>
                </button>
              </div>
              <label className="filter">
                <Search size={17} />
                <input
                  placeholder="搜索对话"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </label>
              <div className="history-list">
                {library.conversations
                  .filter(
                    (c) =>
                      (historyKind === "artwork"
                        ? c.kind === "artwork"
                        : c.kind !== "artwork") && c.title.includes(filter),
                  )
                  .map((c) => (
                    <article key={c.id}>
                      <button
                        disabled={busy && active !== c.id}
                        onClick={() => {
                          setActive(c.id);
                          setView("chat");
                        }}
                      >
                        {c.kind === "artwork" ? (
                          <ImageIcon size={22} />
                        ) : (
                          <MessageCircle size={22} />
                        )}
                        <div>
                          <h3>{c.title}</h3>
                          <p>
                            {new Date(c.updated).toLocaleDateString("zh-CN")} ·{" "}
                            {c.kind === "artwork"
                              ? `${c.messages.filter((m) => m.role === "user").length} 次提问`
                              : `${c.messages.reduce((n, m) => n + (m.artworks?.length || 0), 0)} 件作品`}
                          </p>
                        </div>
                        <ArrowRight size={18} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`删除对话 ${c.title}`}
                        disabled={busy}
                        onClick={() => setDeleteId(c.id)}
                      >
                        <Trash2 size={17} />
                      </button>
                    </article>
                  ))}
              </div>
              {!library.conversations.some((c) =>
                historyKind === "artwork"
                  ? c.kind === "artwork"
                  : c.kind !== "artwork",
              ) && (
                <div className="empty-state large">
                  <Clock3 size={38} />
                  <h2>
                    {historyKind === "artwork"
                      ? "还没有作品讲解"
                      : "灵感，从一句话开始"}
                  </h2>
                  <p>
                    {historyKind === "artwork"
                      ? "打开任意作品，右键选择“展开讲解对话”。"
                      : "你的寻画对话会自动保存在这里。"}
                  </p>
                  <button
                    onClick={
                      historyKind === "artwork"
                        ? () => setView("discover")
                        : newChat
                    }
                  >
                    {historyKind === "artwork" ? "去看画" : "开始探索"}
                  </button>
                </div>
              )}
            </>
          )}
          {view === "chat" && (
            <>
              <div className="chat-heading">
                <span className="eyebrow">
                  {current?.kind === "artwork"
                    ? "A CONVERSATION ABOUT ONE WORK"
                    : "A CONVERSATION WITH ART"}
                </span>
                <h1>{current?.title || "今天，想看些什么？"}</h1>
                <p>
                  {current?.kind === "artwork" ? (
                    "作品讲解 · 可持续追问"
                  ) : (
                    <>
                      多馆藏 · {library.settings.useAi ? "AI 策展" : "直接检索"} ·
                      缩略图优先
                    </>
                  )}
                </p>
              </div>
              {current?.kind === "artwork" && current.artwork && (
                <button
                  className="artwork-chat-context"
                  onClick={() => setFloatingArtworkOpen(true)}
                  aria-label={`打开 ${current.artwork.title} 的图片浮窗`}
                >
                  <ArtImage
                    art={current.artwork}
                    saved={savedFor(current.artwork.id)}
                  />
                  <span>
                    <small>正在讲解的作品 · 点击打开可拖动图片浮窗</small>
                    <strong>{current.artwork.title}</strong>
                    <em>
                      {current.artwork.artist} · {current.artwork.date}
                    </em>
                  </span>
                  <Maximize2 size={17} />
                </button>
              )}
              {!current && (
                <div className="chat-welcome">
                  <span className="big-sun">✳</span>
                  <h2>
                    不必懂艺术，
                    <br />
                    只要说出此刻的感受。
                  </h2>
                  <p>一种颜色、一位艺术家，或是一场想象中的旅行。</p>
                  {prompts.map((p) => (
                    <button key={p.label} onClick={() => void send(p.query)}>
                      {p.label}
                      <ArrowRight size={16} />
                    </button>
                  ))}
                </div>
              )}
              {current?.parent && <button className="intent-edit-button" disabled={busy} onClick={() => returnToParent(current.parent!)}>
                ← 返回{current.parent.conversationId ? "上一级对话" : "原展墙"}
              </button>}
              {current?.messages.map((m) => (
                <section
                  key={m.id}
                  className={`message ${m.role} ${m.error ? "message-error" : ""}`}
                >
                  {m.role === "assistant" && (
                    <div className="curator-label">
                      <span>拾</span> 拾色策展人{" "}
                      <small>{m.error ? "连接遇到问题" : "CURATOR"}</small>
                    </div>
                  )}
                  <p
                    className="message-text"
                    style={current?.kind === "artwork" && m.role === "assistant" && !m.error
                      ? { fontSize: `${library.settings.explanationFontSize}px` }
                      : undefined}
                  >{m.text}</p>
                  {!!m.suggestions?.length && (
                    <div
                      className="artist-suggestions"
                      aria-label="可能的画家姓名"
                    >
                      {m.suggestions.map((candidate) => (
                        <button
                          key={`${m.id}-${candidate.query}`}
                          disabled={busy}
                          onClick={() =>
                            void send(
                              `查找${candidate.nameZh}（${candidate.nameEn}）的画作`,
                              candidate,
                            )
                          }
                        >
                          <span>
                            <strong>{candidate.nameZh}</strong>
                            <small>
                              {candidate.nameEn} ·{" "}
                              {candidate.scope === "commons"
                                ? "全部 Commons"
                                : "Google Art Project"}
                            </small>
                          </span>
                          <span className="suggestion-reason">
                            {candidate.reason}
                          </span>
                          <ArrowRight size={16} />
                        </button>
                      ))}
                    </div>
                  )}
                  {!!m.identityCandidates?.length && (
                    <div className="artist-suggestions" aria-label="同名艺术家身份线索">
                      {m.identityCandidates.map((candidate) => (
                        <button key={`${m.id}-${candidate.id}`} disabled={busy}
                          onClick={() => setInput(`我指的是 ${candidate.label}（${candidate.description}，Wikidata ${candidate.id}），请继续找他的作品`)}>
                          <span><strong>{candidate.label}</strong><small>{candidate.id} · 身份线索，馆藏归属仍需核对</small></span>
                          <span className="suggestion-reason">{candidate.description}</span>
                          <ArrowRight size={16} />
                        </button>
                      ))}
                    </div>
                  )}
                  {m.role === "assistant" &&
                    !m.error &&
                    m.artworks?.length === 0 &&
                    !m.suggestions?.length &&
                    !library.settings.useAi && (
                      <button
                        className="text-button"
                        onClick={() => setShowSettings(true)}
                      >
                        <Sparkles size={15} />
                        {m.query ? "配置 AI 辨认画家" : "开启 AI 风格推荐"}{" "}
                        <ArrowRight size={14} />
                      </button>
                    )}
                  {m.query && (
                    <div className="query-label">
                      <Search size={12} /> {m.query}{" "}
                      <span>· {m.artworks?.length || 0} 件作品</span>
                    </div>
                  )}
                  {m.searchWarning && <p className="search-notice">{m.searchWarning}</p>}
                  {(m.searchCriteria || m.reviewCompleted) && <details className="review-audit">
                    <summary>{m.reviewPending ? "正在复核候选…" : m.reviewCompleted
                      ? `复核记录 · 保留 ${(m.artworks?.length || 0) + (m.webResults?.length || 0)} 项 · 待核实 ${[...(m.artworks || []), ...(m.webResults || [])].filter((item) => item.review?.verdict === "uncertain").length} 项 · 排除 ${(m.rejectedArtworks?.length || 0) + (m.rejectedWebResults?.length || 0)} 项`
                      : "查看检索计划"}</summary>
                    <p>检索词：{(m.searchQueries || [m.query]).filter(Boolean).join(" → ")}</p>
                    {m.searchCriteria && <><p>必须：{m.searchCriteria.required.join("；") || "未指定"}</p><p>偏好：{m.searchCriteria.preferred.join("；") || "未指定"}</p><p>排除：{m.searchCriteria.excluded.join("；") || "未指定"}</p></>}
                    {m.exploreIntent?.changes && <p>第 {m.exploreIntent.revision} 版调整：{
                      [m.exploreIntent.changes.added.length ? `新增 ${m.exploreIntent.changes.added.join("、")}` : "",
                        m.exploreIntent.changes.removed.length ? `移除 ${m.exploreIntent.changes.removed.join("、")}` : "",
                        ...m.exploreIntent.changes.moved.map((change) => `${change.value}：${change.from}→${change.to}`),
                        m.exploreIntent.changes.queryChanged ? "检索词已变更" : "",
                        m.exploreIntent.changes.artistChanged ? "指定作者已变更" : ""].filter(Boolean).join("；") || "条件未变"}</p>}
                    {m.retrievalDiagnostics && <p>本轮来源查询 {m.retrievalDiagnostics.sourceCalls}/{m.retrievalDiagnostics.sourceLimit}；作品详情请求 {m.retrievalDiagnostics.detailCalls ?? "旧记录未统计"} 次。</p>}
                    {m.retrievalDiagnostics?.sourceQueries?.map((plan, index) => <p key={`${plan.provider}-${index}`}>
                      {plan.provider}：{m.retrievalDiagnostics?.sourceStatuses?.[index]
                        ? ({ ok: "取得候选", empty: "无结果", filtered: "作者过滤后为空", limited: "限流", error: "暂时故障" } as const)[m.retrievalDiagnostics.sourceStatuses[index].state]
                        : "状态未记录"}
                      ；接口筛选 {plan.applied.join("、") || "无"}；留待复核 {plan.deferred.join("、") || "无"}
                    </p>)}
                    {!!m.continuationRuns?.length && <p>继续搜集：{m.continuationRuns.reduce((count, run) => count + run.sourceCalls, 0)} 次来源查询；最近一轮 {m.continuationRuns.at(-1)?.attemptedProviders.join("、")}</p>}
                    {[...(m.artworks || []), ...(m.webResults || []), ...(m.rejectedArtworks || []), ...(m.rejectedWebResults || [])].filter((item) => item.review).map((item) => <div className={`review-audit-item ${item.review!.verdict}`} key={"id" in item ? item.id : item.url}>
                      <strong>{item.review!.verdict === "reject" ? "已排除" : item.review!.verdict === "keep" ? "相关" : "待核实"} · {item.title}</strong>
                      <p>{item.review!.reason}</p>
                      <small title={item.pageEvidence?.error}>{item.review!.imageProvided ? "已提供缩略图" : "未提供图片"} · {pageEvidenceLabel(item)}{item.review!.quote ? ` · 引用：${item.review!.quote}` : ""}</small>
                      <a href={item.pageEvidence?.status === "read" ? item.pageEvidence.url : "id" in item ? item.source : item.url} target="_blank" rel="noreferrer">{item.pageEvidence?.status === "read" ? "查看证据页" : "查看来源"} <ExternalLink size={12} /></a>
                    </div>)}
                  </details>}
                  {m.searchCriteria && m.query && <>{editingCriteriaId === m.id
                    ? <IntentEditor key={m.id} query={m.query} criteria={m.searchCriteria} targetArtist={m.targetArtist} disabled={busy}
                        onCancel={() => setEditingCriteriaId(null)}
                        onApply={(query, criteria) => { setEditingCriteriaId(null); void send(describeIntentEdit(query, criteria), undefined, undefined, { source: m, query, criteria }); }} />
                    : <button type="button" className="intent-edit-button" disabled={busy} onClick={() => setEditingCriteriaId(m.id)}>调整条件与检索词</button>}</>}
                  {m.pageReviewPending && <p className="search-notice" role="status">正在逐件复核新增候选，原有展墙仍可查看；停止后新增候选会保留为待核实。</p>}
                  {m.reviewPending && !!m.artworks?.length && <div className="pending-wall">
                    <p className="search-notice" role="status">候选预览 · 尚未完成复核，也未编号。可以先看画或加入画架；复核后明显不符的候选会移到复核记录。</p>
                    {cards(m.artworks)}
                  </div>}
                  {!m.reviewPending && !!m.artworks?.length && <><p className="search-notice">作品已按顺序编号，可以直接追问某一张，或比较几张作品。</p>{cards(m.artworks, false, true)}</>}
                  {!m.reviewPending && !!m.webResults?.length && <div className="web-results">
                    <h3>全网作品线索 <small>作者与授权待核实</small></h3>
                    <div className="web-result-grid">{m.webResults.map((item, index) => <a key={item.url} href={item.url} target="_blank" rel="noreferrer">
                      {item.thumbnail && <img src={item.thumbnail} loading="lazy" referrerPolicy="no-referrer" alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
                      <strong>网页 {index + 1} · {item.title}</strong><span>{item.source} <ExternalLink size={12} /></span><p className="web-selection-reason">选择原因：{item.review?.reason || item.selectionReason || "搜索引擎返回的网页线索，作者与作品归属待核实。"}{item.review && item.selectionReason && <small>检索依据：{item.selectionReason}</small>}</p>{item.review && <span className={`review-status ${item.review.verdict}`}>复核：{item.review.verdict === "keep" ? "相关线索" : "待核实"} · {pageEvidenceLabel(item)}</span>}
                    </a>)}</div>
                  </div>}
                  {m.query && <a className="text-button external-search" href={`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(m.query)}`} target="_blank" rel="noreferrer"><Search size={14} />在 Google 图片中继续找<ExternalLink size={12} /></a>}
                  {(m.offset !== undefined || !!Object.keys(m.providerOffsets || {}).length) && (
                    <button
                      className="load-more"
                      disabled={busy}
                      onClick={() => void more(m)}
                    >
                      继续搜集作品 <ArrowDownToLine size={15} />
                    </button>
                  )}
                  {m.error && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        const last = current.messages
                          .filter((x) => x.role === "user")
                          .at(-1);
                        if (last) void send(last.text);
                      }}
                    >
                      重新尝试 <ArrowRight size={14} />
                    </button>
                  )}
                </section>
              ))}
              {busy && (
                <div className="search-progress" role="status">
                  <LoaderCircle className="spin" size={18} />
                  {phase}
                  <button onClick={stop}>停止</button>
                </div>
              )}
              <div ref={bottom} />
              <div className="chat-composer">{composer()}</div>
            </>
          )}
        </div>
      </main>
      {view === "chat" && current?.kind === "artwork" && current.artwork && floatingArtworkOpen && (
        <FloatingArtwork
          art={current.artwork}
          originalLocal={isOriginalLocal(savedFor(current.artwork.id)?.local) ? savedFor(current.artwork.id)?.local : undefined}
          onClose={() => setFloatingArtworkOpen(false)}
        />
      )}
      {context && (
        <div
          className="context-menu"
          style={{ left: context.x, top: context.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => openArtworkChat(context.art)} disabled={busy}>
            <MessageCircle size={16} />
            展开讲解对话
          </button>
          <button
            onClick={() => {
              viewArtwork(context.art);
              setContext(null);
            }}
          >
            <Maximize2 size={16} />
            查看作品
          </button>
          <button disabled={busy || !hasArtworkImage(context.art)} onClick={() => exploreFromArtwork(context.art, "composition")}>
            <Sparkles size={16} /> 按构图继续找
          </button>
          <button disabled={busy} onClick={() => exploreFromArtwork(context.art, "medium")}>
            <Sparkles size={16} /> 同题材换媒材
          </button>
          <button disabled={hdBusy || !hasArtworkImage(context.art)} onClick={() => void loadHd(context.art)}>
            <ArrowDownToLine size={16} />
            加载高清 · 2400px
          </button>
          <button
            onClick={() => {
              void save(context.art);
              setContext(null);
            }}
          >
            <Bookmark size={16} />
            {savedFor(context.art.id) ? "已在我的画架" : "加入我的画架"}
          </button>
          {savedFor(context.art.id) && (
            <button onClick={() => { viewArtwork(context.art); setContext(null); }}>
              <FolderOpen size={16} /> 整理画架主题与笔记
            </button>
          )}
          {savedFor(context.art.id) && (
            <button
              className="danger"
              onClick={() => {
                setRemoveArt(context.art);
                setContext(null);
              }}
            >
              <Trash2 size={16} />
              从画架移除
            </button>
          )}
          <a href={context.art.source} target="_blank" rel="noreferrer">
            <ExternalLink size={16} />
            查看馆藏来源
          </a>
        </div>
      )}
      {detail && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDetail(null);
          }}
        >
          <section
            className="art-detail"
            role="dialog"
            aria-modal="true"
            aria-label="作品详情"
          >
            <button
              className="fullscreen-button"
              onClick={() => openViewer(detail, true)}
              aria-label="全屏欣赏"
              disabled={!hasArtworkImage(detail) && !savedFor(detail.id)?.local}
            >
              <Maximize2 size={17} />
              全屏欣赏
            </button>
            <button
              className="close-button icon-button"
              aria-label="关闭作品详情"
              onClick={() => setDetail(null)}
            >
              <X />
            </button>
            <div
              className="detail-canvas"
              role="button"
              tabIndex={hasArtworkImage(detail) || savedFor(detail.id)?.local ? 0 : -1}
              aria-label={`${hasArtworkImage(detail) || savedFor(detail.id)?.local ? "全屏欣赏" : "馆藏资料"} ${detail.title}`}
              onClick={() => openViewer(detail, true)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openViewer(detail, true);
                }
              }}
            >
              {hd[detail.id] && !isOriginalLocal(savedFor(detail.id)?.local) ? (
                <img src={hd[detail.id]} alt={detail.title} />
              ) : (
                <ArtImage
                  art={detail}
                  saved={savedFor(detail.id)}
                  preferOriginal
                />
              )}
              <span>
                {isOriginalLocal(savedFor(detail.id)?.local)
                  ? `${detail.provider === "cleveland" ? "本地馆方高清 JPEG" : "本地原图"} · ${detail.width} × ${detail.height} px`
                  : hd[detail.id]
                    ? "高清 · 最长边 2400 px"
                    : hasArtworkImage(detail) ? "轻量预览 · 缩略图" : "馆藏暂未提供数字图像"}
              </span>
            </div>
            <div className="detail-info">
              <span className="eyebrow">A CLOSER LOOK</span>
              <h2>{detail.title}</h2>
              <p className="detail-artist">{detail.artist}</p>
              <p>{detail.date}</p>
              <div className="detail-rule" />
              <p className="description">
                {detail.description ||
                  (hasArtworkImage(detail) ? "这件作品尚未提供文字介绍。让目光在画面里多停留一会儿。" : "馆藏暂未提供文字介绍；可打开来源查看完整记录。")}
              </p>
              <dl>
                <dt>可用数字图像</dt>
                <dd>
                  {hasArtworkImage(detail) ? `${detail.width} × ${detail.height} px` : "馆藏暂未提供"}
                </dd>
                <dt>授权标记</dt>
                <dd>
                  {detail.licenseUrl ? (
                    <a
                      href={detail.licenseUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {detail.license} ↗
                    </a>
                  ) : (
                    detail.license
                  )}
                </dd>
                {detail.attribution && (
                  <>
                    <dt>署名 / 来源信息</dt>
                    <dd>{detail.attribution}</dd>
                  </>
                )}
              </dl>
              {savedFor(detail.id) && <CollectionOrganizer key={detail.id} saved={savedFor(detail.id)!}
                groups={collectionGroups} onSave={(group, note) => {
                  setLibrary((current) => ({ ...current, saved: current.saved.map((item) => item.artwork.id === detail.id
                    ? { ...item, collectionGroup: group, note } : item) }));
                  setToast("画架主题与笔记已保存");
                }} />}
              <button
                className="primary-button"
                onClick={() => void save(detail)}
                disabled={saving.includes(detail.id)}
              >
                <Bookmark size={16} />
                {!detail.original ? savedFor(detail.id) ? "馆藏资料已在画架" : "保存馆藏资料到画架"
                  : isOriginalLocal(savedFor(detail.id)?.local)
                  ? `已收入我的画架 · ${fullImageLabel(detail)}`
                  : savedFor(detail.id)
                    ? `重试下载${fullImageLabel(detail)}`
                    : `收入我的画架 · 下载${fullImageLabel(detail)}`}
              </button>
              <button
                className="secondary-button"
                onClick={() => openArtworkChat(detail)}
              >
                <MessageCircle size={16} />
                展开讲解对话
              </button>
              <button
                className="secondary-button"
                onClick={() => openViewer(detail, true)}
                disabled={!hasArtworkImage(detail) && !savedFor(detail.id)?.local}
              >
                <Maximize2 size={16} /> 全屏欣赏 · 可选画质
              </button>
              <a
                className="source-link"
                href={detail.source}
                target="_blank"
                rel="noreferrer"
              >
                {hasArtworkImage(detail) ? "查看原图与完整授权" : "查看馆藏记录与授权"} <ExternalLink size={14} />
              </a>
              {savedFor(detail.id) && (
                <button
                  className="text-button danger"
                  onClick={() => setRemoveArt(detail)}
                >
                  从画架移除
                </button>
              )}
            </div>
          </section>
        </div>
      )}
      {viewerOpen && detail && (
        <FullscreenViewer
          key={detail.id}
          art={detail}
          saved={savedFor(detail.id)}
          originalLocal={isOriginalLocal(savedFor(detail.id)?.local) ? savedFor(detail.id)?.local : undefined}
          saving={saving.includes(detail.id)}
          onSave={() => void save(detail)}
          position={Math.max(0, viewerArts.findIndex((item) => item.id === detail.id))}
          total={viewerArts.length}
          onPrevious={() => {
            const index = viewerArts.findIndex((item) => item.id === detail.id);
            if (index > 0) viewArtwork(viewerArts[index - 1]);
          }}
          onNext={() => {
            const index = viewerArts.findIndex((item) => item.id === detail.id);
            if (index >= 0 && index < viewerArts.length - 1)
              viewArtwork(viewerArts[index + 1]);
          }}
          onClose={closeViewer}
        />
      )}
      {showSettings && (
        <SettingsDialog
          settings={library.settings}
          savedLocals={library.saved.map((item) => item.local)}
          blocked={busy || saving.length > 0 || hdBusy}
          onClose={() => setShowSettings(false)}
          onSave={(settings) => {
            setLibrary((l) => ({ ...l, settings }));
            setToast("偏好已更新");
          }}
          onSwitch={async () => {
            const l = await readLibrary();
            setLibrary(l);
            setActive(null);
            setView("discover");
            setPersistError("");
            setToast("已切换资料库");
          }}
          onClearDiscovery={() => {
            discoverRequest.current?.abort();
            discoverSeen.current.clear();
            discoverArtistSeen.current.clear();
            discoverCultureSeen.current.clear();
            discoverTypeSeen.current.clear();
            discoverArtists.current = [];
            discoverOffsets.current = {};
            setLibrary((current) => ({ ...current, discoveryExposure: { ids: [], artistKeys: [], cultureKeys: [], typeKeys: [], topics: [], offsets: {} } }));
            setDiscoverCoverage(null);
            void refreshDiscovery();
          }}
          flush={() => writeLibrary(library)}
        />
      )}
      {(deleteId || removeArt) && (
        <div className="modal-backdrop">
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-label="确认移除"
          >
            <h2>{deleteId ? "删除这段对话？" : "从画架移除这件作品？"}</h2>
            <p>
              {deleteId
                ? "对话中的作品不会从你的画架中删除。"
                : "作品会从收藏中移除，缓存图片暂时保留，方便重新收藏。"}
            </p>
            <div>
              <button
                className="secondary-button"
                onClick={() => {
                  setDeleteId(null);
                  setRemoveArt(null);
                }}
              >
                取消
              </button>
              <button
                className="primary-button"
                onClick={() => {
                  if (deleteId) {
                    setLibrary((l) => ({
                      ...l,
                      conversations: l.conversations.filter(
                        (c) => c.id !== deleteId,
                      ),
                    }));
                    if (active === deleteId) {
                      setActive(null);
                      setView("history");
                    }
                  } else if (removeArt)
                    setLibrary((l) => ({
                      ...l,
                      saved: l.saved.filter(
                        (s) => s.artwork.id !== removeArt.id,
                      ),
                    }));
                  setDeleteId(null);
                  setRemoveArt(null);
                }}
              >
                确认移除
              </button>
            </div>
          </section>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function SettingsDialog({
  settings,
  savedLocals,
  onClose,
  onSave,
  onSwitch,
  onClearDiscovery,
  flush,
  blocked,
}: {
  settings: Settings;
  savedLocals: string[];
  onClose: () => void;
  onSave: (s: Settings) => void;
  onSwitch: () => Promise<void>;
  onClearDiscovery: () => void;
  flush: () => Promise<void>;
  blocked: boolean;
}) {
  const [draft, setDraft] = useState(settings);
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [searchKey, setSearchKey] = useState("");
  const [hasSearchKey, setHasSearchKey] = useState(false);
  const [folder, setFolder] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [cacheResult, setCacheResult] = useState("");
  const [cacheCleared, setCacheCleared] = useState(false);
  const [exposureCleared, setExposureCleared] = useState(false);
  const [tab, setTab] = useState<"ai" | "library">("ai");
  useEffect(() => {
    if (desktop)
      invoke<string>("library_directory")
        .then(setFolder)
        .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    let alive = true;
    if (desktop)
      invoke<boolean>("has_api_key", { baseUrl: draft.baseUrl })
        .then((v) => {
          if (alive) setHasKey(v);
        })
        .catch(() => {
          if (alive) setHasKey(false);
        });
    return () => {
      alive = false;
    };
  }, [draft.baseUrl]);
  useEffect(() => {
    if (desktop) void invoke<boolean>("has_api_key", { baseUrl: SEARCH_KEY_ADDRESS }).then(setHasSearchKey).catch(() => setHasSearchKey(false));
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setWorking(true);
    try {
      const url = new URL(draft.baseUrl);
      if (
        url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        )
      )
        throw new Error("请输入 HTTPS 地址；本地服务可使用 HTTP");
      if (!draft.model.trim()) throw new Error("请填写模型名称");
      if (key && desktop)
        await invoke("save_api_key", { baseUrl: draft.baseUrl, key });
      if (searchKey && desktop) await invoke("save_api_key", { baseUrl: SEARCH_KEY_ADDRESS, key: searchKey });
      onSave({
        ...draft,
        baseUrl: draft.baseUrl.trim().replace(/\/$/, ""),
        model: draft.model.trim(),
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking(false);
    }
  }
  async function switchFolder(mode: "copy" | "open") {
    setError("");
    setWorking(true);
    try {
      await flush();
      const path = await invoke<string | null>("choose_directory");
      if (path) {
        await invoke("switch_library", { path, mode });
        await onSwitch();
        setFolder(await invoke("library_directory"));
        onClose();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking(false);
    }
  }
  async function clearCache() {
    setError("");
    setWorking(true);
    try {
      await flush();
      const result = await clearTemporaryImages(savedLocals);
      setCacheResult(
        `已清理 ${result.files} 个临时文件（${(result.bytes / 1024 / 1024).toFixed(1)} MB），画架图片已保留。`,
      );
      setCacheCleared(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking(false);
    }
  }
  const closeSettings = () => {
    onClose();
    if (cacheCleared) location.reload();
  };
  return (
    <div className="modal-backdrop">
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="偏好与资料库"
      >
        <div className="settings-header">
          <div>
            <span className="eyebrow">MAKE IT YOURS</span>
            <h2>偏好与资料库</h2>
          </div>
          <button
            className="icon-button"
            aria-label="关闭设置"
            onClick={closeSettings}
            disabled={working}
          >
            <X />
          </button>
        </div>
        <div className="settings-tabs">
          <button
            className={tab === "ai" ? "active" : ""}
            onClick={() => setTab("ai")}
          >
            <Sparkles size={16} />
            AI 与检索
          </button>
          <button
            className={tab === "library" ? "active" : ""}
            onClick={() => setTab("library")}
          >
            <FolderOpen size={16} />
            资料库与同步
          </button>
        </div>
        {tab === "ai" ? (
          <form onSubmit={submit}>
            <label className="toggle-label">
              <div>
                <strong>启用 AI 策展人</strong>
                <small>理解自然语言，结合上下文推荐检索方向</small>
              </div>
              <input
                type="checkbox"
                checked={draft.useAi}
                disabled={!desktop}
                onChange={(e) =>
                  setDraft({ ...draft, useAi: e.target.checked })
                }
              />
            </label>
            {!desktop && (
              <p className="notice">
                浏览器为界面预览；AI 和自定义文件夹请在 Tauri 桌面版使用。
              </p>
            )}
            <label>
              API Base URL
              <input
                value={draft.baseUrl}
                placeholder="https://your-provider.com/v1"
                onChange={(e) => {
                  setDraft({ ...draft, baseUrl: e.target.value });
                  setKey("");
                }}
              />
            </label>
            <p className="field-hint">
              兼容 Chat Completions 协议；本地模型可填写 localhost 地址。
            </p>
            <label>
              模型名称
              <input
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              />
            </label>
            <label>
              API Key{" "}
              <span>
                {hasKey ? "已安全保存在此电脑" : "仅保存在系统凭据库"}
              </span>
              <input
                type="password"
                autoComplete="off"
                value={key}
                disabled={!desktop}
                placeholder={hasKey ? "留空保留现有密钥" : "输入你的 API 密钥"}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            {hasKey && (
              <button
                type="button"
                className="text-button danger"
                onClick={() =>
                  invoke("save_api_key", { baseUrl: draft.baseUrl, key: "" })
                    .then(() => setHasKey(false))
                    .catch((e) => setError(errorText(e)))
                }
              >
                删除此地址的已保存密钥
              </button>
            )}
            <label className="toggle-row">
              <span>全网搜图 <small>查找艺术家官网、画廊与其他作品页面；搜索词将发送给 Brave。</small></span>
              <input type="checkbox" checked={!!draft.webSearch} disabled={!desktop} onChange={(e) => setDraft({ ...draft, webSearch: e.target.checked })} />
            </label>
            <label>
              Brave Search API Key <span>{hasSearchKey ? "已安全保存在此电脑" : "可选，保存在系统凭据库"}</span>
              <input type="password" autoComplete="off" disabled={!desktop} value={searchKey} placeholder={hasSearchKey ? "留空保留现有密钥" : "输入 Brave Search API 密钥"} onChange={(e) => setSearchKey(e.target.value)} />
            </label>
            {hasSearchKey && <button type="button" className="text-button danger" onClick={() => invoke("save_api_key", { baseUrl: SEARCH_KEY_ADDRESS, key: "" }).then(() => { setHasSearchKey(false); setSearchKey(""); }).catch((e) => setError(errorText(e)))}>删除全网搜图密钥</button>}
            <label>
              Wikimedia 检索范围
              <select
                value={draft.scope}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    scope: e.target.value as Settings["scope"],
                  })
                }
              >
                <option value="google">Google Art Project（默认）</option>
                <option value="commons">全部 Wikimedia Commons</option>
              </select>
            </label>
            <label className="toggle-row">
              <span>优先发现新作品 <small>优先展示未见过的作者、文化和作品类型；关闭后按馆藏返回顺序展示。</small></span>
              <input type="checkbox" checked={draft.discoveryRanking !== false} onChange={(e) => setDraft({ ...draft, discoveryRanking: e.target.checked })} />
            </label>
            <label>
              界面主题
              <select
                value={draft.theme}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    theme: event.target.value as Settings["theme"],
                  })
                }
              >
                <option value="light">浅色 · 展厅日光</option>
                <option value="contrast">清晰浅色 · 高对比文字</option>
                <option value="warm">暖纸色 · 柔和米黄</option>
                <option value="dark">深色 · 夜间观画</option>
                <option value="system">跟随系统</option>
              </select>
            </label>
            <label>
              作品讲解文字大小
              <select
                value={draft.explanationFontSize}
                onChange={(event) => setDraft({ ...draft, explanationFontSize: Number(event.target.value) })}
              >
                <option value={14}>小 · 14px</option>
                <option value={16}>标准 · 16px</option>
                <option value={18}>较大 · 18px</option>
                <option value={20}>大 · 20px</option>
                <option value={22}>特大 · 22px</option>
              </select>
            </label>
            <p className="field-hint">
              AI 会读取对话及实际搜索结果，并按需接收最多 3 张馆藏缩略图以比较作品；不支持图片的模型会改用文字资料。全网搜图需另行配置 Brave 密钥，网页线索可打开来源核实。密钥只保存在本机凭据库。
            </p>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <button className="primary-button" disabled={working || blocked}>
              {working ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Check size={16} />
              )}
              保存偏好
            </button>
          </form>
        ) : (
          <div className="library-settings">
            <h3>一个文件夹，带走你的美术馆。</h3>
            <p>
              作品图片、收藏、对话和偏好都在资料库中。你可以把它放入坚果云的同步文件夹。
            </p>
            <label>
              当前资料库
              <div className="folder-path">
                <FolderOpen size={19} />
                <code>{desktop ? folder : "浏览器 IndexedDB（预览模式）"}</code>
              </div>
            </label>
            <div className="folder-actions">
              <button
                className="primary-button"
                disabled={!desktop || working || blocked}
                onClick={() => void switchFolder("copy")}
              >
                <FolderOpen size={16} />
                迁移到指定文件夹
              </button>
              <button
                className="secondary-button"
                disabled={!desktop || working || blocked}
                onClick={() => void switchFolder("open")}
              >
                打开已有资料库
              </button>
            </div>
            <div className="sync-note">
              <h4>为坚果云准备好了</h4>
              <p>
                迁移会复制到空文件夹并切换使用，原目录保留作备份。换电脑时，选择同步完成的同一文件夹即可。
              </p>
              <p>图片使用相对路径。API 密钥不参与同步，每台电脑单独配置。</p>
              <p>
                请等坚果云同步完成后再打开，避免两台电脑同时编辑。检测到外部修改时会停止覆盖保存。
              </p>
              <small>
                library.json · collection/originals/ · cache/（旧版 images/
                自动兼容）
              </small>
            </div>
            <div className="cache-cleanup">
              <h4>首页漫游记录</h4>
              <p>首页会记住已展示的作品与作者，减少反复刷到同一组。清除后可从头探索；不会删除画架、浏览历史或对话。</p>
              <button className="secondary-button" disabled={working || blocked} onClick={() => { onClearDiscovery(); setExposureCleared(true); }}>
                清除首页已见记录
              </button>
              {exposureCleared && <p role="status">首页已见记录已清除，正在重新搜集；画架和历史不受影响。</p>}
            </div>
            <div className="cache-cleanup">
              <h4>临时图片缓存</h4>
              <p>
                检索缩略图、高清预览和未收藏的原图分别存放。清理只删除临时文件；画架收藏的图片与对话记录保留。旧版资料库中仍被收藏引用的图片也会保留。
              </p>
              <button
                className="secondary-button"
                disabled={working || blocked}
                onClick={() => void clearCache()}
              >
                清理临时图片
              </button>
              {cacheResult && <p role="status">{cacheResult}</p>}
            </div>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            {working && <p role="status">正在处理资料库，请稍候…</p>}
            {blocked && (
              <p className="notice">请等待当前搜集或下载结束，再切换资料库。</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
