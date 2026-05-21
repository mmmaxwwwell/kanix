import { chromium } from "playwright";

const url = process.argv[2];
if (!url) { console.error("usage: dump-lines.mjs <url>"); process.exit(1); }
const width = Number(process.argv[3] || 1440);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height: 900 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

const panels = await page.$$(".belt-layout-panel");
for (let pi = 0; pi < panels.length; pi++) {
  const stages = await panels[pi].$$('[data-stage]');
  for (const stage of stages) {
    const key = await stage.getAttribute("data-stage");
    const lines = await stage.$$eval("svg[data-overlay] polyline", (polys) =>
      polys.map((p) => p.getAttribute("points") || "")
    );
    // Match each line to its bubble idx via the bubble in order — simpler: just dump them.
    const bubbles = await stage.$$eval("[data-bubble-idx]", (els) =>
      els.map((e) => ({
        idx: e.getAttribute("data-bubble-idx"),
        side: e.getAttribute("data-bubble-side"),
      }))
    );
    console.log(`# panel ${pi} stage ${key}`);
    console.log("# bubbles:", JSON.stringify(bubbles));
    for (let i = 0; i < lines.length; i++) {
      console.log(`line[${i}]: ${lines[i]}`);
    }
    const dbg = await page.evaluate(() => window.__beltDebug);
    console.log("# debug:", JSON.stringify(dbg, null, 2));
  }
}
await browser.close();
