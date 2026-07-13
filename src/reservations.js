import { withHeadedPage } from "./channels/browser.js";
import { createLogger } from "./log.js";

// ===========================================================================
// Restaurant reservations (item 003). Read-only availability first; booking is a
// high-stakes outbound action that the orchestrator wraps in confirm.js (the gate
// is the protection — this module never books without an approved final step).
//
// Runs HEADED (withHeadedPage) on Lloyd's mini: Resy/OpenTable bot-block the
// headless automation browser, but load fine headed with the signed-in profile.
// Resy exposes date + party via URL query (?date=YYYY-MM-DD&seats=N), so we build
// the venue URL directly and read the rendered slot buttons — no calendar/guest
// clicking. Venue URL is resolved by name via web search upstream (Brave), or the
// caller passes a resy.com venue URL directly.
// ===========================================================================

const log = createLogger("reservations");

/** Build a Resy venue URL with the date + party applied. Accepts a full resy URL. */
export function resyVenueUrl({ url, city, slug, date, partySize = 2 }) {
  let u;
  if (url) {
    if (!/^https?:\/\/(www\.)?resy\.com\//i.test(url)) throw new Error("not a resy.com venue URL");
    u = new URL(url);
  } else {
    if (!city || !slug) throw new Error("need a resy url, or city + slug");
    u = new URL(`https://resy.com/cities/${city}/venues/${slug}`);
  }
  if (date) u.searchParams.set("date", date);
  if (partySize) u.searchParams.set("seats", String(partySize));
  return u.toString();
}

/**
 * Read the available reservation slots for a Resy venue on a given date + party.
 * READ-ONLY (no clicks that book). Returns { venue, url, date, partySize, slots }
 * where slots is [{ time, type }]. Empty slots = no availability (not an error).
 */
export async function resyAvailability({ url, city, slug, date, partySize = 2, timeoutMs = 40000 } = {}) {
  const venueUrl = resyVenueUrl({ url, city, slug, date, partySize });
  return withHeadedPage(async (page) => {
    await page.goto(venueUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    // The reservation widget paints its slots via an async API call. Wait for a
    // slot, a "no availability" state, or a sign-in wall — whichever comes first.
    await page.waitForSelector(
      '.ReservationButton__time, [data-test-id="reservation-button-test-list"], [class*="NoInventory" i], [class*="no-availability" i]',
      { timeout: 15000 }
    ).catch(() => {});
    await page.waitForTimeout(1200);
    const data = await page.evaluate(() => {
      const venue = (document.querySelector("h1")?.innerText || "").trim();
      const loginWall = /\b(log in|sign in|create account)\b/i.test(document.body?.innerText || "") &&
        !document.querySelector('[data-test-id="menu_container-button-profile_photo"]');
      const slots = [];
      for (const btn of document.querySelectorAll(".ReservationButton")) {
        const time = (btn.querySelector(".ReservationButton__time")?.innerText || "").replace(/\s+/g, " ").trim();
        if (!time) continue;
        const type = (btn.querySelector(".ReservationButton__type")?.innerText ||
          (btn.innerText || "").replace(time, "")).replace(/\s+/g, " ").trim();
        slots.push({ time, type: type || null });
      }
      return { venue, loginWall, slots };
    });
    if (data.loginWall) log.warn("resy availability hit a login wall", { venueUrl });
    return { url: venueUrl, date, partySize, venue: data.venue, loginWall: data.loginWall, slots: data.slots };
  });
}

// Minutes since midnight for a "4:15 PM" style label (for nearest-time ranking).
export function minutesOfDay(label) {
  const m = String(label || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3] || "")) h += 12;
  return h * 60 + Number(m[2]);
}

/**
 * Book a specific Resy slot. HIGH-STAKES: the caller (orchestrator) stages this
 * behind confirm.js and only runs it on the owner's approval — this function does
 * the actual booking click. Navigates the venue, clicks the slot matching `time`
 * (+ optional seating `type`), and clicks "Reserve Now" in Resy's confirm iframe.
 * NEVER enters card details: if the slot requires a payment method / deposit, it
 * aborts with a note. `dryRun` stops right before the final click (for verifying
 * the path without booking). Returns { booked, ready?, note, venue?, time, type }.
 */
