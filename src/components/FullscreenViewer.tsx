import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine,
  LoaderCircle,
  Minus,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import type { Artwork, SavedArtwork } from "../types";
import { localImage } from "../services/storage";

const clamp = (value: number, maximum = 16) =>
  Math.min(maximum, Math.max(1, value));

export default function FullscreenViewer({
  art,
  saved,
  originalLocal,
  loadingOriginal,
  originalError,
  onLoadOriginal,
  onClose,
}: {
  art: Artwork;
  saved?: SavedArtwork;
  originalLocal?: string;
  loadingOriginal: boolean;
  originalError: boolean;
  onLoadOriginal: () => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState({
    url: originalLocal || saved ? "" : art.thumb,
    original: false,
  });
  const [loaded, setLoaded] = useState<{
    url: string;
    width: number;
    height: number;
  } | null>(null);
  const [fitRatio, setFitRatio] = useState(1);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const canvas = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    let objectUrl = "";
    const local = originalLocal || saved?.local;
    if (local)
      localImage(local)
        .then((url) => {
          objectUrl = url;
          if (alive) {
            setLoaded(null);
            setSource({ url, original: true });
          }
        })
        .catch(() => {
          if (alive) {
            setLoaded(null);
            setSource({ url: art.thumb, original: false });
          }
        });
    else {
      setLoaded(null);
      setSource({ url: art.thumb, original: false });
    }
    return () => {
      alive = false;
      if (objectUrl.startsWith("blob:")) URL.revokeObjectURL(objectUrl);
    };
  }, [art.id, art.thumb, saved?.local, originalLocal]);

  useEffect(() => {
    const element = canvas.current;
    if (!element || !loaded) return;
    const update = () => {
      const img = image.current;
      if (img?.clientWidth) setFitRatio(img.clientWidth / loaded.width);
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
    close.current?.focus();
    const htmlOverflow = document.documentElement.style.overflow;
    const bodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
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
  }, [onClose, maximum]);

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
        </div>
        <div className="viewer-actions">
          {!originalLocal && !saved && (
            <button
              onClick={onLoadOriginal}
              disabled={loadingOriginal}
              title="加载 Wikimedia 原始分辨率"
            >
              {loadingOriginal ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <ArrowDownToLine size={17} />
              )}
              <span>
                {loadingOriginal
                  ? "原图下载中"
                  : originalError
                    ? "重试原图"
                    : "加载原图"}
              </span>
            </button>
          )}
          <span className="viewer-resolution" aria-live="polite">
            {loaded?.url === source.url
              ? `${source.original ? "已显示原图" : "当前为缩略图"} · ${loaded.width} × ${loaded.height}px`
              : source.original
                ? "原图解码中…"
                : "缩略图加载中…"}
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
            {actualPercent === null ? "" : `原图 ${actualPercent}%`}
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
            ref={close}
            className="viewer-close"
            onClick={onClose}
            aria-label="退出全屏"
          >
            <X size={22} />
          </button>
        </div>
      </div>
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
        {source.url ? (
          <img
            ref={image}
            src={source.url}
            alt={art.title}
            draggable={false}
            onLoad={(event) => {
              const img = event.currentTarget;
              setLoaded({
                url: img.currentSrc || source.url,
                width: img.naturalWidth,
                height: img.naturalHeight,
              });
              if (img.naturalWidth)
                setFitRatio(img.clientWidth / img.naturalWidth);
            }}
            onError={() => {
              setLoaded(null);
              if (source.original)
                setSource({ url: art.thumb, original: false });
            }}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            }}
          />
        ) : (
          <div className="viewer-loading">正在打开画作…</div>
        )}
      </div>
      <div className="viewer-hint">
        滚轮缩放 · 左键拖动 · 1:1 查看真实像素 · Esc 退出
      </div>
    </div>,
    document.body,
  );
}
