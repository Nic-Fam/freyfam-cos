// Detect inbound verification / sign-in / one-time codes and pull the digits, so
// Lloyd can text the code to the owner immediately instead of leaving it buried
// in the mailbox. Ported from the legacy assistant (pure, no storage).
//
// Conservative by design — order/tracking/case numbers also have digits. Require
// BOTH a 4-8 digit standalone number AND a verification keyword either in the
// subject or within ~80 chars before the number.

const KEYWORDS = /(verification|verify|sign[-\s]?in|sign[-\s]?on|security|access|one[-\s]?time|confirmation|confirm[-\s]?your|two[-\s]?factor|2[-\s]?factor|2fa|otp|mfa|magic|passcode|\bpin\b|\bcode\b)/i;
const KEYWORD_WINDOW_CHARS = 80;

function findCodeCandidates(text) {
  if (!text) return [];
  const candidates = [];
  // Non-digit boundaries so we skip phone numbers / long account IDs, but still
  // catch prefixed codes like "G-318204". The keyword window filters the rest.
  const re = /(?:^|[^\d])(\d{4,8})(?:[^\d]|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const num = m[1];
    const pos = m.index + m[0].indexOf(num);
    if (/^(19|20)\d{2}$/.test(num)) continue; // skip year-like 4-digit numbers
    candidates.push({ num, pos });
    re.lastIndex = pos + num.length;
  }
  return candidates;
}

/** Pull the one-time code from a verification email, or null. Pure. */
export function extractCode(subject, body) {
  const subj = subject || "";
  const combined = `${subj}\n\n${body || ""}`;
  const candidates = findCodeCandidates(combined);
  if (!candidates.length) return null;
  // Prefer the earliest candidate with a keyword in its lead-in window.
  for (const c of candidates) {
    const window = combined.substring(Math.max(0, c.pos - KEYWORD_WINDOW_CHARS), c.pos);
    if (KEYWORDS.test(window)) return c.num;
  }
  // Fallback: a subject that screams verification -> take the first candidate.
  if (KEYWORDS.test(subj)) return candidates[0].num;
  return null;
}

/** True if the email carries an extractable verification code. Pure. */
export function isVerificationEmail(subject, body) {
  return extractCode(subject, body) !== null;
}
