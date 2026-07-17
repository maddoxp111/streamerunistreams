# Streamer University Multiview 🎓

An unofficial fan-made multiview for **Streamer University** — every SU streamer's Twitch stream on one page, control-room style, with live viewer counts and the top clips from across campus.

**Roster:** the full Class of 2026 (Hendrix College edition) — Kai Cenat + 24 faculty/staff + all 120 students, every Twitch login verified. The Class of '25 (Akron) alumni can be added from the roster drawer.

## Modes

| Mode | What it does |
|---|---|
| **▦ The Wall** | Every stream in one dense grid, like a security control room. The top N tiles (you pick: 4/9/16/24) play real video; the rest are live previews that refresh every 20 s. Click a preview to start its video, click a playing tile to move the **audio** to it. |
| **◉ Lecture Hall** | One big stream in the middle **with audio**, a ring of smaller muted streams around it (4/6/8/12). Click a small tile to swap it into the main slot — no reloads, the players just switch channels. |
| **◧ Study Group** | 2×2 quad view. Pick any 4 live channels from the strip; click a tile to move the audio. |
| **▭ Main Stage** | One stream, big, with its Twitch chat beside it. |
| **⟳ Campus Tour** | Auto-rotates through every live channel in your selection (20 s – 2 m per stop) with prev/pause/next controls. |

Every tile shows the streamer's **Twitch @** in the top-left and the **live viewer count** in the top-right.

## Other features

- **Sort** by viewer count, A→Z, or shuffle.
- **Roster picker** — watch everyone, only who's live, or hand-pick your lineup (persisted in localStorage).
- **Dean's List** — scroll down for the most-viewed clips of the week from across all SU channels.
- **Scroll Feed** — watch the clips TikTok-style: full-screen vertical feed, flick (or arrow-key) to snap to the next clip; clicking any clip card drops you into the feed at that clip.
- Live data (who's live + viewer counts) refreshes every 5 s **without reloading any stream**.
- Every stream element is strictly 16:9.

## Running it

Twitch embeds require a real HTTP origin (`file://` won't work):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Or host it anywhere static (GitHub Pages, Netlify, …) — the Twitch `parent` parameter is derived from `location.hostname` automatically, so no configuration is needed.

## How it gets data

No API keys. Live status, viewer counts, avatars, and clips come from Twitch's public web GraphQL endpoint (the same one twitch.tv itself uses from the browser). Streams, chat, and clips all play through official Twitch embeds.

## Tech

Plain HTML/CSS/JS — no build step, no dependencies. The roster lives in `js/roster.js`; edit it to add or remove streamers.

*Not affiliated with Streamer University, Kai Cenat, AMP, or Twitch.*
