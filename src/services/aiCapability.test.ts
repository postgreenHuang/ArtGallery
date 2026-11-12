import { afterEach, expect, it } from "vitest";
import { defaultLibrary } from "../types";
import { canSendImages, clearImageCapabilityCache, imageCapabilityNote, rememberImageUnsupported } from "./aiCapability";

afterEach(clearImageCapabilityCache);

it("does not disable vision for a remote thumbnail fetch error", () => {
  rememberImageUnsupported(defaultLibrary.settings, "HTTP 400 failed to download image from URL");
  expect(canSendImages(defaultLibrary.settings)).toBe(true);
  expect(imageCapabilityNote(defaultLibrary.settings)).toBeUndefined();
});

it("explains an explicit model image refusal for this configuration", () => {
  rememberImageUnsupported(defaultLibrary.settings, "HTTP 400 image input is not supported by this model");
  expect(canSendImages(defaultLibrary.settings)).toBe(false);
  expect(imageCapabilityNote(defaultLibrary.settings)).toContain("明确拒绝图片输入");
});
