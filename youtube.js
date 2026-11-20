// Polls your channel for new top-level comments every 5 minutes and replies.
// Quota: list = 1 unit, reply = 50 units. Daily cap is 10,000 (~190 replies/day).
const API = "https://www.googleapis.com/youtube/v3";
let lastCheck = new Date(Date.now() - 10 * 60 * 1000);

async function accessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.YT_CLIENT_ID,
      client_secret: process.env.YT_CLIENT_SECRET,
      refresh_token: process.env.YT_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  return (await r.json()).access_token;
}

export function startYouTube(handle) {
  async function tick() {
    try {
      const token = await accessToken();
      const h = { authorization: `Bearer ${token}` };
      const url = `${API}/commentThreads?part=snippet&allThreadsRelatedToChannelId=${process.env.YT_CHANNEL_ID}&order=time&maxResults=50`;
      const r = await fetch(url, { headers: h });
      const data = await r.json();
      const since = lastCheck;
      lastCheck = new Date();
      for (const t of (data.items || []).reverse()) {
        const c = t.snippet.topLevelComment.snippet;
        if (new Date(c.publishedAt) <= since) continue;
        if (c.authorChannelId?.value === process.env.YT_CHANNEL_ID) continue;
        await handle("youtube", "comment", t.id, c.authorDisplayName, c.textOriginal, async (text) => {
          const p = await fetch(`${API}/comments?part=snippet`, {
            method: "POST",
            headers: { ...h, "content-type": "application/json" },
            body: JSON.stringify({ snippet: { parentId: t.id, textOriginal: text } }),
          });
          if (!p.ok) throw new Error(`YT ${p.status}: ${await p.text()}`);
        });
      }
    } catch (e) {
      console.error("youtube tick failed", e.message);
    }
  }
  setInterval(tick, 5 * 60 * 1000);
  tick();
}
