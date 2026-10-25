import { test, expect, type Page } from "@playwright/test";

async function mockDesktop(page: Page, failSynthesis = false) {
  await page.addInitScript(({ failSynthesis }) => {
    const state = window as any;
    state.isTauri = true;
    state.__curatorCalls = [];
    state.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        state.__curatorCalls.push({ command, args });
        if (command === "load_library") return localStorage.getItem("fixture-library") || JSON.stringify({
          version: 1, saved: [], viewed: [], conversations: [],
          settings: { useAi: true, baseUrl: "https://model.example/v1", model: "fixture", scope: "google", theme: "light", explanationFontSize: 16, webSearch: true },
        });
        if (command === "save_library") { localStorage.setItem("fixture-library", args.data); return; }
        if (command === "commons_query") return { query: { pages: [] } };
        if (command === "met_query") return { total: 0, objectIDs: [] };
        if (command === "museum_query") {
          const q = new URLSearchParams(args.query).get("q") || "";
          if (args.provider !== "chicago" || !q.includes("Artem")) return { data: [] };
          return { config: { iiif_url: "https://www.artic.edu/iiif/2" }, pagination: { total: 2 }, data: [
            { id: 1, title: "Study in Green", artist_display: "Artem Rohovyi", is_public_domain: true, image_id: "2d484387-2509-5e8e-2c43-22f9981972eb" },
            { id: 2, title: "Unrelated Seurat", artist_display: "Georges Seurat", is_public_domain: true, image_id: "3d484387-2509-5e8e-2c43-22f9981972eb" },
          ] };
        }
        if (command === "web_image_search") return { results: [{ title: "Artem Rohovyi artworks", url: "https://rohovyiart.com/", thumbnail: { src: "https://imgs.search.brave.com/fixture" } }] };
        if (command === "ai_plan") {
          const messages = args.messages;
          const last = messages.at(-1).content;
          if (messages[0].content.includes("先决定是否需要搜索")) {
            return JSON.stringify(last === "Artem Rohovyi"
              ? { action: "search", query: "Artem Rohovyi", targetArtist: "Artem Rohovyi", explanation: "查找作者作品" }
              : { action: "discuss", query: "", explanation: "回答已有作品问题" });
          }
          if (failSynthesis) throw new Error("HTTP 503 fixture model unavailable");
          const evidence = JSON.parse(typeof last === "string" ? last : last[0].text);
          if (evidence.currentSearch) {
            const actual = evidence.currentSearch.results;
            if (actual.length !== 1 || actual[0].artist !== "Artem Rohovyi") throw new Error("wrong evidence");
            if (evidence.currentSearch.webResults[0].url !== "https://rohovyiart.com/") throw new Error("missing web evidence");
            return JSON.stringify({ text: `本次找到《${actual[0].title}》，作者为 ${actual[0].artist}。另有官网网页线索，归属与授权待核实。`, selectionReasons: [{ id: actual[0].id, reason: "作者与请求一致，适合继续了解其作品。", basis: "metadata" }] });
          }
          const previous = messages.slice(1, -1).map((m: any) => { try { return JSON.parse(m.content); } catch { return {}; } }).find((m: any) => m.latestDisplayedResults);
          if (!previous?.results?.length) throw new Error("lost result context");
          return `第 1 张是《${previous.results[0].title}》，作者是 ${previous.results[0].artist}。`;
        }
        if (command === "cached_image") return null;
        if (command === "cache_image") throw new Error("fixture: use remote preview");
        if (command === "plugin:event|listen") return 1;
        if (command === "plugin:event|unlisten") return;
        if (command === "open_external") return;
        return null;
      },
    };
  }, { failSynthesis });
  await page.route(/https:\/\/(www\.artic\.edu|imgs\.search\.brave\.com)\//, (route) => route.fulfill({
    contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
  }));
  await page.goto("/");
  await expect(page.locator(".discover-loading")).toHaveCount(0);
  await page.getByRole("button", { name: /开启一场艺术对话/ }).click();
  await page.getByRole("textbox", { name: "向策展人描述想看的画作" }).fill("Artem Rohovyi");
  await page.getByRole("button", { name: "发送", exact: true }).click();
}

test("search results ground the answer and follow-ups do not run another search", async ({ page }) => {
  await mockDesktop(page);
  await expect(page.locator(".message-text").last()).toContainText("本次找到《Study in Green》");
  await expect(page.getByRole("heading", { name: "Unrelated Seurat" })).toHaveCount(0);
  await expect(page.locator(".art-number")).toHaveText("作品 1");
  await expect(page.locator(".search-notice").first()).toContainText("作者不匹配");
  await expect(page.getByRole("link", { name: /网页 1/ })).toHaveAttribute("href", "https://rohovyiart.com/");
  await expect(page.locator(".art-selection-reason")).toContainText("作者与请求一致");
  await expect(page.locator(".art-selection-reason small")).toContainText("作者字段匹配");
  await expect(page.locator(".web-selection-reason")).toContainText("作者待核实");
  const searches = await page.evaluate(() => (window as any).__curatorCalls.filter((c: any) => ["commons_query", "museum_query", "met_query", "web_image_search"].includes(c.command)).length);
  await page.getByRole("textbox", { name: "向策展人描述想看的画作" }).fill("第一张是谁画的？");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".message-text").last()).toHaveText("第 1 张是《Study in Green》，作者是 Artem Rohovyi。");
  expect(await page.evaluate(() => (window as any).__curatorCalls.filter((c: any) => ["commons_query", "museum_query", "met_query", "web_image_search"].includes(c.command)).length)).toBe(searches);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("fixture-library")!).conversations[0].messages.length)).toBe(4);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("fixture-library")!).conversations[0].messages[1].artworks[0].curatorReason)).toBe("作者与请求一致，适合继续了解其作品。");
  await page.screenshot({ path: "test-results/curator-results.png", fullPage: true });
});

test("model failure after retrieval preserves artworks and web clues", async ({ page }) => {
  await mockDesktop(page, true);
  await expect(page.locator(".message-text").last()).toContainText("AI 结果解读暂不可用");
  await expect(page.getByRole("button", { name: "欣赏 Study in Green" })).toBeVisible();
  await expect(page.getByRole("link", { name: /网页 1/ })).toBeVisible();
  await expect(page.locator(".art-selection-reason")).toContainText("作者字段匹配");
  await page.getByRole("textbox", { name: "向策展人描述想看的画作" }).fill("继续聊聊这幅作品");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
});
