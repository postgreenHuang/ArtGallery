import { test, expect, type Page } from "@playwright/test";

async function mockDesktop(page: Page, failSynthesis = false, reviewScenario = false, slowReview = false, slowPageReview = false) {
  await page.addInitScript(({ failSynthesis, reviewScenario, slowReview, slowPageReview }) => {
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
          const params = new URLSearchParams(args.query);
          const q = params.get("q") || "";
          if (args.provider !== "chicago" || !q.includes("Artem")) return { data: [] };
          if (reviewScenario && params.get("page") === "2") return { config: { iiif_url: "https://www.artic.edu/iiif/2" }, pagination: { total: 12 }, data: [
            { id: 5, title: "Second Portrait", artist_display: "Artem Rohovyi", is_public_domain: true, image_id: "6d484387-2509-5e8e-2c43-22f9981972eb" },
            { id: 6, title: "Second Landscape", artist_display: "Artem Rohovyi", is_public_domain: true, image_id: "7d484387-2509-5e8e-2c43-22f9981972eb" },
          ] };
          return { config: { iiif_url: "https://www.artic.edu/iiif/2" }, pagination: { total: reviewScenario ? 12 : 2 }, data: [
            { id: 1, title: reviewScenario ? "Blue Landscape" : "Study in Green", artist_display: "Artem Rohovyi", is_public_domain: true, image_id: "2d484387-2509-5e8e-2c43-22f9981972eb" },
            { id: 2, title: "Unrelated Seurat", artist_display: "Georges Seurat", is_public_domain: true, image_id: "3d484387-2509-5e8e-2c43-22f9981972eb" },
            ...(reviewScenario ? [
              { id: 3, title: "Portrait Study", artist_display: "Artem Rohovyi", is_public_domain: true, image_id: "4d484387-2509-5e8e-2c43-22f9981972eb" },
              { id: 4, title: "Untitled Study", artist_display: "Artem Rohovyi", is_public_domain: true, image_id: "5d484387-2509-5e8e-2c43-22f9981972eb" },
            ] : []),
          ] };
        }
        if (command === "web_image_search") return { results: [{ title: reviewScenario ? "Art landscapes archive" : "Artem Rohovyi artworks", url: "https://rohovyiart.com/", thumbnail: { src: "https://imgs.search.brave.com/fixture" } }] };
        if (command === "read_source_page") return { url: args.url, html: reviewScenario
          ? args.url.includes("artworks/3") || args.url.includes("artworks/5") ? "<title>Portrait Study</title><main>Portrait Study is a Self-Portrait by Artem Rohovyi, showing the artist's face and figure.</main>"
            : args.url.includes("rohovyiart.com") ? "<title>Art landscapes archive</title><main>Art landscapes archive contains stock photos, not original paintings by the requested artist.</main>"
              : "<title>Artwork details</title><main>This public artwork page provides title and author details for the listed painting.</main>"
          : "<title>Artem Rohovyi artworks</title><main>Artem Rohovyi artworks and paintings, presented by the artist.</main>" };
        if (command === "ai_plan") {
          const messages = args.messages;
          const last = messages.at(-1).content;
          if (messages[0].content.includes("先决定是否需要搜索")) {
            return JSON.stringify((last === "Artem Rohovyi" || reviewScenario && String(last).includes("Artem Rohovyi"))
              ? { action: "search", query: "Artem Rohovyi", targetArtist: "Artem Rohovyi", explanation: "查找作者作品", criteria: reviewScenario
                ? { required: ["风景画"], preferred: ["冷色"], excluded: ["肖像"], requiresImage: true } : undefined }
              : { action: "discuss", query: "", explanation: "回答已有作品问题" });
          }
          if (messages[0].content.includes("艺术检索质量复核员")) {
            if (slowReview) return new Promise(() => {});
            const payload = JSON.parse(typeof last === "string" ? last : last[0].text);
            if (slowPageReview && payload.candidates.some((item: any) => item.title === "Second Portrait")) return new Promise(() => {});
            return JSON.stringify({ decisions: payload.candidates.map((item: any) => {
              if (reviewScenario && ["Portrait Study", "Second Portrait"].includes(item.title)) return { key: item.key, verdict: "reject", reason: "来源页注明这是自画像", confidence: 0.96, basis: "page", quote: "Self-Portrait" };
              if (reviewScenario && item.title === "Art landscapes archive") return { key: item.key, verdict: "reject", reason: "网页是素材照片而非画作", confidence: 0.96, basis: "page", quote: "stock photos" };
              if (reviewScenario && item.title === "Untitled Study") return { key: item.key, verdict: "uncertain", reason: "画面条件无法确认", confidence: 0.5, basis: "metadata", quote: "Untitled Study" };
              if (reviewScenario) return { key: item.key, verdict: "keep", reason: "画面符合风景条件", confidence: 0.9, basis: "image", quote: "" };
              return item.key.startsWith("art:")
                ? { key: item.key, verdict: "keep", reason: "作者字段匹配", confidence: 0.9, basis: "metadata", quote: "Artem Rohovyi" }
                : { key: item.key, verdict: "uncertain", reason: "作者待核实", confidence: 0.5, basis: "metadata", quote: "Artem Rohovyi" };
            }) });
          }
          if (failSynthesis) throw new Error("HTTP 503 fixture model unavailable");
          const evidence = JSON.parse(typeof last === "string" ? last : last[0].text);
          if (evidence.currentSearch) {
            const actual = evidence.currentSearch.results;
            if (actual[0]?.artist !== "Artem Rohovyi") throw new Error("wrong evidence");
            if (reviewScenario) {
              if (actual.length !== 2 || evidence.currentSearch.rejected?.length !== 2) throw new Error("review did not filter");
              return JSON.stringify({ text: "复核后保留一件风景画，另一件仍待核实；自画像与素材网页已排除。", selectionReasons: [] });
            }
            if (actual.length !== 1 || evidence.currentSearch.webResults[0].url !== "https://rohovyiart.com/") throw new Error("missing web evidence");
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
  }, { failSynthesis, reviewScenario, slowReview, slowPageReview });
  await page.route(/https:\/\/(www\.artic\.edu|imgs\.search\.brave\.com)\//, (route) => route.fulfill({
    contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
  }));
  await page.goto("/");
  await expect(page.locator(".discover-loading")).toHaveCount(0);
  await page.getByRole("button", { name: /开启一场艺术对话/ }).click();
  await page.getByRole("textbox", { name: "向策展人描述想看的画作" }).fill(reviewScenario ? "想看 Artem Rohovyi 本人的冷色风景画，不要肖像" : "Artem Rohovyi");
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

