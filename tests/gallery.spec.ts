import { test, expect } from "@playwright/test";
test("source extraction binds captions to their own images", async ({ page }) => {
  await page.goto("/");
  const blocks = await page.evaluate(async () => {
    const { extractPageBlocks } = await import("/src/services/pageEvidence.ts");
    return extractPageBlocks(`<main>
      <figure><img src="/one.jpg"><figcaption><h2>Quiet River</h2> Blue landscape by Ada in the museum collection.</figcaption></figure>
      <figure><img src="/two.jpg"><figcaption><h2>Red Portrait</h2> Portrait by Ben in the museum collection.</figcaption></figure>
    </main>`, "https://museum.example/collection");
  });
  expect(blocks).toHaveLength(2);
  expect(blocks[0]).toMatchObject({ title: "Quiet River", imageUrls: ["https://museum.example/one.jpg"] });
  expect(blocks[0].text).not.toContain("Red Portrait");
  expect(blocks[1].text).toContain("Portrait by Ben");
});
test.beforeEach(async ({ page }) => {
  await page.route("https://collectionapi.metmuseum.org/**", (route) => route.fulfill({ json: { total: 0, objectIDs: [] } }));
  await page.route("https://openaccess-api.clevelandart.org/**", (route) =>
    route.fulfill({ json: { info: { total: 0 }, data: [] } }),
  );
  await page.route("https://api.artic.edu/**", (route) =>
    route.fulfill({ json: { config: { iiif_url: "https://www.artic.edu/iiif/2" }, pagination: { total: 0 }, data: [] } }),
  );
});
const fixture = {
  pageid: 101,
  title: "File:Water lilies.jpg",
  index: 1,
  imageinfo: [
    {
      url: "https://upload.wikimedia.org/original.jpg",
      thumburl: "https://thumb.wikimedia.org/preview.jpg",
      width: 9000,
      height: 6000,
      mime: "image/jpeg",
      extmetadata: {
        ObjectName: { value: "Water lilies" },
        Artist: { value: "Claude Monet" },
        DateTimeOriginal: { value: "1916" },
        LicenseShortName: { value: "Public domain" },
      },
    },
  ],
};
test("fullscreen browses artworks from the same search result", async ({ page }) => {
  const second = {
    ...fixture,
    pageid: 102,
    title: "File:Impression, Sunrise.jpg",
    index: 2,
    imageinfo: [{
      ...fixture.imageinfo[0],
      url: "https://upload.wikimedia.org/sunrise.jpg",
      thumburl: "https://thumb.wikimedia.org/sunrise.jpg",
      extmetadata: {
        ...fixture.imageinfo[0].extmetadata,
        ObjectName: { value: "Impression, Sunrise" },
      },
    }],
  };
  await page.route("https://commons.wikimedia.org/w/api.php?**", (route) =>
    route.fulfill({ json: { query: { pages: [fixture, second] } } }),
  );
  await page.route("https://thumb.wikimedia.org/**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: /开启一场艺术对话/ }).click();
  await page.getByRole("textbox", { name: "向策展人描述想看的画作" }).fill("莫奈");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "欣赏 Impression, Sunrise" })).toBeVisible();
  await page.getByRole("button", { name: "欣赏 Water lilies" }).click();
  await expect(page.getByRole("dialog", { name: "全屏欣赏 Water lilies" })).toBeVisible();
  await expect(page.locator(".viewer-position")).toHaveText("1 / 2");
  await expect(page.getByRole("button", { name: "上一张" })).toBeDisabled();
  await page.getByRole("button", { name: "下一张" }).click();
  await expect(page.getByRole("dialog", { name: "全屏欣赏 Impression, Sunrise" })).toBeVisible();
  await expect(page.locator(".viewer-position")).toHaveText("2 / 2");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("dialog", { name: "全屏欣赏 Water lilies" })).toBeVisible();
  await page.getByRole("button", { name: "退出全屏" }).click();
  await page.getByRole("button", { name: /最近看过/ }).click();
  await expect(page.locator(".gallery-grid .art-card")).toHaveCount(2);
  await expect(page.locator(".gallery-grid .art-card").first()).toContainText("Water lilies");
  await page.reload();
  await page.getByRole("button", { name: /最近看过/ }).click();
  await expect(page.locator(".gallery-grid .art-card")).toHaveCount(2);
});
test("discovery refresh changes topics and similar opens a seeded inspiration chat", async ({
  page,
}) => {
  const topicIds = new Map<string, number>();
  await page.route("https://commons.wikimedia.org/w/api.php?**", (route) => {
    const query =
      new URL(route.request().url()).searchParams.get("gsrsearch") || "";
    const topic = query.split(' "Google Art Project"')[0].replace(/ filetype:bitmap$/, "");
    if (!topicIds.has(topic)) topicIds.set(topic, topicIds.size + 1);
    const id = topicIds.get(topic)!;
    const name = `Artist ${id}`;
    return route.fulfill({
      json: {
        query: {
          pages: [
            {
              ...fixture,
              pageid: id,
              title: `File:${name}.jpg`,
              imageinfo: [
                {
                  ...fixture.imageinfo[0],
                  url: `https://upload.wikimedia.org/${id}.jpg`,
                  thumburl: `https://thumb.wikimedia.org/${id}.jpg`,
                  extmetadata: {
                    ...fixture.imageinfo[0].extmetadata,
                    ObjectName: { value: `${name} painting` },
                    Artist: { value: name },
                  },
                },
              ],
            },
          ],
        },
      },
    });
  });
  await page.route("https://thumb.wikimedia.org/**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  await page.goto("/");
  await expect(page.locator(".collection-section .art-card")).toHaveCount(5);
  const first = await page
    .locator(".collection-section .art-caption p")
    .allTextContents();
  expect(new Set(first).size).toBe(5);
  await page.getByRole("button", { name: "换一组画作" }).click();
  await expect
    .poll(async () =>
      page.locator(".collection-section .art-caption p").allTextContents(),
    )
    .not.toEqual(first);
  const second = await page
    .locator(".collection-section .art-caption p")
    .allTextContents();
  expect(second.every((artist) => !first.includes(artist))).toBe(true);
  await page.getByRole("button", { name: "查看相似" }).first().click();
  await expect(
    page.getByText("为参照，比较艺术风格", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("请在偏好中开启 AI", { exact: false }),
  ).toBeVisible();
});
test("original download rate limit explains retry while thumbnails stay visible", async ({
  page,
}) => {
  let allowOriginal = false;
  await page.route("https://commons.wikimedia.org/w/api.php?**", (route) =>
    route.fulfill({ json: { query: { pages: [fixture] } } }),
  );
  await page.route("https://thumb.wikimedia.org/**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  await page.route("https://upload.wikimedia.org/**", (route) =>
    route.fulfill(allowOriginal ? {
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
    } : { status: 429, body: "Too many requests" }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Water lilies" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "加入画架", exact: true }).click();
  await expect(
    page.getByText("Wikimedia 暂时限制下载（HTTP 429）", { exact: false }),
  ).toBeVisible();
  await expect(
    page.locator(".collection-section .art-image img"),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /我的画架/ }).click();
  await expect(page.getByRole("heading", { name: "Water lilies" })).toBeVisible();
  await expect(page.getByText("原图待下载 · 点击书签重试")).toBeVisible();
  allowOriginal = true;
  await page.getByRole("button", { name: "重试下载原图" }).click();
  await expect(page.getByRole("button", { name: "已在画架 · 原图" })).toBeVisible();
});
test("Wikimedia 429 still searches both museums and saves a museum painting", async ({ page }) => {
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  await page.route("https://commons.wikimedia.org/**", (route) => route.fulfill({ status: 429, body: "limited" }));
  await page.route("https://openaccess-api.clevelandart.org/**", (route) => route.fulfill({ json: {
    info: { total: 1 }, data: [{
      id: 101, title: "Water lilies - Cleveland", creators: [{ role: "artist", description: "Claude Monet" }],
      share_license_status: "CC0", creation_date: "1916", type: "Painting", accession_number: "101",
      images: {
        web: { url: "https://openaccess-cdn.clevelandart.org/101/101_web.jpg", width: 900, height: 600 },
        print: { url: "https://openaccess-cdn.clevelandart.org/101/101_print.jpg", width: 3400, height: 2200 },
      },
    }],
  } }));
  await page.route("https://api.artic.edu/**", (route) => route.fulfill({ json: {
    config: { iiif_url: "https://www.artic.edu/iiif/2" }, pagination: { total: 1 },
    data: [{ id: 101, title: "Water lilies - Chicago", artist_display: "Claude Monet", is_public_domain: true, image_id: "2d484387-2509-5e8e-2c43-22f9981972eb" }],
  } }));
  await page.route("https://openaccess-cdn.clevelandart.org/**", (route) => route.fulfill({ contentType: "image/png", body: pixel }));
  await page.route("https://www.artic.edu/iiif/**", (route) => route.fulfill({ contentType: "image/png", body: pixel }));
  await page.goto("/");
  await expect(page.locator(".collection-section").getByRole("heading", { name: "Water lilies - Cleveland" })).toBeVisible();
  await page.getByRole("button", { name: /开启一场艺术对话/ }).click();
  await page.getByRole("textbox", { name: "向策展人描述想看的画作" }).fill("莫奈");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const cmaCard = page.locator(".gallery-grid .art-card").filter({ hasText: "Water lilies - Cleveland" });
  await expect(cmaCard).toBeVisible();
  await expect(page.getByRole("heading", { name: "Water lilies - Chicago" })).toBeVisible();
  await cmaCard.getByRole("button", { name: "加入画架" }).click();
  await expect(cmaCard.getByRole("button", { name: "已在画架 · 馆方高清 JPEG" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /我的画架/ }).click();
  await expect(page.getByRole("heading", { name: "Water lilies - Cleveland" })).toBeVisible();
});
test("Chicago cards recover from a failed thumbnail and can be retried", async ({ page }) => {
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  let online = false;
  const iiifCalls: string[] = [];
  await page.route("https://commons.wikimedia.org/**", (route) => route.fulfill({ status: 429, body: "limited" }));
  await page.route("https://api.artic.edu/**", (route) => route.fulfill({ json: {
    config: { iiif_url: "https://www.artic.edu/iiif/2" }, pagination: { total: 3 },
    data: [
      { id: 101, title: "Chicago fallback", artist_display: "Artist", is_public_domain: true, image_id: "2d484387-2509-5e8e-2c43-22f9981972eb" },
      { id: 102, title: "Chicago retry", artist_display: "Artist", is_public_domain: true, image_id: "3d484387-2509-5e8e-2c43-22f9981972eb" },
      { id: 103, title: "Chicago viewer", artist_display: "Artist", is_public_domain: true, image_id: "4d484387-2509-5e8e-2c43-22f9981972eb" },
    ],
  } }));
  await page.route("https://www.artic.edu/iiif/**", (route) => {
    const url = route.request().url();
    iiifCalls.push(url);
    if (url.includes("/2d484387-") && url.includes("/843,"))
      return route.fulfill({ contentType: "image/png", body: pixel });
    if ((url.includes("/3d484387-") || url.includes("/4d484387-")) && online)
      return route.fulfill({ contentType: "image/png", body: pixel });
    return route.fulfill({ status: 429, body: "limited" });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /开启一场艺术对话/ }).click();
  await page.getByRole("textbox", { name: "向策展人描述想看的画作" }).fill("Chicago");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const fallback = page.locator(".gallery-grid .art-card").filter({ hasText: "Chicago fallback" });
  const retry = page.locator(".gallery-grid .art-card").filter({ hasText: "Chicago retry" });
  const viewerCard = page.locator(".gallery-grid .art-card").filter({ hasText: "Chicago viewer" });
  await fallback.scrollIntoViewIfNeeded();
  try { await expect(fallback.locator("img")).toHaveJSProperty("naturalWidth", 1); }
  catch (error) { throw new Error(`${String(error)}\nIIIF calls: ${iiifCalls.join(" | ")}`); }
  await expect(fallback.getByText("图片暂不可用")).toHaveCount(0);
  await expect(retry.getByRole("button", { name: "重试缩略图" })).toBeVisible();
  await expect(viewerCard.getByRole("button", { name: "重试缩略图" })).toBeVisible();
  online = true;
  await retry.getByRole("button", { name: "重试缩略图" }).click();
  await expect(retry.locator("img")).toHaveJSProperty("naturalWidth", 1);
  await expect(retry.getByText("图片暂不可用")).toHaveCount(0);
  await viewerCard.getByRole("button", { name: "欣赏 Chicago viewer" }).click();
  await expect(page.getByRole("dialog", { name: "全屏欣赏 Chicago viewer" })).toBeVisible();
  await page.getByRole("button", { name: "退出全屏" }).click();
  await expect(viewerCard.locator("img")).toHaveJSProperty("naturalWidth", 1);
  await expect(viewerCard.getByRole("button", { name: "重试缩略图" })).toHaveCount(0);
});
test("discovery paginates and remembers shown recommendations across refreshes", async ({ page }) => {
  const seen = new Set<string>();
  const offsets: number[] = [];
  const artistIds = new Map<string, number>();
  await page.route("https://commons.wikimedia.org/w/api.php?**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const name = (params.get("gsrsearch") || "Claude Monet").split(' "Google Art Project"')[0].replace(/ filetype:bitmap$/, "");
    const offset = Number(params.get("gsroffset") || 0);
    if (!artistIds.has(name)) artistIds.set(name, artistIds.size + 1);
    offsets.push(offset);
    return route.fulfill({ json: {
      query: { pages: [{
        ...fixture,
        pageid: artistIds.get(name)! * 10000 + offset,
        title: `File:${name} ${offset}.jpg`,
        imageinfo: [{ ...fixture.imageinfo[0], extmetadata: {
          ...fixture.imageinfo[0].extmetadata,
          ObjectName: { value: `${name} ${offset}` },
          Artist: { value: name },
        } }],
      }] },
      continue: { gsroffset: offset + 12 },
    } });
  });
  await page.goto("/");
  for (let turn = 0; turn < 8; turn++) {
    await expect(page.locator(".collection-section .art-card")).toHaveCount(5);
    const titles = await page.locator(".collection-section .art-caption h3").allTextContents();
    for (const title of titles) {
      expect(seen.has(title)).toBe(false);
      seen.add(title);
    }
    if (turn < 7) {
      if (turn === 3) await page.reload();
      else await page.getByRole("button", { name: "换一组画作" }).click();
      await expect(page.getByRole("button", { name: "换一组画作" })).toBeEnabled();
    }
  }
  expect(offsets.some((offset) => offset > 0)).toBe(true);
});
test("fullscreen collection survives a rate limit and retries without leaving the viewer", async ({ page }) => {
  let allowOriginal = false;
  let originalRequests = 0;
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  await page.route("https://commons.wikimedia.org/w/api.php?**", (route) =>
    route.fulfill({ json: { query: { pages: [fixture] } } }),
  );
  await page.route("https://thumb.wikimedia.org/**", (route) =>
    route.fulfill({ contentType: "image/png", body: pixel }),
  );
  await page.route("https://upload.wikimedia.org/**", (route) => {
    originalRequests++;
    return route.fulfill(allowOriginal
      ? { contentType: "image/png", body: pixel }
      : { status: 429, body: "Too many requests" });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "欣赏 Water lilies" }).click();
  const viewer = page.getByRole("dialog", { name: "全屏欣赏 Water lilies" });
  await viewer.getByRole("button", { name: "加入画架" }).click();
  await expect(viewer.getByRole("button", { name: "重试下载原图" })).toBeVisible();
  await expect(page.getByText("Wikimedia 暂时限制下载（HTTP 429）", { exact: false })).toBeVisible();
  allowOriginal = true;
  await viewer.getByRole("button", { name: "重试下载原图" }).click();
  await expect(viewer.getByRole("button", { name: "已在画架 · 原图" })).toBeVisible();
  await viewer.getByRole("button", { name: "退出全屏" }).click();
  await page.getByRole("button", { name: /我的画架/ }).click();
  const beforeOpen = originalRequests;
  await page.getByRole("button", { name: "欣赏 Water lilies" }).click();
  await expect(page.locator(".viewer-resolution")).toContainText("已显示原图");
  expect(originalRequests).toBe(beforeOpen);
});
test("clear light and warm paper themes save and render distinct palettes", async ({ page }) => {
  await page.route("https://commons.wikimedia.org/w/api.php?**", (route) =>
    route.fulfill({ json: { query: { pages: [fixture] } } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: /偏好与资料库/ }).click();
  await page.getByLabel("界面主题").selectOption("contrast");
  await page.getByRole("button", { name: "保存偏好" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "contrast");
  await expect(page.locator(".sidebar")).toHaveCSS("background-color", "rgb(234, 241, 233)");
  const contrast = await page.locator(".sidebar-intro").evaluate((node) => {
    const channels = (color: string) => (color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const luminance = (color: string) =>
      channels(color).map((value) => {
        const component = value / 255;
        return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const text = luminance(getComputedStyle(node).color);
    const background = luminance(getComputedStyle(node.closest(".sidebar")!).backgroundColor);
    return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(7);
  await page.screenshot({ path: "test-results/clear-light-theme.png", fullPage: true });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "contrast");
  await page.getByRole("button", { name: /偏好与资料库/ }).click();
  await page.getByLabel("界面主题").selectOption("warm");
  await page.getByRole("button", { name: "保存偏好" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "warm");
  await expect(page.locator(".sidebar")).toHaveCSS("background-color", "rgb(236, 223, 202)");
  await page.screenshot({ path: "test-results/warm-paper-theme.png", fullPage: true });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "warm");
});
test("search, thumbnail-first, collect, reload offline, history and settings", async ({
  page,
}) => {
  const requests: string[] = [];
  const originals: string[] = [];
  await page.route("https://commons.wikimedia.org/w/api.php?**", (route) => {
    requests.push(route.request().url());
    return route.fulfill({ json: { query: { pages: [fixture] } } });
  });
  await page.route("https://thumb.wikimedia.org/**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  await page.route("https://upload.wikimedia.org/**", (route) => {
    originals.push(route.request().url());
    return route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Water lilies", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "加入画架", exact: true }).click();
  await expect(page.getByText("已收入画架 · 原图已保存在本地")).toBeVisible();
  expect(originals).toContain("https://upload.wikimedia.org/original.jpg");
  await page.getByRole("button", { name: /我的画架/ }).click();
  await expect(
    page.getByRole("heading", { name: "Water lilies", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /我的画架/ }).click();
  await expect(page.locator(".art-image img")).toHaveAttribute("src", /^blob:/);
  await page.getByRole("button", { name: /开启一场艺术对话/ }).click();
  await page
    .getByRole("textbox", { name: "向策展人描述想看的画作" })
    .fill("莫奈的睡莲");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("Claude Monet water lilies", { exact: false }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Water lilies", exact: true }),
  ).toBeVisible();
  expect(requests.every((url) => url.includes("iiurlwidth=640"))).toBe(true);
  await page
    .getByRole("button", { name: "欣赏 Water lilies" })
    .click({ button: "right" });
  await expect(
    page.getByRole("button", { name: "加载高清 · 2400px" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "加载高清 · 2400px" }).click();
  await expect(
    page.getByText("本地原图 · 9000 × 6000 px", { exact: false }),
  ).toBeVisible();
  expect(requests.some((url) => url.includes("iiurlwidth=2400"))).toBe(true);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "欣赏 Water lilies" }).click();
  await expect(
    page.getByRole("dialog", { name: "全屏欣赏 Water lilies" }),
  ).toBeVisible();
  await expect(page.locator(".viewer-resolution")).toContainText(
    "已显示原图 · 1 × 1px",
  );
  await page.getByRole("button", { name: "以 1:1 原始像素显示" }).click();
  await expect(page.locator(".viewer-pixel-scale")).toHaveText("当前图像 100%");
  await page.getByRole("button", { name: "重置视图" }).click();
  await page.setViewportSize({ width: 1914, height: 1080 });
  expect(
    await page.locator(".fullscreen-viewer").evaluate((el) => ({
      right: Math.round(el.getBoundingClientRect().right),
      viewport: window.innerWidth,
      parent: el.parentElement?.tagName,
      overflow: document.documentElement.style.overflow,
    })),
  ).toEqual({
    right: 1914,
    viewport: 1914,
    parent: "BODY",
    overflow: "hidden",
  });
  const canvas = await page.locator(".viewer-canvas").boundingBox();
  expect(canvas).not.toBeNull();
  const centerX = canvas!.x + canvas!.width / 2;
  const centerY = canvas!.y + canvas!.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 80, centerY + 40, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".viewer-render-canvas")).toHaveAttribute(
    "data-pan-x",
    "80",
  );
  await expect(page.locator(".viewer-render-canvas")).toHaveAttribute(
    "data-pan-y",
    "40",
  );
  await page.locator(".viewer-canvas").dispatchEvent("wheel", {
    deltaY: -240,
    clientX: 700,
    clientY: 450,
  });
  await expect(page.locator(".viewer-scale")).not.toHaveText("100%");
  await page.getByRole("button", { name: "退出全屏" }).click();
  await page
    .getByRole("button", { name: "欣赏 Water lilies" })
    .click({ button: "right" });
  await page.getByRole("button", { name: "查看作品" }).click();
  await page.getByRole("button", { name: "全屏欣赏 Water lilies" }).click();
  await expect(
    page.getByRole("dialog", { name: "全屏欣赏 Water lilies" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "退出全屏" }).click();
  await expect(page.getByRole("dialog", { name: "作品详情" })).toBeVisible();
  await page.getByRole("button", { name: "关闭作品详情" }).click();
  await page
    .getByRole("button", { name: "欣赏 Water lilies" })
    .click({ button: "right" });
  await page.getByRole("button", { name: "展开讲解对话" }).click();
  await expect(
    page.getByRole("heading", { name: "《Water lilies》的讲解" }),
  ).toBeVisible();
  await expect(page.getByText("时代背景：馆藏标注创作于 1916", { exact: false })).toBeVisible();
  await expect(page.getByText("作者：馆藏署名为 Claude Monet", { exact: false })).toBeVisible();
  await expect(page.getByText("技法与风格流派：现有馆藏资料不足", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "打开 Water lilies 的图片浮窗" }).click();
  const floating = page.getByRole("dialog", { name: "作品浮窗 Water lilies" });
  await expect(floating).toBeVisible();
  await expect(floating.locator("img")).toHaveJSProperty("naturalWidth", 1);
  await expect(page.getByText("时代背景：馆藏标注创作于 1916", { exact: false })).toBeVisible();
  await page.screenshot({ path: "test-results/floating-artwork.png" });
  const handle = floating.getByLabel("拖动图片浮窗");
  const before = await floating.boundingBox();
  const grip = await handle.boundingBox();
  if (!before || !grip) throw new Error("图片浮窗未渲染");
  await page.mouse.move(grip.x + 30, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x - 110, grip.y + grip.height / 2 + 80, { steps: 6 });
  await page.mouse.up();
  const after = await floating.boundingBox();
  expect(after!.x).toBeLessThan(before.x - 80);
  expect(after!.y).toBeGreaterThan(before.y + 50);
  await floating.getByRole("button", { name: "关闭图片浮窗" }).click();
  await page.getByRole("button", { name: /偏好与资料库/ }).click();
  await page.getByLabel("作品讲解文字大小").selectOption("20");
  await page.getByRole("button", { name: "保存偏好" }).click();
  await expect(page.locator(".message.assistant .message-text").first()).toHaveCSS("font-size", "20px");
  await page
    .getByRole("textbox", { name: "向策展人描述想看的画作" })
    .fill("画面用了什么技法？");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("请先在偏好中开启 AI 并配置模型", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: /往日对话/ }).click();
  await page.getByRole("tab", { name: /作品讲解/ }).click();
  await expect(page.locator(".history-list")).toContainText(
    "《Water lilies》的讲解",
  );
  await page.reload();
  await page.getByRole("button", { name: /往日对话/ }).click();
  await page.getByRole("tab", { name: /作品讲解/ }).click();
  await page.locator(".history-list article > button:first-child").click();
  await expect(page.locator(".message.assistant .message-text").first()).toHaveCSS("font-size", "20px");
  await expect(
    page.getByText("画面用了什么技法？", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /往日对话/ }).click();
  await page.getByRole("tab", { name: /灵感寻画/ }).click();
  await expect(page.locator(".history-list")).toContainText("莫奈的睡莲");
  await page.getByRole("button", { name: /偏好与资料库/ }).click();
  await page.getByRole("button", { name: "资料库与同步" }).click();
  await expect(page.getByText("一个文件夹，带走你的美术馆。")).toBeVisible();
  await page.getByRole("button", { name: "清理临时图片" }).click();
  await expect(page.getByRole("status")).toContainText("画架图片已保留");
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.getByRole("button", { name: /我的画架/ }).click();
  await expect(page.locator(".art-image img")).toHaveAttribute("src", /^blob:/);
  await page.screenshot({ path: "test-results/history.png", fullPage: true });
});
test("network failure remains actionable", async ({ page }) => {
  await page.route("https://commons.wikimedia.org/**", (r) =>
    r.fulfill({ status: 503 }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "重新连接馆藏" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /开启一场艺术对话/ }).click();
  await page
    .getByRole("textbox", { name: "向策展人描述想看的画作" })
    .fill("Monet");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新尝试" })).toBeVisible();
});
test("similar-style request does not fall back to the named artist in direct mode", async ({
  page,
}) => {
  const queries: string[] = [];
  await page.route("https://commons.wikimedia.org/w/api.php?**", (route) => {
    queries.push(route.request().url());
    return route.fulfill({ json: { query: { pages: [] } } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /开启一场艺术对话/ }).click();
  await page
    .getByRole("textbox", { name: "向策展人描述想看的画作" })
    .fill("有没有类似希施金风格的作家推荐");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("直接检索无法判断风格关联", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "开启 AI 风格推荐" }),
  ).toBeVisible();
  expect(queries.every((url) => !url.includes("Shishkin"))).toBe(true);
});
test("fullscreen loads selectable sizes only on demand and dark theme persists", async ({
  page,
}) => {
  const originals: string[] = [];
  const api: string[] = [];
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  await page.route("https://commons.wikimedia.org/w/api.php?**", (route) => {
    api.push(route.request().url());
    const edge = new URL(route.request().url()).searchParams.get("iiurlwidth");
    const page = structuredClone(fixture);
    if (edge === "1280" || edge === "2400")
      page.imageinfo[0].thumburl = `https://thumb.wikimedia.org/${edge}.svg`;
    return route.fulfill({ json: { query: { pages: [page] } } });
  });
  await page.route("https://thumb.wikimedia.org/**", (route) => {
    const edge = route
      .request()
      .url()
      .match(/\/(1280|2400)\.svg/)?.[1];
    return edge
      ? route.fulfill({
          contentType: "image/svg+xml",
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="${edge}" height="900"><rect width="100%" height="100%" fill="steelblue"/></svg>`,
        })
      : route.fulfill({ contentType: "image/png", body: pixel });
  });
  await page.route("https://upload.wikimedia.org/**", async (route) => {
    originals.push(route.request().url());
    await new Promise((resolve) => setTimeout(resolve, 350));
    return route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect width="1600" height="1200" fill="steelblue"/></svg>',
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "欣赏 Water lilies" }).click();
  await expect(
    page.getByRole("dialog", { name: "全屏欣赏 Water lilies" }),
  ).toBeVisible();
  await expect(page.locator(".viewer-resolution")).toContainText(
    "已显示缩略图",
  );
  expect(originals).toHaveLength(0);
  await page
    .getByRole("combobox", { name: "选择画作分辨率" })
    .selectOption("medium");
  await expect(page.locator(".viewer-resolution")).toContainText(
    "已显示标准图",
  );
  expect(api.some((url) => url.includes("iiurlwidth=1280"))).toBe(true);
  await page
    .getByRole("combobox", { name: "选择画作分辨率" })
    .selectOption("preview");
  await expect(page.locator(".viewer-resolution")).toContainText(
    "已显示缩略图",
  );
  await page
    .getByRole("combobox", { name: "选择画作分辨率" })
    .selectOption("hd");
  await expect(page.locator(".viewer-resolution")).toContainText(
    "已显示高清图",
  );
  expect(api.some((url) => url.includes("iiurlwidth=2400"))).toBe(true);
  await page
    .getByRole("combobox", { name: "选择画作分辨率" })
    .selectOption("original");
  await expect(page.locator(".viewer-download-status")).toContainText(
    "正在连接",
  );
  await expect(page.locator(".viewer-resolution")).toContainText(
    "已显示原图 · 1600 × 1200px",
  );
  await page.getByRole("button", { name: "以 1:1 原始像素显示" }).click();
  await expect(page.locator(".viewer-pixel-scale")).toHaveText("当前图像 100%");
  await expect(page.locator(".viewer-scale")).not.toHaveText("适屏 ×100%");
  expect(
    await page.locator(".viewer-source-image").evaluate((img) => ({
      natural: (img as HTMLImageElement).naturalWidth,
      layout: (img as HTMLImageElement).clientWidth,
    })),
  ).toEqual({ natural: 1600, layout: 0 });
  await expect
    .poll(() =>
      page.locator(".viewer-render-canvas").evaluate((node) => {
        const canvas = node as HTMLCanvasElement;
        const context = canvas.getContext("2d")!;
        return Array.from(
          context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data,
        ).slice(0, 3);
      }),
    )
    .toEqual([70, 130, 180]);
  await expect(page.locator(".viewer-canvas img")).toHaveAttribute(
    "src",
    /^blob:/,
  );
  expect(originals).toContain("https://upload.wikimedia.org/original.jpg");
  await page
    .getByRole("combobox", { name: "选择画作分辨率" })
    .selectOption("medium");
  await expect(page.locator(".viewer-resolution")).toContainText(
    "已显示标准图",
  );
  const mediumQueries = api.filter((url) =>
    url.includes("iiurlwidth=1280"),
  ).length;
  await page.getByRole("button", { name: "退出全屏" }).click();
  await page.getByRole("button", { name: "欣赏 Water lilies" }).click();
  await expect(page.locator(".viewer-resolution")).toContainText(
    "已显示原图 · 1600 × 1200px",
  );
  await page
    .getByRole("combobox", { name: "选择画作分辨率" })
    .selectOption("medium");
  await expect(page.locator(".viewer-resolution")).toContainText(
    "已显示标准图",
  );
  expect(api.filter((url) => url.includes("iiurlwidth=1280"))).toHaveLength(
    mediumQueries,
  );
  await page.getByRole("button", { name: "退出全屏" }).click();
  await page.getByRole("button", { name: /偏好与资料库/ }).click();
  await page.getByLabel("界面主题").selectOption("dark");
  await page.getByRole("button", { name: "保存偏好" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".sidebar")).toHaveCSS(
    "background-color",
    "rgb(34, 43, 37)",
  );
  await expect(page.locator(".prompt-card").first()).toHaveCSS(
    "background-color",
    "rgb(44, 55, 47)",
  );
  await page.screenshot({
    path: "test-results/dark-theme.png",
    fullPage: true,
  });
});
