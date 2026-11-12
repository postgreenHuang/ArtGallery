import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import FloatingArtwork from "./FloatingArtwork";
import { parseFloatingArtworkPayload } from "../domain/floatingArtwork";
import { desktop } from "../services/storage";

export default function FloatingArtworkPage({ payload }: { payload: string | null }) {
  const parsed = parseFloatingArtworkPayload(payload);
  useEffect(() => {
    if (!parsed) return;
    document.documentElement.dataset.theme = parsed.theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
      : parsed.theme;
  }, [parsed?.theme]);
  if (!parsed) return <main className="floating-window-invalid">无法读取这幅画的窗口资料，请从讲解对话重新打开。</main>;
  return <FloatingArtwork art={parsed.art} originalLocal={parsed.originalLocal} nativeWindow
    onClose={() => { if (desktop) void getCurrentWindow().close(); else window.close(); }} />;
}
