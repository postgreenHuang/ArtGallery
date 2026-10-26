import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Artwork, WebResult } from "../types";
import { enrichSources, extractPageText, isGatePage, readPageEvidence } from "./pageEvidence";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./storage", () => ({ desktop: true }));
beforeEach(() => { invoke.mockReset(); });

describe("source-page evidence", () => {
  it("extracts the main work description and omits navigation, scripts and hidden text", () => {
    const page = extractPageText(`<html><head><title>Blue &amp; Gold</title><script>ignore script</script></head>
      <body><nav>Unrelated works</nav><main><h1>Blue &amp; Gold</h1>
      <div hidden>Hidden painting</div><p>Oil painting by Example Artist in 1912.</p></main><footer>Cookies</footer></body></html>`);
    expect(page.title).toBe("Blue & Gold");
    expect(page.text).toContain("Oil painting by Example Artist");
    expect(page.text).not.toMatch(/Unrelated works|ignore script|Hidden painting|Cookies/);
  });
  it("labels login and bot-check pages unavailable, not read", async () => {
    expect(isGatePage("Just a moment...", "Please wait")).toBe(true);
    invoke.mockResolvedValue({ url: "https://gallery.example/login", html: `<title>Sign in</title><main>Please sign in to view this artwork and continue to the gallery. This page requires an account.</main>` });
    const page = await readPageEvidence("https://gallery.example/login", new AbortController().signal);
    expect(page.status).toBe("unavailable");
    expect(page.error).toContain("没有足够的可读文字");
  });
  it("rejects unsafe URLs and checks cancellation after a late response", async () => {
    expect((await readPageEvidence("https://127.0.0.1/private", new AbortController().signal)).status).toBe("unavailable");
    const controller = new AbortController();
    invoke.mockImplementation(async () => { controller.abort(); return { url: "https://gallery.example/late", html: "<main>Late artwork page with text that must not be accepted.</main>" }; });
    await expect(readPageEvidence("https://gallery.example/late", controller.signal)).rejects.toThrow("已停止");
  });
  it("limits source-page requests to six with at most three in flight", async () => {
    let active = 0;
    let peak = 0;
    invoke.mockImplementation(async (...call) => {
      const args = call[1];
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return { url: args.url, html: `<title>Artwork</title><main>Artist Example made this painting in 1912. The page supplies enough public descriptive text.</main>` };
    });
    const artworks = Array.from({ length: 10 }, (_, id) => ({ id, description: "", source: `https://museum.example/work/${id}` }) as Artwork);
    const webResults = Array.from({ length: 10 }, (_, index) => ({ url: `https://gallery.example/work/${index}` }) as WebResult);
    const enriched = await enrichSources(artworks, webResults, new AbortController().signal);
    expect(invoke).toHaveBeenCalledTimes(6);
    expect(peak).toBeLessThanOrEqual(3);
    expect(enriched.webResults.slice(0, 2).every((item) => item.pageEvidence?.status === "read")).toBe(true);
    expect(enriched.webResults.slice(2).every((item) => !item.pageEvidence)).toBe(true);
  });
});
