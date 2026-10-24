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
import type {
  Artwork,
  Conversation,
  Library,
  Message,
  SavedArtwork,
  Settings,
  ArtistSuggestion,
} from "./types";
import { defaultLibrary } from "./types";
import {
  cacheArtwork,
  clearTemporaryImages,
  desktop,
  localImage,
  readLibrary,
  writeLibrary,
} from "./services/storage";

import { highResolution, searchArt } from "./services/commons";
import { discoverArt } from "./services/discovery";
import {
  artworkIntroductionPrompt,
  explainArtwork,
  isRecommendationRequest,
  localArtworkIntroduction,
  planSearch,
  suggestArtists,
} from "./services/ai";

const isOriginalLocal = (local?: string) =>
  !!local &&
  (local.startsWith("collection/originals/") ||
    local.includes("-original.") ||
    local.endsWith(":original") ||
    local.endsWith(":collection"));

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
function ArtImage({
  art,
  saved,
  className = "",
  onClick,
  preferOriginal = false,
}: {
  art: Artwork;
  saved?: SavedArtwork;
  className?: string;
  onClick?: () => void;
  preferOriginal?: boolean;
}) {
  const [src, setSrc] = useState(saved || desktop ? "" : art.thumb);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let blob = "";
    setFailed(false);
    setSrc(saved || desktop ? "" : art.thumb);
    const image =
      saved && preferOriginal && isOriginalLocal(saved.local)
        ? localImage(saved.local)
        : saved
          ? cacheArtwork(art.id, art.thumb, "preview")
              .then(localImage)
              .catch(() => saved.local ? localImage(saved.local) : art.thumb)
          : desktop
            ? cacheArtwork(art.id, art.thumb).then(localImage)
            : null;
    if (image)
      image
        .then((url) => {
          blob = url;
          if (alive) setSrc(url);
        })
        .catch(() => {
          if (alive) setFailed(true);
        });
    return () => {
      alive = false;
      if (blob.startsWith("blob:")) URL.revokeObjectURL(blob);
    };
  }, [saved?.local, art.thumb, preferOriginal]);
  return (
    <div className={`art-image ${className}`} onClick={onClick}>
      {!failed && src ? (
        <img
          src={src}
          alt={art.title}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="image-placeholder">
          <ImageIcon size={28} />
          <span>{failed ? "图片暂不可用" : "正在装裱…"}</span>
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
}: {
  art: Artwork;
  saved?: SavedArtwork;
  onOpen: () => void;
  onSave: () => void;
  onContext: (x: number, y: number) => void;
  onSimilar?: () => void;
  pending: boolean;
}) {
  const originalSaved = isOriginalLocal(saved?.local);
  return (
    <article
      className="art-card"
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(e.clientX, e.clientY);
      }}
    >
      <button
        className="art-open"
        onClick={onOpen}
        aria-label={`欣赏 ${art.title}`}
      >
        <ArtImage art={art} saved={saved} />
        <span className="view-art">
          <Maximize2 size={16} /> 欣赏作品
        </span>
      </button>
      <div className="art-caption">
        <div>
          <p>{art.artist.slice(0, 100)}</p>
          <h3 title={art.title}>{art.title}</h3>
          {saved && !originalSaved && <small className="art-pending">原图待下载 · 点击书签重试</small>}
        </div>
        <button
          className={`icon-button save ${saved ? "is-saved" : ""}`}
          aria-label={
            saved
              ? originalSaved
                ? "已在画架 · 原图"
                : "重试下载原图"
              : "加入画架"
          }
          title={
            saved
              ? originalSaved
                ? "已在画架 · 原图"
                : "重试下载原图"
              : "加入画架 · 下载原图"
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
      <div className="art-meta">
        <span>{art.date.slice(0, 38)}</span>
        <span>{art.license}</span>
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
export default function App() {
  const [library, setLibrary] = useState<Library>(
    structuredClone(defaultLibrary),
  );
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState("");
  const [persistError, setPersistError] = useState("");
  const [view, setView] = useState<"discover" | "easel" | "history" | "chat">(
    "discover",
  );
  const [active, setActive] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState("");
  const [historyKind, setHistoryKind] = useState<"inspiration" | "artwork">(
    "inspiration",
  );
  const [discover, setDiscover] = useState<Artwork[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(true);
  const [discoverError, setDiscoverError] = useState("");
  const discoverRequest = useRef<AbortController | null>(null);
  const discoverArtists = useRef<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const request = useRef<AbortController | null>(null);
  const [saving, setSaving] = useState<number[]>([]);
  const [detail, setDetail] = useState<Artwork | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerArts, setViewerArts] = useState<Artwork[]>([]);
  const viewerFromDetail = useRef(false);
  const browserFullscreen = useRef(false);
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
      void getCurrentWindow()
        .setFullscreen(false)
        .catch(() => {});
    else if (document.fullscreenElement)
      void document.exitFullscreen().catch(() => {});
    browserFullscreen.current = false;
  }, []);
  useEffect(() => {
    const changed = () => {
      if (!document.fullscreenElement && browserFullscreen.current)
        closeViewer();
    };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, [closeViewer]);
  function openViewer(art: Artwork, fromDetail = false, arts?: Artwork[]) {
    viewerFromDetail.current = fromDetail;
    if (arts) setViewerArts(arts);
    else if (!viewerArts.some((item) => item.id === art.id)) setViewerArts([art]);
    setDetail(art);
    setContext(null);
    setViewerOpen(true);
    if (desktop)
      void getCurrentWindow()
        .setFullscreen(true)
        .catch(() => {});
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
    void refreshDiscovery();
    return () => discoverRequest.current?.abort();
  }, [ready, library.settings.scope]);
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
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (!result.artworks.length) {
        setDiscoverError("这组画家暂时没有可展示的作品，请再刷新一次。");
      } else {
        discoverArtists.current = result.artists;
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
    const continueExisting =
      !similarTo && !!active && current?.kind !== "artwork";
    const id = continueExisting ? active! : crypto.randomUUID();
    const contextMessage: Message | null = similarTo
      ? {
          id: crypto.randomUUID(),
          role: "assistant",
          text: `以《${similarTo.title}》（${similarTo.artist}，${similarTo.date}）为参照，比较艺术风格并寻找可核对的开放馆藏作品。`,
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
      const plan = chosen
        ? {
            query: chosen.query,
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
      if (!chosen && isRecommendationRequest(text) && !library.settings.useAi) {
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
      if (plan.recommendations?.length) {
        setPhase("正在核对推荐画家的开放馆藏…");
        const checked = await Promise.all(
          plan.recommendations.map(async (candidate) => {
            let found = await searchArt(
              candidate.query,
              library.settings.scope,
              0,
              controller.signal,
            );
            let candidateScope = library.settings.scope;
            if (!found.artworks.length && candidateScope === "google") {
              found = await searchArt(
                candidate.query,
                "commons",
                0,
                controller.signal,
              );
              candidateScope = "commons";
            }
            return found.artworks.length
              ? {
                  candidate: { ...candidate, scope: candidateScope },
                  artworks: found.artworks.slice(0, 4),
                }
              : null;
          }),
        );
        if (controller.signal.aborted) return;
        const valid = checked.filter(
          (item): item is NonNullable<typeof item> => item !== null,
        );
        const artworks = valid
          .flatMap((item) => item.artworks)
          .filter(
            (art, index, all) =>
              all.findIndex((other) => other.id === art.id) === index,
          );
        updateConversation(id, (c) => ({
          ...c,
          messages: [
            ...c.messages,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              text: valid.length
                ? `${plan.explanation}\n\n下面这些画家在开放馆藏中有可查看的作品。你可以点选一位继续探索。`
                : `${plan.explanation}\n\n这些推荐暂时没有在当前开放馆藏中找到可展示的作品。`,
              artworks,
              suggestions: valid.map((item) => item.candidate),
              query: valid.map((item) => item.candidate.nameEn).join(" · "),
              scope: library.settings.scope,
            },
          ],
        }));
        return;
      }
      setPhase("正在从 Wikimedia 搜集缩略图…");
      const scope = chosen?.scope || library.settings.scope;
      const result = await searchArt(plan.query, scope, 0, controller.signal);
      let suggestions: ArtistSuggestion[] = [];
      let suggestionError = "";
      if (!result.artworks.length && library.settings.useAi && desktop) {
        setPhase("正在辨认画家名称，并核对馆藏…");
        try {
          const candidates = await suggestArtists(
            text,
            plan.query,
            library.settings,
            controller.signal,
          );
          const checked = await Promise.all(
            candidates.map(async (candidate) => {
              const direct = await searchArt(
                candidate.query,
                scope,
                0,
                controller.signal,
              );
              if (direct.artworks.length) return { ...candidate, scope };
              if (scope === "google") {
                const broad = await searchArt(
                  candidate.query,
                  "commons",
                  0,
                  controller.signal,
                );
                if (broad.artworks.length)
                  return { ...candidate, scope: "commons" as const };
              }
              return null;
            }),
          );
          suggestions = checked.filter(
            (candidate): candidate is NonNullable<typeof candidate> =>
              candidate !== null,
          );
        } catch (e) {
          if (controller.signal.aborted) return;
          suggestionError = ` AI 辨认暂不可用：${errorText(e)}`;
        }
      }
      if (controller.signal.aborted) return;
      updateConversation(id, (c) => ({
        ...c,
        messages: [
          ...c.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: result.artworks.length
              ? plan.explanation
              : suggestions.length
                ? "没有找到对应作品。你可能在说以下画家；这些名称已在开放馆藏中找到相关文件。请选择一个继续搜索。"
                : `这次没有找到匹配的作品。可以让 AI 辨认画家姓名，或将检索范围扩展到全部 Wikimedia Commons。${suggestionError}`,
            artworks: result.artworks,
            suggestions,
            query: plan.query,
            scope,
            offset: result.offset,
          },
        ],
      }));
    } catch (e) {
      if (!controller.signal.aborted)
        updateConversation(id, (c) => ({
          ...c,
          messages: [
            ...c.messages,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              text: errorText(e),
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
  function stop() {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    if (active)
      updateConversation(active, (c) => ({
        ...c,
        messages: [
          ...c.messages,
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
    if (!current || busy || message.offset === undefined) return;
    const id = current.id;
    setBusy(true);
    setPhase("继续搜集作品…");
    const controller = new AbortController();
    request.current = controller;
    try {
      const r = await searchArt(
        message.query!,
        message.scope || library.settings.scope,
        message.offset,
        controller.signal,
      );
      updateConversation(id, (c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === message.id
            ? {
                ...m,
                artworks: [
                  ...(m.artworks || []),
                  ...r.artworks.filter(
                    (a) => !m.artworks?.some((old) => old.id === a.id),
                  ),
                ],
                offset: r.offset,
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
    if (existing && isOriginalLocal(existing.local)) {
      setToast("这件作品的原图已经在画架上");
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
          ? "画架作品已升级为原始分辨率"
          : "已收入画架 · 原图已保存在本地",
      );
    } catch (e) {
      setToast(`作品已在画架；原图暂未下载：${errorText(e)} 可稍后在画架中重试。`);
    } finally {
      setSaving((s) => s.filter((id) => id !== art.id));
    }
  }
  async function loadHd(art: Artwork) {
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
  function cards(arts: Artwork[], showSimilar = false) {
    return (
      <div className="gallery-grid">
        {arts.map((art) => (
          <ArtCard
            key={art.id}
            art={art}
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
              setViewerArts(arts);
              setContext({
                art,
                x: Math.min(x, window.innerWidth - 250),
                y: Math.min(y, window.innerHeight - 220),
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
              : view === "history"
                ? "往日对话"
                : view === "chat"
                  ? current?.kind === "artwork"
                    ? "作品讲解"
                    : "灵感对话"
                  : "发现艺术"}
          </div>
          <a
            className="source-chip"
            href="https://commons.wikimedia.org/wiki/Category:Google_Art_Project"
            target="_blank"
            rel="noreferrer"
          >
            <span className="status-dot" />
            Wikimedia Commons
            <ExternalLink size={12} />
          </a>
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
        <div className={`page-content ${view === "chat" ? "chat-page" : ""}`}>
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
                  <span>跨越年代 · 每次遇见不同的画家</span>
                  <span>
                    {library.settings.scope === "google"
                      ? "GOOGLE ART PROJECT"
                      : "WIKIMEDIA COMMONS"}{" "}
                    <span className="middle-dot">·</span> 开放馆藏
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
                  <Check size={14} /> {library.saved.some((s) => !isOriginalLocal(s.local)) ? "画架已保存 · 部分原图待下载" : "本地图片 · 离线可看"}
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
              {library.saved.length ? (
                cards(
                  library.saved
                    .filter((s) =>
                      `${s.artwork.title} ${s.artwork.artist}`
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
                      {library.settings.scope === "google"
                        ? "Google Art Project"
                        : "Wikimedia Commons"}{" "}
                      · {library.settings.useAi ? "AI 策展" : "直接检索"} ·
                      缩略图优先
                    </>
                  )}
                </p>
              </div>
              {current?.kind === "artwork" && current.artwork && (
                <button
                  className="artwork-chat-context"
                  onClick={() => {
                    setViewerArts([current.artwork!]);
                    setDetail(current.artwork!);
                  }}
                >
                  <ArtImage
                    art={current.artwork}
                    saved={savedFor(current.artwork.id)}
                  />
                  <span>
                    <small>正在讲解的作品</small>
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
                  <p className="message-text">{m.text}</p>
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
                  {!!m.artworks?.length && cards(m.artworks)}
                  {m.offset !== undefined && (
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
              setDetail(context.art);
              setContext(null);
            }}
          >
            <Maximize2 size={16} />
            查看作品
          </button>
          <button disabled={hdBusy} onClick={() => void loadHd(context.art)}>
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
            查看 Wikimedia 来源
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
              tabIndex={0}
              aria-label={`全屏欣赏 ${detail.title}`}
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
                  ? `本地原图 · ${detail.width} × ${detail.height} px`
                  : hd[detail.id]
                    ? "高清 · 最长边 2400 px"
                    : "轻量预览 · 缩略图"}
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
                  "这件作品尚未提供文字介绍。让目光在画面里多停留一会儿。"}
              </p>
              <dl>
                <dt>原作数字图像</dt>
                <dd>
                  {detail.width} × {detail.height} px
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
              <button
                className="primary-button"
                onClick={() => void save(detail)}
                disabled={saving.includes(detail.id)}
              >
                <Bookmark size={16} />
                {isOriginalLocal(savedFor(detail.id)?.local)
                  ? "已收入我的画架 · 原图"
                  : savedFor(detail.id)
                    ? "重试下载原图"
                    : "收入我的画架 · 下载原图"}
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
              >
                <Maximize2 size={16} /> 全屏欣赏 · 可选画质
              </button>
              <a
                className="source-link"
                href={detail.source}
                target="_blank"
                rel="noreferrer"
              >
                查看原图与完整授权 <ExternalLink size={14} />
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
          saved={
            isOriginalLocal(savedFor(detail.id)?.local)
              ? savedFor(detail.id)
              : undefined
          }
          position={Math.max(0, viewerArts.findIndex((item) => item.id === detail.id))}
          total={viewerArts.length}
          onPrevious={() => {
            const index = viewerArts.findIndex((item) => item.id === detail.id);
            if (index > 0) setDetail(viewerArts[index - 1]);
          }}
          onNext={() => {
            const index = viewerArts.findIndex((item) => item.id === detail.id);
            if (index >= 0 && index < viewerArts.length - 1)
              setDetail(viewerArts[index + 1]);
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
  flush,
  blocked,
}: {
  settings: Settings;
  savedLocals: string[];
  onClose: () => void;
  onSave: (s: Settings) => void;
  onSwitch: () => Promise<void>;
  flush: () => Promise<void>;
  blocked: boolean;
}) {
  const [draft, setDraft] = useState(settings);
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [folder, setFolder] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [cacheResult, setCacheResult] = useState("");
  const [cacheCleared, setCacheCleared] = useState(false);
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
            <label>
              馆藏检索范围
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
            <p className="field-hint">
              无 AI 也可以直接搜索艺术家和主题。风格推荐会向所选 AI
              服务发送对话文字及少量前文作品资料；作品讲解还会发送当前作品的
              Commons 缩略图链接。API 密钥只保存在本机凭据库。
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
