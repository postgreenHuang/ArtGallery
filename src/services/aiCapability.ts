import type { Settings } from "../types";

const unsupportedImages = new Map<string, number>();
const ttl = 15 * 60 * 1000;
const key = (settings: Settings) => `${settings.baseUrl.trim().toLowerCase()}\n${settings.model.trim()}`;

export function canSendImages(settings: Settings): boolean {
  const until = unsupportedImages.get(key(settings));
  if (!until) return true;
  if (until <= Date.now()) { unsupportedImages.delete(key(settings)); return true; }
  return false;
}
export function isImageCompatibilityError(error: unknown): boolean {
  return /400|422|image|vision|图片|多模态/i.test(String(error));
}
export function rememberImageUnsupported(settings: Settings, error: unknown): void {
  // A bare 400/422 can also mean an unrelated malformed request. Only cache
  // an explicit image/multimodal rejection; still allow a one-off text retry.
  if (/image|vision|图片|多模态|image_url|multimodal/i.test(String(error)))
    unsupportedImages.set(key(settings), Date.now() + ttl);
}
export function clearImageCapabilityCache(): void { unsupportedImages.clear(); }
