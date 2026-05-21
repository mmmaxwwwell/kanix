import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: screenshot-belt.mjs <outDir> <url1> [url2 ...]");
  process.exit(1);
}
const outDir = targets.shift();
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
try {
  for (const url of targets) {
    const u = new URL(url);
    const width = Number(u.searchParams.get("w") || 1440);
    const height = Number(u.searchParams.get("h") || 900);
    u.searchParams.delete("w");
    u.searchParams.delete("h");
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    await page.goto(u.toString(), { waitUntil: "networkidle" });
    // Allow async layout (fonts/ResizeObserver) to settle a frame.
    await page.waitForTimeout(500);
    const panels = page.locator(".belt-layout-panel");
    const count = await panels.count();
    for (let i = 0; i < count; i++) {
      const panel = panels.nth(i);
      await panel.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      const box = await panel.boundingBox();
      if (!box) continue;
      // Pad a few px in case strokes spill slightly.
      const clip = {
        x: Math.max(0, box.x - 6),
        y: Math.max(0, box.y - 6),
        width: Math.min(width, box.width + 12),
        height: Math.min(height, box.height + 12),
      };
      const slug = u.pathname.replace(/\W+/g, "_").replace(/^_|_$/g, "");
      const file = `${outDir}/${slug}__w${width}__panel${i}.png`;
      mkdirSync(dirname(file), { recursive: true });
      await page.screenshot({ path: file, clip });
      console.log(file);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
