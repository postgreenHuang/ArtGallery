import { describe, expect, it, vi } from "vitest";
import { ViewerFullscreenController } from "./viewerFullscreen";

describe("ViewerFullscreenController", () => {
  it("preserves an app window that was already fullscreen", async () => {
    const window = {
      isFullscreen: vi.fn().mockResolvedValue(true),
      setFullscreen: vi.fn().mockResolvedValue(undefined),
    };
    const viewer = new ViewerFullscreenController(window);

    await viewer.enter();
    await viewer.exit();

    expect(window.isFullscreen).toHaveBeenCalledOnce();
    expect(window.setFullscreen).not.toHaveBeenCalled();
  });

  it("exits native fullscreen only when the viewer entered it", async () => {
    const window = {
      isFullscreen: vi.fn().mockResolvedValue(false),
      setFullscreen: vi.fn().mockResolvedValue(undefined),
    };
    const viewer = new ViewerFullscreenController(window);

    await viewer.enter();
    await viewer.exit();

    expect(window.setFullscreen.mock.calls).toEqual([[true], [false]]);
  });

  it("does not enter fullscreen after the viewer closes during the initial check", async () => {
    let finishCheck!: (value: boolean) => void;
    const window = {
      isFullscreen: vi.fn(() => new Promise<boolean>((resolve) => { finishCheck = resolve; })),
      setFullscreen: vi.fn().mockResolvedValue(undefined),
    };
    const viewer = new ViewerFullscreenController(window);

    const entering = viewer.enter();
    await vi.waitFor(() => expect(window.isFullscreen).toHaveBeenCalledOnce());
    const exiting = viewer.exit();
    finishCheck(false);
    await Promise.all([entering, exiting]);

    expect(window.setFullscreen).not.toHaveBeenCalled();
  });

  it("serializes a close and immediate reopen", async () => {
    let fullscreen = false;
    const window = {
      isFullscreen: vi.fn(async () => fullscreen),
      setFullscreen: vi.fn(async (value: boolean) => { fullscreen = value; }),
    };
    const viewer = new ViewerFullscreenController(window);

    await viewer.enter();
    const closing = viewer.exit();
    const reopening = viewer.enter();
    await Promise.all([closing, reopening]);

    expect(fullscreen).toBe(true);
    expect(window.setFullscreen.mock.calls).toEqual([[true], [false], [true]]);
  });
});
