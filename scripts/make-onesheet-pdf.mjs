import { chromium } from "playwright";

// Render the Frey family team one-sheet to a print-quality PDF (Letter, 1 page).
// Self-contained HTML + inline CSS (system fonts, fixed print colors — not the
// widget's dark-mode vars). Run: node scripts/make-onesheet-pdf.mjs

const agents = [
  { name: "Lloyd", role: "Chief of staff", bullets: [
    "Your single point of contact. Tell him what you need; he does it or hands it to the right specialist.",
    "Books appointments and adds your and Nic's work calendars automatically.",
    "Reads a forwarded PDF or calendar invite and acts on it.",
  ], example: "\"Lloyd, book Fox's dentist Thursday at 2.\" He creates the event and, because it is during the workday, invites both work calendars." },
  { name: "Patrick", role: "Finance", bullets: [
    "Flags a duplicate charge or a subscription whose price jumped.",
    "Summarizes where the month's money went, by category.",
    "Surfaces the action and lets a human do it. He never moves money.",
  ], example: "\"Heads up: the streaming bundle went from $19 to $29, and there is a duplicate $14 charge from the 3rd.\"" },
  { name: "Carmine", role: "Kitchen and meals", bullets: [
    "Plans the week around what is already in the fridge, to cut waste.",
    "Knows the family's allergies and dislikes (no nuts for Fox) and plans around them.",
    "Snap a photo of groceries or a receipt and he updates the inventory.",
  ], example: "\"This week's dinners use the salmon and chicken before they expire. Thaw the salmon Tuesday morning.\"" },
  { name: "Shey", role: "Reseller and archive hunt", bullets: [
    "Watches Poshmark, eBay, Vestiaire, The RealReal and 1stDibs for a target piece and flags strong matches.",
    "Drafts a listing to sell something. You approve before it posts.",
    "Catalogs an item from a photo.",
  ], example: "\"Found the Margiela Tabis in your size on Vestiaire, $310, very good condition. Want the link?\"" },
  { name: "Steve", role: "Developer", bullets: [
    "Builds small household apps and automations. Genet's developer built a kids' TV app limited to approved channels.",
    "Proposes changes as clear plans you approve. He never ships on his own.",
  ], example: "\"Here is a plan for a one-button kids' streaming app that only plays channels you approve. Say go and I will build it.\"" },
  { name: "Frank", role: "Home and IT security", bullets: [
    "Flags a suspicious login, a breached password, or a device missing updates.",
    "Spots phishing in the family inbox and warns you.",
    "Advises only. He never disarms an alarm or changes a setting without your say-so.",
  ], example: "\"A login to your email from a new device in another state just now. If that was not you, change the password. Want the steps?\"" },
];

const card = (a) => `
  <div class="card">
    <div class="cardhead"><span class="name">${a.name}</span><span class="role">${a.role}</span></div>
    <ul>${a.bullets.map((b) => `<li>${b}</li>`).join("")}</ul>
    <p class="ex"><span class="exlabel">Example</span> ${a.example}</p>
  </div>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: #3f4554; font-size: 9.4px; line-height: 1.45; }
  .page { padding: 2px; }
  h1 { font-size: 21px; font-weight: 600; color: #1f2230; margin: 0 0 3px; letter-spacing: -0.2px; }
  .sub { font-size: 10.5px; color: #6b7280; margin: 0 0 14px; }
  .accent { height: 3px; width: 46px; background: #5b4bb7; border-radius: 2px; margin: 0 0 12px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .card { border: 0.75px solid #e3e3ea; border-radius: 9px; padding: 10px 12px; break-inside: avoid; }
  .cardhead { display: flex; align-items: baseline; gap: 8px; margin: 0 0 5px; border-bottom: 0.75px solid #eeeef2; padding-bottom: 5px; }
  .name { font-size: 13px; font-weight: 600; color: #1f2230; }
  .role { font-size: 9px; color: #8a90a0; text-transform: uppercase; letter-spacing: 0.4px; }
  ul { margin: 0 0 6px; padding-left: 14px; }
  li { margin: 0 0 2.5px; color: #4b5160; }
  .ex { margin: 0; color: #5b4bb7; font-style: italic; }
  .exlabel { font-style: normal; font-weight: 600; font-size: 8px; text-transform: uppercase; letter-spacing: 0.5px; color: #8179c4; margin-right: 4px; }
  .foot { margin-top: 12px; border: 0.75px solid #d9d6ee; background: #f6f4fd; border-radius: 9px; padding: 9px 12px; }
  .foot .name { color: #4a3f8f; font-size: 11px; }
  .foot ul { margin: 4px 0 0; }
  .foot li { color: #534a86; }
  .status { margin: 9px 2px 0; font-size: 8.5px; color: #9aa0ad; }
</style></head><body><div class="page">
  <h1>The Frey family team</h1>
  <div class="accent"></div>
  <p class="sub">Six specialists, one point of contact. Modeled on Jesse Genet's household AI team. Here is what each can do for you.</p>
  <div class="grid">${agents.map(card).join("")}</div>
  <div class="foot">
    <span class="name">How it works</span>
    <ul>
      <li>Reach the team by texting or emailing Lloyd. He routes to the right specialist.</li>
      <li>Anything that spends money or sends on your behalf needs your okay first, with one reply.</li>
      <li>The team also checks in on its own and flags what needs you.</li>
    </ul>
  </div>
  <p class="status">Status: the specialists, scheduling, document and photo intake, and the approval gate are live. Text messaging and a Slack workspace are finishing setup.</p>
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: "load" });
await page.pdf({
  path: "ONESHEET.pdf",
  format: "Letter",
  printBackground: true,
  margin: { top: "0.55in", bottom: "0.5in", left: "0.6in", right: "0.6in" },
});
await browser.close();
console.log("wrote ONESHEET.pdf");
