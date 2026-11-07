const task = await taskSpace("trace-official-website-20261107");
const page = task.page("p1");

await page.goto("http://127.0.0.1:4173/");
await page.waitForLoadState("networkidle");
await page.screenshot({
  path: "D:/MyFiles/项目/Trace/website/tools/round-01-desktop.png",
});

const layout = await page.evaluate(() => ({
  viewport: { width: innerWidth, height: innerHeight },
  document: {
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  },
  overflow: document.documentElement.scrollWidth > innerWidth,
  h1: document.querySelector("h1")?.textContent?.trim(),
  h1Box: (() => {
    const node = document.querySelector("h1");
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
  })(),
  sections: [...document.querySelectorAll("main > section")].map((section) => ({
    id: section.id,
    top: Math.round(section.getBoundingClientRect().top + scrollY),
    height: Math.round(section.getBoundingClientRect().height),
  })),
  images: [...document.images].map((image) => ({
    src: image.getAttribute("src"),
    width: image.naturalWidth,
    height: image.naturalHeight,
    complete: image.complete,
  })),
}));

console.log({ spaceId: task.spaceId, page: page.label });
console.log(JSON.stringify(layout, null, 2));