test("source text removes contradicted works while uncertain items and audit stay available", async ({ page }) => {
  await mockDesktop(page, false, true);
  await expect(page.locator(".message-text").last()).toContainText("自画像与素材网页已排除");
  await expect(page.getByRole("button", { name: "欣赏 Blue Landscape" })).toBeVisible();
  await expect(page.getByRole("button", { name: "欣赏 Untitled Study" })).toBeVisible();
  await expect(page.getByRole("button", { name: "欣赏 Portrait Study" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /网页 1/ })).toHaveCount(0);
  await expect(page.locator(".art-number")).toHaveText(["作品 1", "作品 2"]);
  await page.getByText(/复核记录 · 保留 2 项 · 待核实 1 项 · 排除 2 项/).click();
  const audit = page.locator(".review-audit");
  await expect(audit).toContainText("Portrait Study");
  await expect(audit).toContainText("Art landscapes archive");
  await expect(audit).toContainText("Self-Portrait");
  await expect(audit).toContainText("stock photos");
  expect(await page.evaluate(() => {
    const messages = JSON.parse(localStorage.getItem("fixture-library")!).conversations[0].messages;
    return { kept: messages[1].artworks.length, rejected: messages[1].rejectedArtworks.length,
      rejectedWeb: messages[1].rejectedWebResults.length, pending: messages[1].reviewPending };
  })).toEqual({ kept: 2, rejected: 1, rejectedWeb: 1, pending: false });
  await page.getByRole("button", { name: "继续搜集作品" }).click();
  await expect(page.getByRole("button", { name: "欣赏 Second Landscape" })).toBeVisible();
  await expect(page.getByRole("button", { name: "欣赏 Second Portrait" })).toHaveCount(0);
  await expect(page.locator(".art-number")).toHaveText(["作品 1", "作品 2", "作品 3"]);
  await expect(audit).toContainText("Second Portrait");
  await page.getByRole("textbox", { name: "向策展人描述想看的画作" }).fill("第二张为什么待核实？");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".message-text").last()).toContainText("第 1 张是《Blue Landscape》");
  await page.reload();
  await page.getByRole("button", { name: /往日对话/ }).click();
  await page.locator(".history-list article > button:first-child").click();
  await expect(page.locator(".review-audit")).toContainText("Portrait Study");
});

test("stopping a slow review keeps candidates as uncertain and restores the composer", async ({ page }) => {
  await mockDesktop(page, false, false, true);
  await expect(page.getByText("正在逐件复核候选", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByRole("button", { name: "欣赏 Study in Green" })).toBeVisible();
  await expect(page.getByText("复核已停止，以下候选保留为待核实。")).toBeVisible();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await page.getByRole("textbox", { name: "向策展人描述想看的画作" }).fill("继续聊聊");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  await page.reload();
  await page.getByRole("button", { name: /往日对话/ }).click();
  await page.locator(".history-list article > button:first-child").click();
  await expect(page.getByRole("button", { name: "欣赏 Study in Green" })).toBeVisible();
  await expect(page.locator(".review-audit")).toContainText("待核实");
});

test("stopping a page review keeps newly found works without claiming a match", async ({ page }) => {
  await mockDesktop(page, false, true, false, true);
  await expect(page.getByRole("button", { name: "欣赏 Blue Landscape" })).toBeVisible();
  await page.getByRole("button", { name: "继续搜集作品" }).click();
  await expect(page.getByText("正在逐件复核新增候选", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByRole("button", { name: "欣赏 Second Portrait" })).toBeVisible();
  await expect(page.getByRole("button", { name: "欣赏 Second Landscape" })).toBeVisible();
  await expect(page.locator(".art-number")).toHaveText(["作品 1", "作品 2", "作品 3", "作品 4"]);
  await expect(page.getByText("分页复核已停止", { exact: false })).toBeVisible();
  await expect(page.locator(".review-audit")).toContainText("待核实");
});
