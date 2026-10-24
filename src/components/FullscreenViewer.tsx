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

const clamp = (value: number) => Math.min(16, Math.max(1, value));

export default function FullscreenViewer({
  art,
  saved,
  highUrl,
  loadingHigh,
  onLoadHigh,
  onClose,
}: {
  art: Artwork;
  saved?: SavedArtwork;
  highUrl?: string;
  loadingHigh: boolean;
  onLoadHigh: () => void;
  onClose: () => void;
}) {
  const [src, setSrc] = useState(highUrl || (saved ? "" : art.thumb));
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    let objectUrl = "";
    if (highUrl) setSrc(highUrl);
    else if (saved)
      localImage(saved.local)
        .then((url) => {
          objectUrl = url;
          if (alive) setSrc(url);
        })
        .catch(() => {
          if (alive) setSrc(art.thumb);
        });
    else setSrc(art.thumb);
    return () => {
      alive = false;
      if (objectUrl.startsWith("blob:")) URL.revokeObjectURL(objectUrl);
    };
  }, [art.id, art.thumb, saved?.local, highUrl]);

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
        setScale((s) => clamp(s * 1.25));
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
  }, [onClose]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left - rect.width / 2;
      const y = event.clientY - rect.top - rect.height / 2;
      setScale((old) => {
        const next = clamp(old * Math.exp(-event.deltaY * 0.002));
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
  }, []);

  const zoom = (factor: number) => {
    setScale((old) => {
      const next = clamp(old * factor);
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
          {!highUrl && !saved && (
            <button
              onClick={onLoadHigh}
              disabled={loadingHigh}
              title="加载 2400px 高清预览"
            >
              {loadingHigh ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <ArrowDownToLine size={17} />
              )}
              <span>高清预览</span>
            </button>
          )}
          <button onClick={() => zoom(1 / 1.25)} aria-label="缩小">
            <Minus size={17} />
          </button>
          <span className="viewer-scale">{Math.round(scale * 100)}%</span>
          <button onClick={() => zoom(1.25)} aria-label="放大">
            <Plus size={17} />
          </button>
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
        className={`viewer-canvas ${scale > 1 ? "can-pan" : ""}`}
        onPointerDown={(event) => {
          if (event.button !== 0 || (scale <= 1 && !event.ctrlKey)) return;
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
        {src ? (
          <img
            src={src}
            alt={art.title}
            draggable={false}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            }}
          />
        ) : (
          <div className="viewer-loading">正在打开画作…</div>
        )}
      </div>
      <div className="viewer-hint">
        Ctrl + 滚轮缩放 · Ctrl + 左键拖动画作 · Esc 退出
      </div>
    </div>,
    document.body,
  );
}
