import { get, del, keys, set } from "idb-keyval";
import { invoke, convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { defaultLibrary, type Library } from "../types";
export const desktop = isTauri();
let writes = Promise.resolve();
export async function readLibrary(): Promise<Library> {
  const value = desktop
    ? await invoke<string | null>("load_library")
    : await get<string>("library");
  if (!value) return structuredClone(defaultLibrary);
  const parsed = JSON.parse(value) as Library;
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.saved) ||
    !Array.isArray(parsed.conversations)
  )
    throw new Error("本地资料格式不兼容，请先备份资料。");
  return {
    ...parsed,
    settings: { ...defaultLibrary.settings, ...parsed.settings },
  };
}
export function writeLibrary(library: Library) {
  const data = JSON.stringify(library);
  const next = writes
    .catch(() => {})
    .then(() =>
      desktop ? invoke<void>("save_library", { data }) : set("library", data),
    );
  writes = next;
  return next;
}
const downloads = new Map<string, Promise<string>>();
export type ImageVariant = "preview" | "hd" | "original" | "collection";
export async function cacheArtwork(
  id: number,
  url: string,
  variant: ImageVariant = "preview",
): Promise<string> {
  if (desktop) {
    const cacheKey = `${id}-${variant}`;
    const pending = downloads.get(cacheKey);
    if (pending) return pending;
    const download = invoke<string>("cache_image", {
      id,
      url,
      variant,
    }).finally(() => downloads.delete(cacheKey));
    downloads.set(cacheKey, download);
    return download;
  }
  const cacheKey = `art-${id}:${variant}`;
  if (await get<Blob>(cacheKey)) return `idb:${id}:${variant}`;
  if (variant === "collection") {
    const cached = await get<Blob>(`art-${id}:original`);
    if (cached) {
      await set(cacheKey, cached);
      return `idb:${id}:${variant}`;
    }
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(
      variant === "original" || variant === "collection" ? 300000 : 45000,
    ),
  });
  if (response.status === 429)
    throw new Error(
      "Wikimedia 暂时限制下载（HTTP 429），请稍后重试；已下载的本地作品仍可查看。",
    );
  if (!response.ok) throw new Error(`图片下载失败 (${response.status})`);
  if (Number(response.headers.get("content-length") || 0) > 512 * 1024 * 1024)
    throw new Error("原图超过 512 MB，请从 Wikimedia 来源页查看");
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("下载内容不是图片");
  if (blob.size > 512 * 1024 * 1024)
    throw new Error("原图超过 512 MB，请从 Wikimedia 来源页查看");
  await set(cacheKey, blob);
  return `idb:${id}:${variant}`;
}
export async function localImage(local: string): Promise<string> {
  if (desktop)
    return convertFileSrc(
      await invoke<string>("image_path", { relative: local }),
    );
  const blob = await get<Blob>(`art-${local.replace("idb:", "")}`);
  if (!blob) throw new Error("本地图片已丢失，请重新收藏");
  return URL.createObjectURL(blob);
}
export async function clearTemporaryImages(savedLocals: string[]) {
  if (desktop)
    return invoke<{ files: number; bytes: number }>("clear_image_cache");
  const keep = new Set(
    savedLocals.map((local) => `art-${local.replace("idb:", "")}`),
  );
  const cached = (await keys()).filter(
    (key): key is string =>
      typeof key === "string" &&
      /^art-\d+(?::(?:preview|hd|original))?$/.test(key) &&
      !keep.has(key),
  );
  let bytes = 0;
  for (const key of cached) {
    bytes += (await get<Blob>(key))?.size || 0;
    await del(key);
  }
  return { files: cached.length, bytes };
}
