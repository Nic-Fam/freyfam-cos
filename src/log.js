// ===========================================================================
// Tiny dependency-free structured logger. One JSON object per line so the
// launchd logs (cos.out.log / cos.err.log) stay greppable and parseable.
// Level via LOG_LEVEL env (error|warn|info|debug); default info. warn + error
// go to stderr so they land in cos.err.log; info/debug go to stdout.
// ===========================================================================

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;

function emit(level, component, msg, fields) {
  if (LEVELS[level] > threshold) return;
  const rec = { t: new Date().toISOString(), level, component, msg };
  if (fields) for (const [k, v] of Object.entries(fields)) rec[k] = v;
  const line = JSON.stringify(rec) + "\n";
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line);
}

/**
 * Scoped logger for a component.
 * @example const log = createLogger("queue"); log.info("consuming", { queue });
 */
export function createLogger(component) {
  return {
    info: (msg, fields) => emit("info", component, msg, fields),
    warn: (msg, fields) => emit("warn", component, msg, fields),
    error: (msg, fields) => emit("error", component, msg, fields),
    debug: (msg, fields) => emit("debug", component, msg, fields),
  };
}
