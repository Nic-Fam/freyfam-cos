// Local printing via CUPS (`lp`). Runs on Lloyd's host (the Mac mini), on the
// home LAN with the printer, so nothing leaves the house -- fits local-first,
// unlike the cloud channels. Pairs with image generation (generate -> print,
// e.g. coloring pages for Fox).
//
// Defensive + lazy like the browser/slack capabilities: if `lp` isn't present or
// no printer is configured, it returns a clear message instead of throwing, so
// the daemon and tests run fine on a host with no printer. `runProcess` is
// injectable so tests never shell out.

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

const PRINTER = {
  // lp uses the system DEFAULT printer when no -d is given; PRINTER_NAME pins one.
  name: process.env.PRINTER_NAME || null,
  enabled: String(process.env.PRINTER_ENABLED ?? "true").toLowerCase() === "true",
};

// Spawn a command, capture stdout/stderr, resolve {code, stdout, stderr}. Never
// rejects on a non-zero exit (the caller maps that to a friendly message); only
// rejects if the binary can't be spawned at all (e.g. lp missing).
function run(cmd, args = []) {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    const p = spawn(cmd, args);
    p.on("error", reject);
    p.stdout?.on("data", (d) => (stdout += d));
    p.stderr?.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Available printers + the default, from `lpstat`. Best-effort. */
export async function listPrinters({ runProcess = run } = {}) {
  try {
    const r = await runProcess("lpstat", ["-p", "-d"]);
    const printers = [...(r.stdout || "").matchAll(/^printer (\S+)/gim)].map((m) => m[1]);
    const def = (r.stdout || "").match(/system default destination: (\S+)/i)?.[1] || PRINTER.name || null;
    return { printers, default: def };
  } catch (e) {
    return { printers: [], default: null, error: `lp/CUPS not available on this host: ${e.message}` };
  }
}

/**
 * Print a local file. Returns {ok, message, printer?}. Does NOT throw on a print
 * failure -- surfaces a clear message the chief can relay. `file` must exist on
 * this host (e.g. a generated image saved under data/).
 */
export async function printDocument(file, { printer, copies = 1, runProcess = run } = {}) {
  if (!PRINTER.enabled) return { ok: false, message: "Printing is disabled (set PRINTER_ENABLED=true)." };
  if (!file) return { ok: false, message: "No file given to print." };
  try { await access(file); } catch { return { ok: false, message: `File not found on the host: ${file}` }; }

  const target = printer || PRINTER.name;
  const args = [];
  if (target) args.push("-d", target);
  if (copies && Number(copies) > 1) args.push("-n", String(Math.floor(copies)));
  args.push(file);

  try {
    const r = await runProcess("lp", args);
    if (r.code !== 0) {
      return { ok: false, message: `Print failed: ${(r.stderr || "").trim() || "lp exit " + r.code}` };
    }
    // lp prints e.g. "request id is Office-42 (1 file(s))"
    const id = (r.stdout || "").match(/request id is (\S+)/i)?.[1] || null;
    return { ok: true, message: (r.stdout || "").trim() || "sent to printer", printer: target || "system default", jobId: id };
  } catch (e) {
    return { ok: false, message: `Printing needs CUPS/lp on this host (the Mac mini): ${e.message}` };
  }
}

export const _PRINTER = PRINTER; // test/config visibility
