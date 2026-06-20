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
    if (!item?.url) { skipped.push({ reason: "no url" }); continue; }
    if (!SUPPORTED.has(ct)) { skipped.push({ url: item.url, contentType: ct, reason: "unsupported type" }); continue; }
    try {
      const res = await fetchImpl(item.url, auth ? { headers: { Authorization: auth } } : {});
      if (!res.ok) { skipped.push({ url: item.url, reason: `HTTP ${res.status}` }); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) { skipped.push({ url: item.url, reason: `too large (${buf.length}B)` }); continue; }
      imageBlocks.push({ type: "image", source: { type: "base64", media_type: ct, data: buf.toString("base64") } });
    } catch (err) {
      skipped.push({ url: item.url, reason: err.message });
    }
  }
  if (media.length > MAX_IMAGES) skipped.push({ reason: `capped at ${MAX_IMAGES} images` });
  if (skipped.length) log.warn("skipped inbound media", { kept: imageBlocks.length, skipped });
  return { imageBlocks, skipped };
}
