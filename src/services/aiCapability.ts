import type { Settings } from "../types";

const unsupportedImages = new Map<string, { until: number; reason: string }>();
const ttl = 15 * 60 * 1000;
const key = (settings: Settings) => `${settings.baseUrl.trim().toLowerCase()}\n${settings.model.trim()}`;

export function canSendImages(settings: Settings): boolean {
  const entry = unsupportedImages.get(key(settings));
  if (!entry) return true;
  if (entry.until <= Date.now()) { unsupportedImages.delete(key(settings)); return true; }
  return false;
}
export function imageCapabilityNote(settings: Settings): string | undefined {
  if (canSendImages(settings)) return;
  return unsupportedImages.get(key(settings))?.reason;
}
export function isImageCompatibilityError(error: unknown): boolean {
  return /400|422|image|vision|图片|多模态/i.test(String(error));
}
export function rememberImageUnsupported(settings: Settings, error: unknown): void {
  // A remote image fetch failure does not prove the model lacks vision. Cache
  // only an explicit refusal of image inputs, not every error mentioning image.
  if (/(?:image|vision|图片|多模态|image_url|multimodal).{0,80}(?:unsupported|not support|not allowed|不支持|不接受)|(?:unsupported|not support|not allowed|不支持|不接受).{0,80}(?:image|vision|图片|多模态|image_url|multimodal)/i.test(String(error)))
    unsupportedImages.set(key(settings), { until: Date.now() + ttl, reason: "当前模型或接口明确拒绝图片输入；15 分钟后会自动重试图片。" });
}
export function clearImageCapabilityCache(): void { unsupportedImages.clear(); }