export async function resyBook({ url, city, slug, date, partySize = 2, time, type = null, dryRun = false, timeoutMs = 45000 } = {}) {
  if (!time) throw new Error("time is required to book");
  const venueUrl = resyVenueUrl({ url, city, slug, date, partySize });
  const wantMin = minutesOfDay(time);
  return withHeadedPage(async (page) => {
    await page.goto(venueUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForSelector(".ReservationButton__time", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const venue = (await page.evaluate(() => (document.querySelector("h1")?.innerText || "").trim()).catch(() => "")) || null;
    // Click the slot matching the exact time (+ seating type if given).
    const clicked = await page.evaluate(({ wantMin, type }) => {
      const mins = (t) => { const m = String(t).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i); if (!m) return null; let h = Number(m[1]) % 12; if (/pm/i.test(m[3] || "")) h += 12; return h * 60 + Number(m[2]); };
      for (const btn of document.querySelectorAll(".ReservationButton")) {
        const t = (btn.querySelector(".ReservationButton__time")?.innerText || "").trim();
        const ty = (btn.querySelector(".ReservationButton__type")?.innerText || "").trim();
        if (mins(t) !== wantMin) continue;
        if (type && ty && ty.toLowerCase() !== String(type).toLowerCase()) continue;
        btn.scrollIntoView(); btn.click(); return true;
      }
      return false;
    }, { wantMin, type });
    if (!clicked) return { booked: false, venue, time, type, note: `No ${time}${type ? ` (${type})` : ""} slot available to book.` };
    // Resy opens the confirmation in a widgets.resy.com iframe.
    let frame = null;
    for (let i = 0; i < 24 && !frame; i++) { await page.waitForTimeout(500); frame = page.frames().find((f) => /widgets\.resy\.com/.test(f.url()) && /reservation-details/.test(f.url())); }
    if (!frame) return { booked: false, venue, time, type, note: "The reservation confirm dialog didn't open." };
    // Payment guard: never enter card details. Abort if a deposit/payment is required.
    const u = decodeURIComponent(frame.url());
    if (/"is_paid":true/.test(u) || /"is_add_on_required":true/.test(u) || /"deposit_fee":[1-9]/.test(u)) {
      return { booked: false, venue, time, type, note: "This reservation requires a payment method or deposit — I don't enter card details. Please book it manually." };
    }
    await frame.waitForSelector('[data-test-id="order_summary_page-button-book"]', { timeout: 15000 });
    if (dryRun) return { booked: false, ready: true, venue, time, type, note: "Slot open and confirm dialog ready (dry run — did NOT book)." };
    await frame.click('[data-test-id="order_summary_page-button-book"]');
    await page.waitForTimeout(4500);
    const confirm = await page.evaluate(() => {
      const t = (document.body?.innerText || "").replace(/\s+/g, " ");
      return (t.match(/you'?re all set|reservation confirmed|confirmed for/i) || [])[0] || null;
    }).catch(() => null);
    log.info("resy booking clicked", { venue, time, type });
    return { booked: true, venue, time, type, note: confirm || "Reserve Now clicked; reservation submitted." };
  });
}

/** Rank/dedupe slots by closeness to a desired "7:00 PM"; returns nearest first. */
export function slotsNear(slots, desired, { window = 90 } = {}) {
  const want = minutesOfDay(desired);
  const uniq = new Map();
  for (const s of slots) {
    const key = s.time;
    if (!uniq.has(key)) uniq.set(key, { time: s.time, types: [] });
    if (s.type) uniq.get(key).types.push(s.type);
  }
  let arr = [...uniq.values()];
  if (want != null) {
    arr = arr
      .map((s) => ({ ...s, delta: Math.abs((minutesOfDay(s.time) ?? 1e9) - want) }))
      .filter((s) => s.delta <= window)
      .sort((a, b) => a.delta - b.delta);
  }
  return arr;
}
