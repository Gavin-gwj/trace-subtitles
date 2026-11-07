import { chromium } from "playwright";

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});

const errors = [];
const results = [];
const source =
  "C:/Users/LENOVO/.codex/visualizations/2026/11/07/01a1b3da-ed36-7581-a5a5-a9e46d5e29b0/output/imagegen/trace-style-01-cinema-trace.png";

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "laptop", width: 1280, height: 720 },
]) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push({ viewport: viewport.name, console: message.text() });
  });
  page.on("pageerror", (error) => errors.push({ viewport: viewport.name, page: error.message }));
  await page.addInitScript(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  });

  await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  await page.screenshot({
    path: `D:/MyFiles/项目/Trace/website/tools/${viewport.name}-cinema.png`,
  });

  const layout = await page.evaluate(() => {
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const overflow = [...document.querySelectorAll("body *")]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && style.position !== "fixed" && (rect.left < -1 || rect.right > innerWidth + 1);
      })
      .slice(0, 15)
      .map((node) => ({
        tag: node.tagName,
        className: typeof node.className === "string" ? node.className : "",
        left: Math.round(node.getBoundingClientRect().left),
        right: Math.round(node.getBoundingClientRect().right),
      }));
    return {
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      h1: box("h1"),
      footer: box(".hero-bottomline"),
      tray: box(".hero-product"),
      subtitle: box(".hero-subtitle-layer"),
      dictionary: box(".dictionary-popover"),
      largePanelVisible: !!document.querySelector(".caption-demo:not(.is-immersive)"),
      overflow,
    };
  });

  results.push({ name: viewport.name, layout });

  if (viewport.name === "desktop") {
    await page.getByRole("button", { name: "查看 stay 的释义" }).click();
    await page.getByRole("button", { name: "加入生词本" }).click();
    if (!(await page.getByRole("button", { name: "已在生词本" }).isVisible())) {
      errors.push({ interaction: "save from immersive dictionary failed" });
    }
    await page.getByRole("button", { name: "标记为「已经记住」" }).click();
    if (!(await page.getByRole("button", { name: "已记住" }).isVisible())) {
      errors.push({ interaction: "mark as known from immersive dictionary failed" });
    }
    await page.getByRole("button", { name: "切换下一句字幕" }).click();
    await page.locator("#features").scrollIntoViewIfNeeded();
    await page.locator("#wordbook").scrollIntoViewIfNeeded();
    await page.getByRole("tab", { name: "已记住" }).click();
    if ((await page.locator(".word-row").count()) !== 2) {
      errors.push({ interaction: "wordbook filter count is not 2" });
    }
    await page.getByRole("button", { name: "搜索生词" }).click();
    await page.locator(".word-search input").fill("persist");
    if ((await page.locator(".word-row").count()) !== 1) {
      errors.push({ interaction: "wordbook search result count is not 1" });
    }
    await page.locator("#faq").scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "能把数据同步到别的电脑吗？" }).click();
    if (!(await page.getByText("目前以本机保存为主").isVisible())) {
      errors.push({ interaction: "faq did not open" });
    }

    const navAfterScroll = await page.evaluate(() => {
      const header = document.querySelector(".site-header");
      const shell = document.querySelector(".nav-shell");
      if (!header || !shell) return null;
      const rect = shell.getBoundingClientRect();
      return {
        position: getComputedStyle(header).position,
        scrolled: header.classList.contains("is-scrolled"),
        top: Math.round(rect.top),
        height: Math.round(rect.height),
        visible: rect.bottom > 0 && rect.top < innerHeight,
      };
    });
    if (
      navAfterScroll?.position !== "fixed" ||
      !navAfterScroll?.scrolled ||
      !navAfterScroll?.visible
    ) {
      errors.push({ interaction: "floating navigation state failed", navAfterScroll });
    }
    await page.screenshot({
      path: "D:/MyFiles/项目/Trace/website/tools/scrolled-navigation.png",
    });

    await page.locator("#top").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const navAtTop = await page.evaluate(() => {
      const header = document.querySelector(".site-header");
      return header ? header.classList.contains("is-scrolled") : null;
    });
    if (navAtTop !== false) {
      errors.push({ interaction: "navigation did not return to transparent state", navAtTop });
    }
  }
  await page.close();
}

await browser.close();
console.log(JSON.stringify({ results, errors, source }, null, 2));
