import { useEffect, useRef, useState, type PointerEvent } from "react";
import { LoaderCircle, Move, X } from "lucide-react";
import type { Artwork } from "../types";
import { cacheArtwork, cachedArtwork, localImage } from "../services/storage";

type Quality = "preview" | "medium" | "hd" | "original";
const label: Record<Quality, string> = {
  preview: "预览图",
  medium: "标准图",
  hd: "高清图",
  original: "原图",
};
const panelWidth = () => Math.min(440, Math.max(280, window.innerWidth - 24));
const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));

export default function FloatingArtwork({
  art,
  originalLocal,
  onClose,
}: {
  art: Artwork;
  originalLocal?: string;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const ownedUrls = useRef(new Set<string>());
  const [position, setPosition] = useState(() => ({
    x: Math.max(0, window.innerWidth - panelWidth() - 28),
    y: Math.min(130, Math.max(0, window.innerHeight - 160)),
  }));
  const [source, setSource] = useState({ url: art.medium || art.thumb, quality: (art.medium ? "medium" : "preview") as Quality });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    mounted.current = true;
    setSource({ url: art.medium || art.thumb, quality: art.medium ? "medium" : "preview" });
    setError("");
    const loadCached = async () => {
      for (const quality of ["original", "hd", "medium", "preview"] as const) {
        try {
          const local = (quality === "original" ? originalLocal : undefined) ||
            await cachedArtwork(art.id, quality);
          if (!local) continue;
          const url = await localImage(local);
          if (!alive) {
            if (url.startsWith("blob:")) URL.revokeObjectURL(url);
            return;
          }
          if (url.startsWith("blob:")) ownedUrls.current.add(url);
          setSource({ url, quality });
          return;
        } catch {
          // A stale cache must not prevent the remote preview from showing.
        }
      }
    };
    void loadCached();
    return () => {
      alive = false;
      mounted.current = false;
      ownedUrls.current.forEach((url) => URL.revokeObjectURL(url));
      ownedUrls.current.clear();
    };
  }, [art.id, art.medium, art.thumb, originalLocal]);

  useEffect(() => {
    const keepVisible = () => setPosition((current) => ({
      x: clamp(current.x, Math.max(0, window.innerWidth - (panel.current?.offsetWidth || panelWidth()))),
      y: clamp(current.y, Math.max(0, window.innerHeight - (panel.current?.offsetHeight || 120))),
    }));
    window.addEventListener("resize", keepVisible);
    return () => window.removeEventListener("resize", keepVisible);
  }, []);

  function moveTo(x: number, y: number) {
    setPosition({
      x: clamp(x, Math.max(0, window.innerWidth - (panel.current?.offsetWidth || panelWidth()))),
      y: clamp(y, Math.max(0, window.innerHeight - (panel.current?.offsetHeight || 120))),
    });
  }
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: position.x, top: position.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function dragMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (current?.pointerId === event.pointerId)
      moveTo(current.left + event.clientX - current.x, current.top + event.clientY - current.y);
  }
  function stopDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }
  async function loadOriginal() {
    setLoading(true);
    setError("");
    try {
      const url = await localImage(originalLocal || await cacheArtwork(art.id, art.original, "original"));
      if (!mounted.current) {
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
        return;
      }
      if (url.startsWith("blob:")) ownedUrls.current.add(url);
      setSource({ url, quality: "original" });
    } catch {
      if (mounted.current) setError("馆方暂未提供可下载的原图；当前图片仍可查看。");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  return (
    <section
      ref={panel}
      className="floating-artwork"
      role="dialog"
      aria-modal="false"
      aria-label={`作品浮窗 ${art.title}`}
      style={{ left: position.x, top: position.y }}
    >
      <div
        className="floating-artwork-handle"
        aria-label="拖动图片浮窗"
        tabIndex={0}
        onPointerDown={startDrag}
        onPointerMove={dragMove}
        onPointerUp={stopDrag}
        onLostPointerCapture={stopDrag}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 40 : 10;
          if (event.key === "ArrowLeft") moveTo(position.x - step, position.y);
          else if (event.key === "ArrowRight") moveTo(position.x + step, position.y);
          else if (event.key === "ArrowUp") moveTo(position.x, position.y - step);
          else if (event.key === "ArrowDown") moveTo(position.x, position.y + step);
          else return;
          event.preventDefault();
        }}
      >
        <Move size={16} />
        <strong title={art.title}>{art.title}</strong>
        <button aria-label="关闭图片浮窗" onClick={onClose}><X size={18} /></button>
      </div>
      <div className="floating-artwork-image">
        <img
          src={source.url}
          alt={art.title}
          onError={() => {
            if (source.url !== art.thumb) setSource({ url: art.thumb, quality: "preview" });
            else setError("图片暂不可用，请稍后重试。");
          }}
        />
      </div>
      <div className="floating-artwork-footer">
        <span>当前画质：{label[source.quality]}</span>
        {source.quality !== "original" && (
          <button disabled={loading} onClick={() => void loadOriginal()}>
            {loading ? <LoaderCircle className="spin" size={13} /> : null}
            {loading ? "正在加载…" : "加载原图"}
          </button>
        )}
      </div>
      {error && <p className="floating-artwork-error" role="status">{error}</p>}
    </section>
  );
}
