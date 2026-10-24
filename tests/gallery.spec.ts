import { test, expect } from "@playwright/test";
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
test("discovery refresh rotates artists and similar opens a seeded inspiration chat", async ({
  page,
}) => {
  const names = [
    "Claude Monet",
    "Paul Cezanne",
    "Berthe Morisot",
    "Sandro Botticelli",
    "Albrecht Durer",
    "Leonardo da Vinci",
    "Rembrandt",
    "Johannes Vermeer",
    "Diego Velazquez",
    "Francisco Goya",
    "Canaletto",
    "Katsushika Hokusai",
    "Wassily Kandinsky",
    "Gustav Klimt",
    "Edvard Munch",
  ];
  await page.route("https://commons.wikimedia.org/w/api.php?**", (route) => {
    const query =
      new URL(route.request().url()).searchParams.get("gsrsearch") || "";
    const name = names.find((item) => query.startsWith(item)) || "Claude Monet";
    const id = names.indexOf(name) + 1;
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
    route.fulfill({ status: 429, body: "Too many requests" }),
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
    "已显示缩略图 · 1 × 1px",
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
