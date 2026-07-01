import { withPage } from "./channels/browser.js";
import { createLogger } from "./log.js";

const log = createLogger("budget-chart");

// ===========================================================================
// Render the month's budget burn as a day-by-day line: cumulative spend as a %
// of income, against the spend-cap line (100% - savings rate). Pure SVG (no
// external fonts/images) so it screenshots cleanly and is unit-testable; the PNG
// step uses the local browser (best-effort, like the other browser helpers).
// ===========================================================================

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

/**
 * Build a standalone SVG for a budget status (from budget.computeBudgetStatus).
 * Pure. Returns "" when income isn't set (nothing meaningful to plot).
 */
export function budgetChartSvg(status, { width = 660, height = 380 } = {}) {
  if (!status || !status.incomeSet) return "";
  const { series = [], daysInMonth, day, savingsRate, ym, pctOfIncome } = status;
  const capPct = Math.round((1 - savingsRate) * 100); // spend-cap line, e.g. 90% for 10% savings
  const pts = series.map((p) => ({ x: p.day, y: p.pctOfIncome ?? 0 }));
  const maxY = Math.max(100, capPct + 5, ...pts.map((p) => p.y));
  const yMax = Math.ceil(maxY / 10) * 10;

  const m = { l: 48, r: 16, t: 28, b: 34 };
  const iw = width - m.l - m.r, ih = height - m.t - m.b;
  const X = (d) => m.l + (iw * (d - 1)) / Math.max(1, daysInMonth - 1);
  const Y = (pct) => m.t + ih * (1 - pct / yMax);

  const gridY = [];
  for (let p = 0; p <= yMax; p += 25) {
    gridY.push(
      `<line x1="${m.l}" y1="${Y(p)}" x2="${m.l + iw}" y2="${Y(p)}" stroke="#e5e5e5" stroke-width="1"/>` +
      `<text x="${m.l - 6}" y="${Y(p) + 4}" text-anchor="end" font-size="11" fill="#888">${p}%</text>`
    );
  }
  const capY = Y(capPct);
  const incomeY = Y(100);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
  const lastPt = pts[pts.length - 1];
  const overCap = (pctOfIncome ?? 0) > capPct;
  const lineColor = overCap ? "#c62828" : "#2e7d32";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Georgia, serif">`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="${m.l}" y="18" font-size="14" fill="#333">Budget burn — ${esc(ym)} (day ${day}/${daysInMonth})</text>`,
    ...gridY,
    // income (100%) line
    `<line x1="${m.l}" y1="${incomeY}" x2="${m.l + iw}" y2="${incomeY}" stroke="#bbb" stroke-width="1" stroke-dasharray="2 3"/>`,
    `<text x="${m.l + iw}" y="${incomeY - 4}" text-anchor="end" font-size="10" fill="#999">income (100%)</text>`,
    // spend-cap (savings goal) line
    `<line x1="${m.l}" y1="${capY}" x2="${m.l + iw}" y2="${capY}" stroke="#1565c0" stroke-width="1.5" stroke-dasharray="6 4"/>`,
    `<text x="${m.l + iw}" y="${capY - 4}" text-anchor="end" font-size="10" fill="#1565c0">spend cap ${capPct}% (save ${Math.round(savingsRate * 100)}%)</text>`,
    // ideal pace diagonal to the cap
    `<line x1="${X(1)}" y1="${Y(pts[0]?.y ?? 0)}" x2="${X(daysInMonth)}" y2="${capY}" stroke="#f0a020" stroke-width="1" stroke-dasharray="3 4"/>`,
    // the actual burn line + end dot
    `<path d="${line}" fill="none" stroke="${lineColor}" stroke-width="2.5"/>`,
    lastPt ? `<circle cx="${X(lastPt.x).toFixed(1)}" cy="${Y(lastPt.y).toFixed(1)}" r="4" fill="${lineColor}"/>` : "",
    lastPt ? `<text x="${X(lastPt.x).toFixed(1)}" y="${Y(lastPt.y) - 8}" text-anchor="middle" font-size="12" fill="${lineColor}">${pctOfIncome}%</text>` : "",
    // x axis day labels (every 5th)
    `<text x="${m.l}" y="${height - 12}" font-size="11" fill="#888">1</text>`,
    `<text x="${m.l + iw}" y="${height - 12}" text-anchor="end" font-size="11" fill="#888">${daysInMonth}</text>`,
    `<text x="${m.l + iw / 2}" y="${height - 12}" text-anchor="middle" font-size="11" fill="#888">day of month</text>`,
    `</svg>`,
  ].filter(Boolean).join("");
}

/**
 * Render the SVG to a PNG Buffer via the local browser. Best-effort: throws if
 * Playwright isn't available (caller falls back to the text summary / SVG).
 */
export async function renderBudgetChartPng(svg, { width = 660, height = 380 } = {}) {
  if (!svg) throw new Error("no chart to render (income not set?)");
  return withPage(async (page) => {
    await page.setViewportSize({ width, height });
    await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`, { waitUntil: "load" });
    const el = await page.$("svg");
    const buf = await (el || page).screenshot({ type: "png" });
    log.info("budget chart rendered", { bytes: buf.length });
    return buf;
  });
}
