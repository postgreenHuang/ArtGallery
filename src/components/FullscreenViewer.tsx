import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bookmark, ChevronLeft, ChevronRight, LoaderCircle, Minus, Plus, RotateCcw, X } from "lucide-react";
import type { Artwork, SavedArtwork } from "../types";
import { sizedImage } from "../services/commons";
import {
  cacheArtwork,
  cachedArtwork,
  localImage,
  type DownloadProgress,
} from "../services/storage";

type ViewerVariant = "preview" | "medium" | "hd" | "original";
const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;
const variantLabel: Record<ViewerVariant, string> = {
  preview: "缩略图 · 最长边≤640px",
  medium: "标准 · 最长边≤1280px",
  hd: "高清 · 最长边≤2400px",
  original: "原图 · 最高分辨率",
};

const clamp = (value: number, maximum = 16) =>
  Math.min(maximum, Math.max(1, value));

export default function FullscreenViewer({
  art,
  saved,
  originalLocal,
  preferCached,
  saving,
  position,
  total,
  onPrevious,
  onNext,
  onClose,
  onSave,
}: {
  art: Artwork;
  saved?: SavedArtwork;
  originalLocal?: string;
  preferCached: boolean;
  saving: boolean;
  position: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const [source, setSource] = useState({
    url: art.thumb,
    variant: "preview" as ViewerVariant,
  });
  const [available, setAvailable] = useState<
    Partial<Record<ViewerVariant, string>>
  >({ preview: art.thumb });
  const [selected, setSelected] = useState<ViewerVariant>("preview");
  const [downloading, setDownloading] = useState<ViewerVariant | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const [loaded, setLoaded] = useState<{
    url: string;
    width: number;
    height: number;
  } | null>(null);
  const [fitRatio, setFitRatio] = useState(1);
  const [paintedUrl, setPaintedUrl] = useState("");
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const canvas = useRef<HTMLDivElement>(null);
  const pixels = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  const desired = useRef<ViewerVariant>("preview");
  const pending = useRef<ViewerVariant | null>(null);
  const mounted = useRef(false);
  const ownedUrls = useRef(new Set<string>());
  const fullImageName = art.provider === "cleveland" ? "馆方高清 JPEG" : "原图";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ownedUrls.current.forEach((url) => URL.revokeObjectURL(url));
      ownedUrls.current.clear();
    };
  }, []);
  const rememberUrl = (url: string) => {
    if (!mounted.current) {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      return false;
    }
    if (url.startsWith("blob:")) ownedUrls.current.add(url);
    window.dispatchEvent(new CustomEvent("art-image-cached", { detail: art.id }));
    return true;
  };

  useEffect(() => {
    let alive = true;
    setSource({ url: art.thumb, variant: "preview" });
    setAvailable({ preview: art.thumb });
    setSelected("preview");
    desired.current = "preview";
    const load = async () => {
      if (preferCached) {
        for (const variant of ["original", "hd", "medium", "preview"] as const) {
          try {
            const local = (variant === "original" ? originalLocal : undefined) ||
              await cachedArtwork(art.id, variant);
            if (!local) continue;
            const url = await localImage(local);
            if (!alive) {
              if (url.startsWith("blob:")) URL.revokeObjectURL(url);
              return;
            }
            if (rememberUrl(url)) {
              setAvailable((current) => ({ ...current, [variant]: url }));
              if (desired.current === "preview") {
                desired.current = variant;
                setSelected(variant);
                setSource({ url, variant });
              }
            }
            return;
          } catch {
            // A stale cache entry should not prevent using a lower resolution.
          }
        }
      }
      try {
        const url = await localImage(await cacheArtwork(art.id, art.thumb, "preview"));
        if (!alive) {
          if (url.startsWith("blob:")) URL.revokeObjectURL(url);
        } else if (rememberUrl(url)) {
          setAvailable((current) => ({ ...current, preview: url }));
          if (desired.current === "preview") setSource({ url, variant: "preview" });
        }
      } catch { /* The remote thumbnail remains available as a fallback. */ }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [art.id, art.thumb, originalLocal, preferCached]);

  async function selectResolution(variant: ViewerVariant) {
    if (pending.current && !available[variant] && variant !== "preview") return;
    desired.current = variant;
    setSelected(variant);
    setDownloadError("");
    const cached = available[variant];
    if (cached) {
      setSource({ url: cached, variant });
      setScale(1);
      setPan({ x: 0, y: 0 });
      return;
    }
    pending.current = variant;
    setDownloading(variant);
    setProgress(null);
    try {
      let local =
        (variant === "original" ? originalLocal : undefined) ||
        (await cachedArtwork(art.id, variant));
      if (!local) {
        const url =
          variant === "original"
            ? art.original
            : await sizedImage(art, variant === "medium" ? 1280 : 2400);
        local = await cacheArtwork(art.id, url, variant, (update) => {
          if (mounted.current) setProgress(update);
        });
      }
      const url = await localImage(local);
      if (!rememberUrl(url)) return;
      setAvailable((current) => ({ ...current, [variant]: url }));
      if (desired.current === variant) {
        setSource({ url, variant });
        setScale(1);
        setPan({ x: 0, y: 0 });
      }
    } catch (error) {
      if (!mounted.current) return;
      setDownloadError(error instanceof Error ? error.message : String(error));
      if (desired.current === variant) {
        desired.current = source.variant;
        setSelected(source.variant);
      }
    } finally {
      pending.current = null;
      if (mounted.current) {
        setDownloading(null);
        setProgress(null);
      }
    }
  }

  useEffect(() => {
    const element = canvas.current;
    if (!element || !loaded) return;
    const update = () => {
      setFitRatio(
        Math.min(
          1,
          element.clientWidth / loaded.width,
          element.clientHeight / loaded.height,
        ),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [loaded]);

  const oneToOne = loaded && fitRatio > 0 ? 1 / fitRatio : 1;
  const maximum = Math.max(16, oneToOne);
  const actualPercent = loaded ? Math.round(scale * fitRatio * 100) : null;

  useEffect(() => {
    // A remote thumbnail may taint the canvas; reset it before drawing a local original.
    if (pixels.current) pixels.current.width = pixels.current.width;
    setPaintedUrl("");
  }, [source.url]);

  useEffect(() => {
    const surface = pixels.current;
    const sourceImage = image.current;
    const frame = canvas.current;
    if (
      !surface ||
      !sourceImage ||
      !frame ||
      !loaded ||
      loaded.url !== source.url
    )
      return;
    let animation = 0;
    const paint = () => {
      const width = frame.clientWidth;
      const height = frame.clientHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const targetWidth = Math.round(width * ratio);
      const targetHeight = Math.round(height * ratio);
      if (!targetWidth || !targetHeight) return;
      if (surface.width !== targetWidth) surface.width = targetWidth;
      if (surface.height !== targetHeight) surface.height = targetHeight;
      const context = surface.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, targetWidth, targetHeight);
      const zoom = fitRatio * scale;
      if (zoom <= 0) return;
      const sourceWidth = width / zoom;
      const sourceHeight = height / zoom;
      const sourceX = loaded.width / 2 - (width / 2 + pan.x) / zoom;
      const sourceY = loaded.height / 2 - (height / 2 + pan.y) / zoom;
      const left = Math.max(0, sourceX);
      const top = Math.max(0, sourceY);
      const right = Math.min(loaded.width, sourceX + sourceWidth);
      const bottom = Math.min(loaded.height, sourceY + sourceHeight);
      if (right <= left || bottom <= top) return;
      context.imageSmoothingEnabled = zoom < 1;
      context.imageSmoothingQuality = "high";
      context.drawImage(
        sourceImage,
        left,
        top,
        right - left,
        bottom - top,
        (left - sourceX) * zoom * ratio,
        (top - sourceY) * zoom * ratio,
        (right - left) * zoom * ratio,
        (bottom - top) * zoom * ratio,
      );
      setPaintedUrl(source.url);
    };
    const schedule = () => {
      cancelAnimationFrame(animation);
      animation = requestAnimationFrame(paint);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(frame);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(animation);
    };
  }, [loaded, source.url, fitRatio, scale, pan]);

  useEffect(() => {
    close.current?.focus();
    const htmlOverflow = document.documentElement.style.overflow;
    const bodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    const key = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, select, textarea, [contenteditable=true]")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
      if (event.key === "ArrowLeft" && position > 0) {
        event.preventDefault();
        onPrevious();
      }
      if (event.key === "ArrowRight" && position < total - 1) {
        event.preventDefault();
        onNext();
      }
      if (event.key === "+" || event.key === "=")
        setScale((s) => clamp(s * 1.25, maximum));
      if (event.key === "-") setScale((s) => clamp(s / 1.25));
      if (event.key === "0") {
        setScale(1);
        setPan({ x: 0, y: 0 });
      }
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.documentElement.style.overflow = htmlOverflow;
      document.body.style.overflow = bodyOverflow;
    };
  }, [onClose, onPrevious, onNext, position, total, maximum]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left - rect.width / 2;
      const y = event.clientY - rect.top - rect.height / 2;
      setScale((old) => {
        const next = clamp(old * Math.exp(-event.deltaY * 0.002), maximum);
        const ratio = next / old;
        setPan((p) => ({
          x: p.x + (1 - ratio) * (x - p.x),
          y: p.y + (1 - ratio) * (y - p.y),
        }));
        return next;
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [maximum]);

  const zoom = (factor: number) => {
    setScale((old) => {
      const next = clamp(old * factor, maximum);
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };
  return createPortal(
    <div
      className="fullscreen-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`全屏欣赏 ${art.title}`}
    >
      <div className="viewer-toolbar">
        <div className="viewer-title">
          <strong>{art.title}</strong>
          <span>{art.artist}</span>
          {total > 1 && <span className="viewer-position">{position + 1} / {total}</span>}
        </div>
        <div className="viewer-actions">
          <label className="viewer-quality-label" htmlFor="viewer-quality">
            画质
          </label>
          <select
            id="viewer-quality"
            aria-label="选择画作分辨率"
            value={selected}
            onChange={(event) =>
              void selectResolution(event.target.value as ViewerVariant)
            }
          >
            {(["preview", "medium", "hd", "original"] as const).map(
              (variant) => (
                <option
                  key={variant}
                  value={variant}
                  disabled={
                    !!downloading &&
                    !available[variant] &&
                    variant !== "preview"
                  }
                >
                  {variant === "original" && art.provider === "cleveland" ? "馆方高清 JPEG · 最长边约3400px" : variantLabel[variant]}
                  {variant === "preview"
                    ? " · 当前可用"
                    : available[variant] || (variant === "original" && originalLocal)
                      ? " · 已缓存"
                      : " · 选择后下载"}
                </option>
              ),
            )}
          </select>
          <span className="viewer-resolution" aria-live="polite">
            {loaded?.url === source.url && paintedUrl === source.url
              ? `${source.variant === "original" ? art.provider === "cleveland" ? "已显示馆方高清 JPEG" : "已显示原图" : `已显示${source.variant === "preview" ? "缩略图" : source.variant === "medium" ? "标准图" : "高清图"}`} · ${loaded.width} × ${loaded.height}px`
              : "图片解码中…"}
          </span>
          <button onClick={() => zoom(1 / 1.25)} aria-label="缩小">
            <Minus size={17} />
          </button>
          <span className="viewer-scale" title="相对于适合窗口的放大倍数">
            适屏 ×{Math.round(scale * 100)}%
          </span>
          <button onClick={() => zoom(1.25)} aria-label="放大">
            <Plus size={17} />
          </button>
          <button
            onClick={() => setScale(clamp(oneToOne, maximum))}
            disabled={!loaded}
            title="一个图片像素对应一个屏幕 CSS 像素"
            aria-label="以 1:1 原始像素显示"
          >
            1:1
          </button>
          <span className="viewer-pixel-scale">
            {actualPercent === null ? "" : `当前图像 ${actualPercent}%`}
          </span>
          <button
            onClick={() => {
              setScale(1);
              setPan({ x: 0, y: 0 });
            }}
            aria-label="重置视图"
            title="重置视图"
          >
            <RotateCcw size={17} />
          </button>
          <button
            className="viewer-save"
            onClick={onSave}
            disabled={saving || !!originalLocal}
            aria-label={saving ? "正在加入画架" : originalLocal ? `已在画架 · ${fullImageName}` : saved ? `重试下载${fullImageName}` : "加入画架"}
            title={saved && !originalLocal ? `已在画架，点击重试下载${fullImageName}` : undefined}
          >
            {saving ? <LoaderCircle className="spin" size={17} /> : <Bookmark size={17} fill={saved ? "currentColor" : "none"} />}
            <span>{saving ? "收藏中…" : originalLocal ? "已收藏" : saved ? `重试${fullImageName}` : "加入画架"}</span>
          </button>
          <button
            ref={close}
            className="viewer-close"
            onClick={onClose}
            aria-label="退出全屏"
          >
            <X size={22} />
          </button>
        </div>
      </div>
      {(downloading || downloadError) && (
        <div
          className="viewer-download-status"
          role="status"
          aria-live="polite"
        >
          {downloading ? (
            <>
              <LoaderCircle className="spin" size={15} />
              <span>
                {downloading === "original" && art.provider === "cleveland" ? "馆方高清 JPEG" : variantLabel[downloading]} ·{" "}
                {progress ? formatBytes(progress.received) : "正在连接…"}
                {progress?.total
                  ? ` / ${formatBytes(progress.total)} · ${Math.round((progress.received / progress.total) * 100)}%`
                  : ""}
                {progress ? ` · ${formatBytes(progress.speedBps)}/s` : ""}
              </span>
              {progress?.total && (
                <progress value={progress.received} max={progress.total} />
              )}
            </>
          ) : (
            <span>{downloadError}</span>
          )}
        </div>
      )}
      <div
        ref={canvas}
        className="viewer-canvas"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          drag.current = { x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const x = event.clientX - drag.current.x,
            y = event.clientY - drag.current.y;
          drag.current = { x: event.clientX, y: event.clientY };
          setPan((p) => ({ x: p.x + x, y: p.y + y }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {total > 1 && (
          <>
            <button
              className="viewer-page viewer-page-previous"
              aria-label="上一张"
              title="上一张 · ←"
              disabled={position === 0}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onPrevious}
            >
              <ChevronLeft size={28} />
            </button>
            <button
              className="viewer-page viewer-page-next"
              aria-label="下一张"
              title="下一张 · →"
              disabled={position === total - 1}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onNext}
            >
              <ChevronRight size={28} />
            </button>
          </>
        )}
        <canvas
          ref={pixels}
          className="viewer-render-canvas"
          role="img"
          aria-label={art.title}
          data-pan-x={pan.x}
          data-pan-y={pan.y}
        />
        {source.url ? (
          <img
            ref={image}
            className="viewer-source-image"
            src={source.url}
            alt=""
            draggable={false}
            onLoad={(event) => {
              const img = event.currentTarget;
              setLoaded({
                url: img.currentSrc || source.url,
                width: img.naturalWidth,
                height: img.naturalHeight,
              });
              const element = canvas.current;
              if (element && img.naturalWidth && img.naturalHeight)
                setFitRatio(
                  Math.min(
                    1,
                    element.clientWidth / img.naturalWidth,
                    element.clientHeight / img.naturalHeight,
                  ),
                );
            }}
            onError={() => {
              setLoaded(null);
              if (source.variant !== "preview") {
                desired.current = "preview";
                setSelected("preview");
                setSource({
                  url: available.preview || art.thumb,
                  variant: "preview",
                });
                setDownloadError("该尺寸无法显示，请换一个画质重试。");
              }
            }}
          />
        ) : (
          <div className="viewer-loading">正在打开画作…</div>
        )}
      </div>
      <div className="viewer-hint">
        {total > 1 ? "← → 切换作品 · " : ""}选择画质后按需下载 · 滚轮缩放 · 左键拖动 · Esc 退出
      </div>
    </div>,
    document.body,
  );
}
