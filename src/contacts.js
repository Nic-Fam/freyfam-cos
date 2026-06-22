import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ===========================================================================
// A tiny record of email addresses Lloyd has written to before. It exists for
// one reason: so Lloyd knows whether an outbound email is a FIRST contact (and
// should open with an introduction). Recorded when an email actually sends; the
// list is injected into the chief's context so he can tell new from known. When
// in doubt (address not clearly here), the rule is to introduce himself.
// ===========================================================================

const STORE_PATH = () => process.env.CONTACTS_PATH || "./data/contacts.json";

const norm = (a) => String(a || "").toLowerCase().trim();

async function load() {
  try {
    const arr = JSON.parse(await readFile(STORE_PATH(), "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** All addresses Lloyd has emailed before (lowercased). */
export async function getEmailContacts() {
  return load();
}

/** True if Lloyd has emailed this address before. */
export async function hasEmailed(address) {
  return (await load()).includes(norm(address));
}

/** Record one or more recipients as known contacts (idempotent). */
export async function recordEmailContact(addresses) {
  const list = Array.isArray(addresses) ? addresses : [addresses];
  const incoming = list.map(norm).filter(Boolean);
  if (!incoming.length) return;
  const known = new Set(await load());
  let changed = false;
  for (const a of incoming) if (!known.has(a)) { known.add(a); changed = true; }
  if (!changed) return;
  await mkdir(dirname(STORE_PATH()), { recursive: true });
  await writeFile(STORE_PATH(), JSON.stringify([...known], null, 2));
}
