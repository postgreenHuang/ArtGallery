import { chromium } from "@playwright/test";
import fs from "node:fs";
let browser;
for (let i = 0; i < 20; i++) {
  try {
    browser = await chromium.connectOverCDP("http://127.0.0.1:9226");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!browser) throw new Error("WebView2 debugging endpoint unavailable");
const context = browser.contexts()[0];
let page = context.pages()[0];
if (!page) page = await context.waitForEvent("page");
await page.setViewportSize({ width: 1440, height: 1120 });
try {
  await page.waitForSelector(".art-card", { timeout: 55000 });
} catch (error) {
  console.log("Native page state:", await page.locator("body").innerText());
  throw error;
}
await page.waitForFunction(
  () =>
    [...document.querySelectorAll(".art-card")].slice(0,3).every(card => {
      const image = card.querySelector('img');
      return image && image.complete && image.naturalWidth > 0;
    }),
  {},
  { timeout: 55000 },
);
console.log("Native gallery cards:", await page.locator(".art-card").count());
console.log(
  "Native cached image URL:",
  await page.locator(".art-card img").first().getAttribute("src"),
);
fs.mkdirSync("docs/images", { recursive: true });
await page.screenshot({ path: "docs/images/gallery-desktop.png" });
await browser.close();
