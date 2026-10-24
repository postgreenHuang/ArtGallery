import { chromium } from "@playwright/test";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1080 },
  deviceScaleFactor: 1,
});
page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
page.on("requestfailed", (r) =>
  console.log("REQUEST FAILED", r.url().slice(0, 120), r.failure()?.errorText),
);
await page.goto("http://127.0.0.1:1420");
await page.waitForTimeout(15000);
for (const card of await page.locator(".art-card").all()) {
  await card.scrollIntoViewIfNeeded();
  await card
    .locator("img")
    .evaluate((image) => image.decode())
    .catch(() => {});
}
await page.evaluate(() => window.scrollTo(0, 0));
console.log("Artwork count:", await page.locator(".art-card").count());
console.log(
  "Loaded images:",
  await page
    .locator(".art-card img")
    .evaluateAll(
      (imgs) => imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    ),
);
await page.screenshot({
  path: "test-results/gallery-live.png",
  fullPage: false,
});
await browser.close();
