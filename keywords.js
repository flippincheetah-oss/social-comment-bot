// Loads keywords.json and turns each keyword into a matcher.
// A message matches only if it is JUST the keyword (plus punctuation/emoji),
// e.g. "tour", "TOUR!", "Tour 🔥". A long question containing the word does NOT match;
// those go to Claude instead.
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("./keywords.json", import.meta.url), "utf8"));

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function fill(text) {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, key) => config.company?.[key] ?? "");
}

export const PUBLIC_REPLIES = config.publicReplies;

export const KEYWORDS = config.keywords.map((k) => {
  const words = k.triggers.map(escapeRegex).join("|");
  const re = new RegExp(`^\\s*(?:${words})[\\s!.?\\p{Extended_Pictographic}\\uFE0F]*$`, "iu");
  return {
    name: k.name,
    test: (t) => re.test(t || ""),
    dm: fill(k.dm.join("\n")),
  };
});

export const matchKeyword = (t) => KEYWORDS.find((k) => k.test(t));
