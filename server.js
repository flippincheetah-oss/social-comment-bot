import express from "express";
import crypto from "node:crypto";
import { decide, log, DRY_RUN } from "./brain.js";
import { startYouTube } from "./youtube.js";
import { matchKeyword, PUBLIC_REPLIES } from "./keywords.js";

const app = express();
const GRAPH = "https://graph.facebook.com/v21.0";
// Basic dedupe; webhooks can repeat. Capped so memory cannot grow forever.
const seen = {
  ids: new Set(),
  has(id) { return this.ids.has(id); },
  add(id) {
    this.ids.add(id);
    if (this.ids.size > 5000) this.ids.delete(this.ids.values().next().value); // drop oldest
  },
};

// Refuse to start without the secrets that protect the webhook.
for (const k of ["META_VERIFY_TOKEN", "META_APP_SECRET"]) {
  if (!process.env[k]) {
    console.error(`Missing ${k} in .env. Set it before starting the server.`);
    process.exit(1);
  }
}

// keep raw body so we can verify Meta's signature
app.use(express.json({ verify: (req, _res, buf) => (req.raw = buf) }));

// Meta webhook verification handshake
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    process.env.META_VERIFY_TOKEN &&
    req.query["hub.verify_token"] === process.env.META_VERIFY_TOKEN
  )
    return res.send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

function validSignature(req) {
  const sig = req.get("x-hub-signature-256") || "";
  const mac =
    "sha256=" +
    crypto.createHmac("sha256", process.env.META_APP_SECRET).update(req.raw).digest("hex");
  return sig.length === mac.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac));
}

async function graphPost(path, body) {
  const r = await fetch(`${GRAPH}${path}?access_token=${process.env.META_PAGE_TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Graph ${r.status}: ${await r.text()}`);
}

// ---- Keyword flow: instant public reply + one private DM ----
// The keywords, DM texts and prices live in keywords.json (edit that file, not this one).
const pickPublicReply = () => PUBLIC_REPLIES[Math.floor(Math.random() * PUBLIC_REPLIES.length)];

async function keywordFlow(platform, id, from, kw, send_public, send_private) {
  if (seen.has(id)) return;
  seen.add(id);
  const pub = pickPublicReply();
  log({ platform, kind: `keyword-${kw.name}`, id, from, public: pub, dm: kw.dm, posted: false });
  if (DRY_RUN) return console.log(`[dry-run] ${kw.name} keyword from ${from}: "${pub}" + private DM`);
  try {
    await send_private(kw.dm); // DM first: that's what matters
    await send_public(pub);
    log({ id, posted: true });
  } catch (e) {
    log({ id, error: String(e) });
    console.error(`SEND FAILED (${platform} ${kw.name} from ${from}): ${String(e).slice(0, 500)}`);
    await notify(`Keyword reply FAILED: ${platform} ${kw.name}`, `From: ${from}\n\nError: ${String(e).slice(0, 400)}`).catch(() => {});
  }
}

// ---- Push alert (ntfy) when the bot skips something that needs a human ----
async function notify(title, body) {
  const { TELEGRAM_BOT_TOKEN: tg, TELEGRAM_CHAT_ID: chat, NTFY_TOPIC: topic } = process.env;
  const jobs = [];
  // Telegram (main)
  if (tg && chat) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${tg}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text: `⚠️ ${title}\n\n${body}\n\nInbox: https://business.facebook.com/latest/inbox/all`,
          disable_web_page_preview: true,
        }),
      }).then(async (r) => { if (!r.ok) throw new Error(`telegram ${r.status}`); })
    );
  }
  // ntfy (backup, only if configured)
  if (topic) {
    jobs.push(
      fetch(`https://ntfy.sh/${topic}`, {
        method: "POST",
        headers: {
          Title: title, // ASCII only (HTTP header)
          Priority: "high",
          Tags: "warning",
          Click: "https://business.facebook.com/latest/inbox/all",
        },
        body,
      })
    );
  }
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === "rejected") console.error("alert failed:", r.reason?.message);
}

