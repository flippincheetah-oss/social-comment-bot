// Turns a short-lived user token (TEMP_USER_TOKEN) into a long-lived Page token
// and finds your Instagram ID. Writes results into .env. Prints no secrets.
// Run: npm run tokens        (optional: PAGE_NAME="Exact Page Name" npm run tokens)
import { readFileSync, writeFileSync } from "node:fs";

const GRAPH = "https://graph.facebook.com/v21.0";
const envPath = new URL("./.env", import.meta.url);
const { META_APP_ID, META_APP_SECRET, TEMP_USER_TOKEN, PAGE_NAME } = process.env;

for (const [k, v] of Object.entries({ META_APP_ID, META_APP_SECRET, TEMP_USER_TOKEN })) {
  if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
}

async function get(path, params) {
  const url = `${GRAPH}${path}?${new URLSearchParams(params)}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
  return j;
}

function setEnv(key, value) {
  let txt = readFileSync(envPath, "utf8");
  const re = new RegExp(`^${key}=.*$`, "m");
  txt = re.test(txt) ? txt.replace(re, `${key}=${value}`) : txt.trimEnd() + `\n${key}=${value}\n`;
  writeFileSync(envPath, txt);
}

// 1) long-lived user token (about 60 days)
const ll = await get("/oauth/access_token", {
  grant_type: "fb_exchange_token",
  client_id: META_APP_ID,
  client_secret: META_APP_SECRET,
  fb_exchange_token: TEMP_USER_TOKEN,
});

// 2) Pages this user manages. Page tokens from a long-lived user token do not expire.
const pages = await get("/me/accounts", {
  access_token: ll.access_token,
  fields: "id,name,access_token,instagram_business_account",
  limit: 100,
});
console.log("Pages found:", pages.data.map((p) => `${p.name}${p.instagram_business_account ? " (has Instagram)" : ""}`).join(" | ") || "none");

let page = PAGE_NAME
  ? pages.data.find((p) => p.name === PAGE_NAME)
  : pages.data.filter((p) => p.instagram_business_account).length === 1
    ? pages.data.find((p) => p.instagram_business_account)
    : pages.data.length === 1 ? pages.data[0] : null;

if (!page) {
  console.error('Could not pick one Page. Re-run with:  PAGE_NAME="Exact Page Name" npm run tokens');
  process.exit(1);
}
if (!page.instagram_business_account) {
  console.error(`Page "${page.name}" has no linked Instagram account. Link it in Instagram settings first.`);
  process.exit(1);
}

setEnv("META_PAGE_TOKEN", page.access_token);
setEnv("META_IG_USER_ID", page.instagram_business_account.id);
setEnv("TEMP_USER_TOKEN", ""); // short-lived token no longer needed
console.log(`Saved Page token and Instagram ID for "${page.name}" into .env.`);
console.log(`Instagram ID ends in ...${String(page.instagram_business_account.id).slice(-4)}`);
