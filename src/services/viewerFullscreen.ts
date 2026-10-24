interface FullscreenWindow {
  isFullscreen(): Promise<boolean>;
  setFullscreen(fullscreen: boolean): Promise<void>;
}

// Native fullscreen transitions are asynchronous (notably on macOS). Serialize
// them so closing and quickly reopening a viewer cannot undo the new session.
export class ViewerFullscreenController {
  private pending = Promise.resolve();
  private open = false;
  private ownsFullscreen = false;

  constructor(private readonly window: FullscreenWindow) {}

  enter(): Promise<void> {
    this.open = true;
    const operation = this.pending.then(async () => {
      if (!this.open || this.ownsFullscreen) return;
      const alreadyFullscreen = await this.window.isFullscreen();
      if (!this.open || alreadyFullscreen) return;
      await this.window.setFullscreen(true);
      this.ownsFullscreen = true;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  exit(): Promise<void> {
    this.open = false;
    const operation = this.pending.then(async () => {
      if (!this.ownsFullscreen) return;
      this.ownsFullscreen = false;
      await this.window.setFullscreen(false);
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