async function handle(platform, kind, id, from, text, send) {
  if (!text || seen.has(id)) return;
  seen.add(id);
  // Someone DMs just a keyword from keywords.json: send the matching full message (same as the comment flow)
  const dmKw = kind === "dm" ? matchKeyword(text) : null;
  if (dmKw) {
    log({ platform, kind: `dm-${dmKw.name}`, id, from, message: text, dm: dmKw.dm, posted: false });
    if (DRY_RUN) return console.log(`[dry-run] DM "${dmKw.name}" from ${from} -> keyword message`);
    try { await send(dmKw.dm); log({ id, posted: true }); } catch (e) { log({ id, error: String(e) }); }
    return;
  }
  const d = await decide({ platform, kind, from, text });
  log({ platform, kind, id, from, message: text, ...d, posted: false });
  if (d.action === "escalate") {
    await notify(
      `Needs you: ${platform} ${kind}`,
      `From: ${from}\n"${String(text).slice(0, 500)}"\n\nWhy skipped: ${d.reason ?? "unclear"}`
    );
  }
  if (d.action !== "reply" || !d.text) return;
  if (DRY_RUN) return console.log(`[dry-run] ${platform} ${kind} -> ${d.text}`);
  try {
    await send(d.text);
    log({ id, posted: true });
  } catch (e) {
    log({ id, error: String(e) });
    await notify(`Reply FAILED: ${platform} ${kind}`, `From: ${from}\n"${String(text).slice(0, 300)}"\n\nError: ${String(e).slice(0, 300)}`);
  }
}

app.post("/webhook", (req, res) => {
  if (!validSignature(req)) return res.sendStatus(403);
  res.sendStatus(200); // answer fast, work after
  const body = req.body;
  log({ kind: "raw-webhook", body: JSON.stringify(body).slice(0, 1500) });
  console.log("webhook received:", body.object, (body.entry || []).length, "entries");
  for (const e of body.entry || []) for (const c of e.changes || []) {
    const v = c.value || {};
    const txt = String(v.message?.text ?? v.message ?? v.text ?? "");
    console.log(`event ${body.object}/${c.field}: from=${v.from?.name || v.from?.username || v.sender?.id || "?"} text=${JSON.stringify(txt.slice(0, 80))} keyword=${matchKeyword(txt)?.name ?? "none"}`);
  }
  const selfIds = new Set([process.env.META_IG_USER_ID]);

  for (const entry of body.entry || []) {
    // Comments (Instagram: field "comments"; Facebook Page: field "feed")
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      // Instagram DM sent in the "changes" layout (used by some tests/versions)
      if (ch.field === "messages" && v.message?.text && !v.message?.is_echo) {
        if (v.sender?.id !== entry.id && !selfIds.has(v.sender?.id)) {
          handle("instagram", "dm", v.message.mid, v.sender?.id, v.message.text, (t) =>
            graphPost(`/${process.env.META_IG_USER_ID}/messages`, {
              recipient: { id: v.sender.id }, messaging_type: "RESPONSE", message: { text: t },
            })
          );
        }
        continue;
      }
      const igKw = ch.field === "comments" ? matchKeyword(v.text) : null;
      if (ch.field === "comments" && v.id && !selfIds.has(v.from?.id) && igKw) {
        keywordFlow(
          "instagram", v.id, v.from?.username, igKw,
          (t) => graphPost(`/${v.id}/replies`, { message: t }),
          (t) => graphPost(`/${process.env.META_IG_USER_ID}/messages`, {
            recipient: { comment_id: v.id }, message: { text: t },
          })
        );
      } else if (ch.field === "comments" && v.id) {
        // Comments that are not a keyword are never answered.
        log({ platform: "instagram", kind: "comment-ignored", id: v.id, from: v.from?.username, message: v.text });
      }
      if (ch.field === "feed" && v.item === "comment" && v.verb === "add" && v.comment_id) {
        if (v.from?.id === entry.id) continue; // our own page's comment
        const fbKw = matchKeyword(v.message);
        if (fbKw) {
          keywordFlow(
            "facebook", v.comment_id, v.from?.name, fbKw,
            (t) => graphPost(`/${v.comment_id}/comments`, { message: t }),
            (t) => graphPost(`/me/messages`, {
              recipient: { comment_id: v.comment_id }, message: { text: t },
            })
          );
          continue;
        }
        log({ platform: "facebook", kind: "comment-ignored", id: v.comment_id, from: v.from?.name, message: v.message });
      }
    }
    // DMs (Messenger + Instagram messaging)
    for (const m of entry.messaging || []) {
      if (m.message?.is_echo || !m.message?.text) continue;
      const platform = body.object === "instagram" ? "instagram" : "facebook";
      handle(platform, "dm", m.message.mid, m.sender.id, m.message.text, (t) =>
        graphPost(`/me/messages`, {
          recipient: { id: m.sender.id },
          messaging_type: "RESPONSE",
          message: { text: t },
        })
      );
    }
  }
});

