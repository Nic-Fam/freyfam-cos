import { TWILIO } from "./config.js";
import { createLogger } from "./log.js";

// ===========================================================================
// Inbound media (MMS) -> Claude image content blocks. The front door passes
// media as [{url, contentType}] on the queue payload (Twilio MediaUrlN +
// MediaContentTypeN). Here we fetch each image and turn it into a base64 image
// block the agent loop can send to Claude.
//
// Twilio media URLs require HTTP basic auth (AccountSid:AuthToken) and 302 to
// pre-signed storage (fetch follows the redirect). Only Claude-supported image
// types are kept; audio / vCard / oversize items are skipped (logged), never
// fatal - a photo with junk attachments still gets processed.
//
// Returns text-only callers nothing extra: the daemon's outbound path is
// unchanged, so the read-only-domain guard + confirmation gate still apply.
// ===========================================================================

const log = createLogger("media");

// Image types Claude accepts (https://docs.claude.com/en/docs/build-with-claude/vision).
const SUPPORTED = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGES = Number(process.env.MEDIA_MAX_IMAGES || 5);
const MAX_BYTES = Number(process.env.MEDIA_MAX_BYTES || 4_500_000); // stay under Claude's ~5MB/image

// Sniff the REAL image type from the leading bytes (magic numbers). Senders lie:
// Slack hands us files named "image.png" with mimetype "image/jpeg", and passing
// a media_type that disagrees with the actual bytes makes Claude reject the whole
// request with "Could not process image". The bytes are ground truth, so we
// derive media_type from them and fall back to the declared type only when the
// signature is unrecognized. Returns null if the buffer is too short to tell.
export function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// iPhone photos are HEIC/HEIF (ISO base-media: an "ftyp" box with a heic-family
// brand). Claude vision does NOT accept HEIC, and Slack/Messages often pass it
// through mislabeled as image/jpeg. Detect it so we can skip with a precise,
// actionable reason instead of sending a block Claude rejects.
export function isHeic(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (buf.toString("ascii", 4, 8) !== "ftyp") return false;
  return ["heic", "heix", "hevc", "heif", "mif1", "msf1"].includes(buf.toString("ascii", 8, 12));
}

// HEIC -> JPEG transcode via heic-convert (pure-JS libheif, no native build).
// Lazy + optional, exactly like @slack/bolt: if the dep is absent we return null
// and the caller degrades to the "resend as JPEG" path, so the daemon never hard
// -depends on it. Memoized so we import once.
let _heicConvert; // undefined = not tried, null = unavailable, fn = loaded
async function heicToJpeg(buf) {
  if (_heicConvert === undefined) {
    try {
      _heicConvert = (await import("heic-convert")).default;
    } catch {
      _heicConvert = null;
      log.warn("heic-convert not installed; HEIC photos will ask for a resend");
    }
  }
  if (!_heicConvert) return null;
  try {
    return Buffer.from(await _heicConvert({ buffer: buf, format: "JPEG", quality: 0.9 }));
  } catch (err) {
    log.warn("heic transcode failed", { reason: err.message });
    return null;
  }
}

// Produce a Claude-ready { bytes, mediaType }, trusting the bytes over the declared
// type. The four signatures we sniff ARE exactly Claude's supported set, so if the
// bytes don't sniff to one of them we don't gamble — sending a block Claude 400s on
// kills the whole turn (the bug that made resale "do nothing" on a Slack photo).
// iPhone HEIC is transcoded to JPEG so it just works; an unconvertible/unknown
// image returns { reason } and the caller SKIPS it (logged, non-fatal).
async function prepareImage(buf, declaredCt) {
  const sniffed = sniffImageType(buf);
  if (sniffed && SUPPORTED.has(sniffed)) return { bytes: buf, mediaType: sniffed };
  if (isHeic(buf)) {
    const jpeg = await heicToJpeg(buf);
    if (jpeg && jpeg.length <= MAX_BYTES) return { bytes: jpeg, mediaType: "image/jpeg" };
    if (jpeg) return { reason: `HEIC transcoded but too large (${jpeg.length}B)` };
    return { reason: `HEIC/HEIF image (declared ${declaredCt}); could not transcode, resend as JPEG or PNG` };
  }
  return { reason: `unrecognized image bytes (declared ${declaredCt}; not jpeg/png/gif/webp)` };
}

function basicAuth(twilio) {
  if (!twilio.accountSid || !twilio.authToken) return null;
  return "Basic " + Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64");
}

/**
 * @param {{url:string, contentType?:string}[]} media
 * @returns {Promise<{imageBlocks:object[], skipped:object[]}>}
 */
export async function fetchInboundMedia(media = [], { fetchImpl = fetch, twilio = TWILIO } = {}) {
  const imageBlocks = [];
  const skipped = [];
  if (!Array.isArray(media) || media.length === 0) return { imageBlocks, skipped };
  const auth = basicAuth(twilio);

  for (const item of media.slice(0, MAX_IMAGES)) {
    const ct = String(item?.contentType || "").toLowerCase().split(";")[0].trim();
    if (!SUPPORTED.has(ct)) { skipped.push({ url: item?.url, contentType: ct, reason: "unsupported type" }); continue; }
    // Callers may pass already-downloaded bytes (e.g. Slack, where the file needs
    // a bot-token download) instead of a fetchable URL.
    if (item?.bytes != null) {
      const buf = Buffer.isBuffer(item.bytes) ? item.bytes : Buffer.from(item.bytes, "base64");
      if (buf.length > MAX_BYTES) { skipped.push({ reason: `too large (${buf.length}B)` }); continue; }
      const r = await prepareImage(buf, ct);
      if (!r.mediaType) { skipped.push({ reason: r.reason }); continue; }
      imageBlocks.push({ type: "image", source: { type: "base64", media_type: r.mediaType, data: r.bytes.toString("base64") } });
      continue;
    }
    if (!item?.url) { skipped.push({ reason: "no url or bytes" }); continue; }
    try {
      // Per-item headers (e.g. Slack Bearer) win; else the Twilio basic auth.
      const headers = item.headers || (auth ? { Authorization: auth } : undefined);
      const res = await fetchImpl(item.url, headers ? { headers } : {});
      if (!res.ok) { skipped.push({ url: item.url, reason: `HTTP ${res.status}` }); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) { skipped.push({ url: item.url, reason: `too large (${buf.length}B)` }); continue; }
      const r = await prepareImage(buf, ct);
      if (!r.mediaType) { skipped.push({ url: item.url, reason: r.reason }); continue; }
      imageBlocks.push({ type: "image", source: { type: "base64", media_type: r.mediaType, data: r.bytes.toString("base64") } });
    } catch (err) {
      skipped.push({ url: item.url, reason: err.message });
    }
  }
  if (media.length > MAX_IMAGES) skipped.push({ reason: `capped at ${MAX_IMAGES} images` });
  if (skipped.length) log.warn("skipped inbound media", { kept: imageBlocks.length, skipped });
  return { imageBlocks, skipped };
}
