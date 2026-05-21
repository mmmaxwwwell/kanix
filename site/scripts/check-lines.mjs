// Analyze rendered belt-layout polylines for visual separation.
// For each panel/stage, parses polylines, splits them into segments,
// computes minimum distance between every pair of segments belonging
// to DIFFERENT lines, and flags pairs whose min distance is below a
// threshold (default 8px). Prints a structured report.

import { chromium } from "playwright";

const url = process.argv[2];
if (!url) { console.error("usage: check-lines.mjs <url> [width] [threshold]"); process.exit(1); }
const width = Number(process.argv[3] || 1440);
const threshold = Number(process.argv[4] || 8);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height: 900 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

function parsePoints(s) {
  return s.trim().split(/\s+/).map((p) => {
    const [x, y] = p.split(",").map(Number);
    return [x, y];
  });
}

// Squared distance from point P to segment AB.
function distPointSeg(p, a, b) {
  const ax = a[0], ay = a[1], bx = b[0], by = b[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ex = p[0] - ax, ey = p[1] - ay;
    return Math.sqrt(ex * ex + ey * ey);
  }
  let t = ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = p[0] - cx, ey = p[1] - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

// Min distance between two line segments AB and CD.
function segSegDist(a, b, c, d) {
  // 2D segments — if they intersect, distance is 0.
  if (segIntersect(a, b, c, d)) return 0;
  return Math.min(
    distPointSeg(a, c, d),
    distPointSeg(b, c, d),
    distPointSeg(c, a, b),
    distPointSeg(d, a, b),
  );
}

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function segIntersect(a, b, c, d) {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return false;
}

const panels = await page.$$(".belt-layout-panel");
for (let pi = 0; pi < panels.length; pi++) {
  const stages = await panels[pi].$$('[data-stage]');
  for (const stage of stages) {
    const key = await stage.getAttribute("data-stage");
    // Get each polyline + the bubble's side (from the matching bubble's data-bubble-side).
    const lineData = await stage.$$eval("svg[data-overlay] polyline", (polys) =>
      polys.map((p, i) => ({
        i,
        points: p.getAttribute("points") || "",
      }))
    );
    const bubbles = await stage.$$eval("[data-bubble-idx]", (els) =>
      els.map((e) => ({
        idx: e.getAttribute("data-bubble-idx"),
        side: e.getAttribute("data-bubble-side"),
      }))
    );
    // The polyline order matches DOM bubble order (one polyline per bubble).
    const lines = lineData.map((l, i) => ({
      i,
      idx: bubbles[i]?.idx,
      side: bubbles[i]?.side,
      pts: parsePoints(l.points),
    }));

    console.log(`\n=== panel ${pi} stage ${key} ===`);
    for (const ln of lines) {
      const segCount = Math.max(0, ln.pts.length - 1);
      console.log(`  line[${ln.i}] idx=${ln.idx} side=${ln.side} segs=${segCount}`);
    }

    // For each pair of same-side lines, compute min distance over all
    // segment pairs.
    const sameSide = {};
    for (const ln of lines) {
      sameSide[ln.side] = sameSide[ln.side] || [];
      sameSide[ln.side].push(ln);
    }
    for (const side of Object.keys(sameSide)) {
      const lns = sameSide[side];
      console.log(`\n  --- side=${side} (${lns.length} lines) ---`);
      let issues = 0;
      for (let i = 0; i < lns.length; i++) {
        for (let j = i + 1; j < lns.length; j++) {
          const A = lns[i], B = lns[j];
          // Skip the very first segment of each (the dot→radEnd) so we
          // don't flag two dots close to each other on the belt as a
          // "touching line" problem.
          let minD = Infinity, minLoc = null;
          for (let si = 1; si < A.pts.length - 1; si++) {
            for (let sj = 1; sj < B.pts.length - 1; sj++) {
              const a = A.pts[si], b = A.pts[si + 1];
              const c = B.pts[sj], d = B.pts[sj + 1];
              const ds = segSegDist(a, b, c, d);
              if (ds < minD) {
                minD = ds;
                minLoc = { aSeg: si, bSeg: sj, a, b, c, d };
              }
            }
          }
          const tag = minD < threshold ? "  ⚠ CLOSE" : "    ok";
          console.log(
            `  ${tag} line[${A.i}] (idx ${A.idx}) ↔ line[${B.i}] (idx ${B.idx}): minDist=${minD.toFixed(2)}px${minD < threshold ? `  segs ${minLoc.aSeg}↔${minLoc.bSeg}  A:${JSON.stringify(minLoc.a)}-${JSON.stringify(minLoc.b)}  B:${JSON.stringify(minLoc.c)}-${JSON.stringify(minLoc.d)}` : ""}`,
          );
          if (minD < threshold) issues++;
        }
      }
      console.log(`  issues on ${side}: ${issues}`);
    }
  }
}

await browser.close();