app.get("/", (_req, res) => res.send(`social-comment-bot up. dry-run: ${DRY_RUN}`));
app.listen(process.env.PORT || 3000, () =>
  console.log(`listening, DRY_RUN=${DRY_RUN}`)
);

// ---- Safety net: Meta sometimes never sends the webhook for a comment. Every minute, look at the
// newest comments on recent posts + reels and answer any keyword comment we have not handled. ----
async function graphGet(path) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${GRAPH}${path}${sep}access_token=${process.env.META_PAGE_TOKEN}`);
  if (!r.ok) throw new Error(`Graph GET ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
const POLL_WINDOW_MS = 45 * 60 * 1000;
let pollPageId = null;
let pollErrorAlerted = false;
async function pollFacebookComments() {
  try {
    if (!pollPageId) pollPageId = (await graphGet("/me?fields=id")).id;
    const [posts, reels] = await Promise.all([
      graphGet("/me/posts?fields=id&limit=10").catch(() => ({ data: [] })),
      graphGet("/me/video_reels?fields=id&limit=10").catch(() => ({ data: [] })),
    ]);
    const ids = [...new Set([...(posts.data || []), ...(reels.data || [])].map((p) => p.id))];
    let found = 0;
    for (const pid of ids) {
      const c = await graphGet(
        `/${pid}/comments?fields=id,message,created_time,from,comments.limit(10){from}&order=reverse_chronological&limit=15`
      ).catch(() => ({ data: [] }));
      for (const cm of c.data || []) {
        if (Date.now() - new Date(cm.created_time).getTime() > POLL_WINDOW_MS) continue;
        if (cm.from?.id === pollPageId) continue;
        if ((cm.comments?.data || []).some((r) => r.from?.id === pollPageId)) continue; // already answered
        const kw = matchKeyword(cm.message);
        if (!kw || seen.has(cm.id)) continue;
        found++;
        console.log(`poller caught missed comment: from=${cm.from?.name || "?"} keyword=${kw.name}`);
        await keywordFlow(
          "facebook", cm.id, cm.from?.name, kw,
          (t) => graphPost(`/${cm.id}/comments`, { message: t }),
          (t) => graphPost(`/me/messages`, { recipient: { comment_id: cm.id }, message: { text: t } })
        );
      }
    }
    pollErrorAlerted = false;
  } catch (e) {
    console.error("poller error:", String(e).slice(0, 300));
    if (!pollErrorAlerted) {
      pollErrorAlerted = true;
      await notify("Comment safety-net poller error", String(e).slice(0, 400)).catch(() => {});
    }
  }
}
if (process.env.META_PAGE_TOKEN && process.env.POLL_COMMENTS !== "false") {
  setInterval(pollFacebookComments, 60 * 1000);
  setTimeout(pollFacebookComments, 15 * 1000);
}

if (process.env.YT_REFRESH_TOKEN) startYouTube(handle);
