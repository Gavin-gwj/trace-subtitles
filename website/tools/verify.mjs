import { chromium } from "playwright";
import path from "node:path";

const root = "D:/MyFiles/项目/Trace/website";
const source = "C:/Users/LENOVO/.codex/visualizations/2026/11/07/01a1b3da-ed36-7581-a5a5-a9e46d5e29b0/output/imagegen/trace-style-01-cinema-trace.png";
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});

const results = [];
const errors = [];

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "laptop", width: 1280, height: 720 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
]) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push({ viewport: viewport.name, console: message.text() });
  });
  page.on("pageerror", (error) => errors.push({ viewport: viewport.name, page: error.message }));

  await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1400);
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    document.querySelector("img[src*='study-room']")?.setAttribute("loading", "eager");
    await Promise.all(
      [...document.images].map((image) =>
        image.complete ? Promise.resolve() : new Promise((resolve) => image.addEventListener("load", resolve, { once: true })),
      ),
    );
  });
  await page.screenshot({
    path: path.join(root, "tools", `trace-${viewport.name}.png`),
    fullPage: false,
  });

  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(800);

  const state = await page.evaluate(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return {
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        left: Math.round(box.left),
        right: Math.round(box.right),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    };
    const overflowing = [...document.querySelectorAll("body *")]
      .filter((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && (box.right > innerWidth + 2 || box.left < -2);
      })
      .slice(0, 16)
      .map((node) => ({
        tag: node.tagName,
        className: typeof node.className === "string" ? node.className : "",
        left: Math.round(node.getBoundingClientRect().left),
        right: Math.round(node.getBoundingClientRect().right),
      }));

    return {
      viewport: { width: innerWidth, height: innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      h1: document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim(),
      h1Box: rect("h1"),
      heroBox: rect(".hero"),
      productBox: rect(".hero-product"),
      bottomlineBox: rect(".hero-bottomline"),
      navBox: rect(".nav-shell"),
      overflowNodes: overflowing,
      images: [...document.images].map((image) => ({
        src: image.getAttribute("src"),
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        complete: image.complete,
      })),
      sections: [...document.querySelectorAll("main > section")].map((section) => ({
        id: section.id,
        height: Math.round(section.getBoundingClientRect().height),
      })),
    };
  });

  if (viewport.name === "desktop") {
    await page.screenshot({ path: path.join(root, "tools", "trace-desktop-full.png"), fullPage: true });
    await page.getByRole("button", { name: "查看 stay 的释义" }).click();
    await page.locator(".save-word").click();
    if (!(await page.locator(".save-word").innerText()).includes("已在生词本")) {
      errors.push({ viewport: "desktop", interaction: "save-word did not update" });
    }
    await page.locator("#wordbook").scrollIntoViewIfNeeded();
    await page.getByRole("tab", { name: "已记住" }).click();
    const filtered = await page.locator(".word-row").count();
    if (filtered !== 2) errors.push({ viewport: "desktop", interaction: `wordbook filter returned ${filtered}, expected 2` });
    await page.getByRole("button", { name: "收起答案，进入复习" }).click();
    if ((await page.locator(".glossary-sample").getAttribute("class")) !== "glossary-sample is-masked") {
      errors.push({ viewport: "desktop", interaction: "review toggle did not mask" });
    }
    await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "切换下一句字幕" }).click();
  }

  if (viewport.name === "mobile") {
    const mobileHeroState = await page.evaluate(() => {
      const box = (selector) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom) } : null;
      };
      return {
        h1: box("h1"),
        product: box(".hero-product"),
        caption: box(".caption-demo"),
        popover: box(".dictionary-popover"),
        hero: box(".hero"),
      };
    });
    results.push({ name: "mobile-before-menu", mobileHeroState });
    await page.getByRole("button", { name: "打开菜单" }).click();
    if (!(await page.locator(".mobile-nav").isVisible())) {
      errors.push({ viewport: "mobile", interaction: "mobile menu did not open" });
    }
    await page.getByRole("link", { name: "安装", exact: true }).click();
    await page.waitForTimeout(350);
  }

  results.push({ name: viewport.name, ...state });
  await page.close();
}

await browser.close();
console.log(JSON.stringify({ results, errors }, null, 2));
