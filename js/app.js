/* ============================================================
   STREAMER UNIVERSITY MULTIVIEW — app logic
   Modes: wall (control room), lecture (1 big + ring), quad,
   theater (stream + chat), tour (auto-rotate).
   ============================================================ */

(() => {
  "use strict";

  const HOST = location.hostname || "localhost";
  const IS_FILE = location.protocol === "file:";

  // ---------- state ----------
  const state = {
    channels: [],            // [{login,name,displayName,avatar,live,viewers,game,title}]
    byLogin: new Map(),
    selected: new Set(),     // logins included in the view
    mode: "theater",         // Main Stage is the front door
    sort: "viewers",
    videoCap: 9,             // wall: how many tiles get real video
    ringSize: "8",           // lecture: tiles around the big one ("3c" = 3 + chat)
    tourSpeed: 30,
    focusLogin: null,        // lecture big tile
    quadLogins: [],
    theaterLogin: null,
    audioLogin: null,
    includeAlumni: false,
    apiOK: true,
    randomSeed: Math.random(),
  };

  /** Class of '26 always; class of '25 alumni when toggled on. */
  function activeRoster() {
    const out = ROSTER_2026.slice();
    if (state.includeAlumni) {
      const seen = new Set(out.map((r) => r.login));
      for (const r of ROSTER_2025) {
        if (!seen.has(r.login)) out.push({ ...r, alum: true });
      }
    }
    return out;
  }

  const players = new Map(); // login -> Twitch.Player or iframe element
  let embedReady = false;
  let tourTimer = null;
  let tourCountTimer = null;
  let tourIndex = 0;
  let tourPaused = false;
  let clipsShown = 0;
  let allClips = [];

  // ---------- dom ----------
  const $ = (id) => document.getElementById(id);
  const stage = $("stage");

  // ---------- utils ----------
  function fmtViewers(n) {
    if (n == null) return "–";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + "K";
    return String(n);
  }

  function fmtDuration(s) {
    const m = Math.floor(s / 60), r = Math.round(s % 60);
    return m > 0 ? `${m}:${String(r).padStart(2, "0")}` : `0:${String(r).padStart(2, "0")}`;
  }

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function seededShuffle(arr) {
    // stable within one render pass so refreshes don't reshuffle
    const a = arr.slice();
    let s = Math.floor(state.randomSeed * 1e9);
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function sortChannels(list) {
    if (state.sort === "alpha") return list.slice().sort((a, b) => a.displayName.localeCompare(b.displayName));
    if (state.sort === "random") return seededShuffle(list);
    return list.slice().sort((a, b) => (b.viewers || 0) - (a.viewers || 0));
  }

  function selectedChannels() {
    return state.channels.filter((c) => state.selected.has(c.login));
  }

  function liveSelected() {
    return sortChannels(selectedChannels().filter((c) => c.live));
  }

  function previewURL(login) {
    const cb = Math.floor(Date.now() / 20000); // 20s buckets
    return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-440x248.jpg?cb=${cb}`;
  }

  // ---------- persistence ----------
  function save() {
    try {
      const allSelected = state.selected.size === state.channels.length;
      localStorage.setItem("su_prefs", JSON.stringify({
        selected: allSelected ? "ALL" : [...state.selected],
        mode: state.mode, sort: state.sort, videoCap: state.videoCap,
        ringSize: state.ringSize, tourSpeed: state.tourSpeed,
        includeAlumni: state.includeAlumni,
        defaultsV2: true,
      }));
    } catch (e) { /* private mode etc. */ }
  }

  function load() {
    try {
      const p = JSON.parse(localStorage.getItem("su_prefs") || "{}");
      if (p.mode) state.mode = p.mode;
      if (!p.defaultsV2) state.mode = "theater"; // one-time: Main Stage becomes the entry view
      if (p.sort) state.sort = p.sort;
      if (p.videoCap != null) state.videoCap = +p.videoCap;
      if (p.ringSize) state.ringSize = String(p.ringSize);
      if (p.tourSpeed) state.tourSpeed = +p.tourSpeed;
      state.includeAlumni = !!p.includeAlumni;
      return p.selected;
    } catch (e) { return null; }
  }

  // ---------- twitch embed script ----------
  function loadEmbedScript() {
    return new Promise((resolve) => {
      if (window.Twitch && window.Twitch.Player) { embedReady = true; return resolve(); }
      const s = document.createElement("script");
      s.src = "https://embed.twitch.tv/embed/v1.js";
      const t = setTimeout(() => resolve(), 7000);
      s.onload = () => { clearTimeout(t); embedReady = !!(window.Twitch && window.Twitch.Player); resolve(); };
      s.onerror = () => { clearTimeout(t); resolve(); };
      document.head.appendChild(s);
    });
  }

  // ---------- players ----------
  let playerSeq = 0;

  function destroyPlayers() {
    players.clear(); // removing DOM nodes kills the iframes
    if (typeof playObserver !== "undefined") playObserver.disconnect();
    if (typeof zoomObserver !== "undefined") zoomObserver.disconnect();
  }

  function capQuality(p, maxH) {
    try {
      const qs = p.getQualities() || [];
      const candidates = qs
        .map((q) => ({ q, h: (/(\d+)p/.exec(q.name || q.group || "") || [])[1] | 0 }))
        .filter((x) => x.h > 0 && x.h <= maxH)
        .sort((a, b) => b.h - a.h);
      if (candidates.length) p.setQuality(candidates[0].q.group);
    } catch (e) { /* stream may not expose qualities yet */ }
  }

  /**
   * Mount a live player for `login` inside tile element. Uses the Twitch
   * JS embed (mute/quality/channel control without reloads) when available,
   * plain iframe otherwise.
   *
   * IMPORTANT: the tile must already be attached to the document — the
   * Twitch embed library resolves its target element by id and throws on
   * detached nodes. We fall back to a plain iframe if it throws anyway.
   */
  /**
   * Twitch's player evaluates autoplay ONCE, against "style visibility"
   * and "viewport visibility" — if the tile is off-screen or the layout
   * is still shifting (fonts, grids filling in) when the player loads,
   * autoplay is refused and programmatic play() won't revive it. So
   * players are never mounted eagerly: tiles are armed, and the observer
   * mounts each player only once its tile is actually visible and the
   * layout has settled. Mounts are also spaced out ~150ms apart.
   */
  const autoMountOpts = new WeakMap(); // tile -> {login, opts}
  let mountGate = Promise.resolve();

  /**
   * How much of the element is UNOBSTRUCTED in the viewport (0..1).
   * The sticky control bar counts as occlusion — Twitch's player fails
   * "style visibility" for anything sitting underneath it.
   */
  function visibleFrac(el) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return 0;
    const bar = $("controlBar");
    const topEdge = bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
    const ih = Math.min(r.bottom, innerHeight) - Math.max(r.top, topEdge);
    const iw = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    return ih > 0 && iw > 0 ? (ih * iw) / (r.height * r.width) : 0;
  }

  /** Has the user ever interacted with the page? Browsers only allow
      unmuted playback after that (sticky user activation). */
  function pageActivated() {
    return !!(navigator.userActivation && navigator.userActivation.hasBeenActive);
  }

  let lastScrollAt = 0;
  addEventListener("scroll", () => { lastScrollAt = performance.now(); }, { passive: true, capture: true });
  const scrollIdle = () => new Promise((res) => {
    const chk = () => (performance.now() - lastScrollAt > 250 ? res() : setTimeout(chk, 120));
    chk();
  });

  function gatedMount(tile, login, opts) {
    mountGate = mountGate.then(async () => {
      await scrollIdle(); // never mount mid-scroll — the check would fail
      await new Promise((res) => setTimeout(res, 150));
      if (!tile.isConnected || players.has(login)) return;
      if (visibleFrac(tile) < 0.75) {
        // partially hidden (or under the sticky bar) — the periodic sweep
        // and observer will pick it up when it's properly on screen
        tile.dataset.autoMount = "1";
        playObserver.observe(tile);
        return;
      }
      tileMedia(tile).innerHTML = "";
      mountPlayer(tile, login, opts);
    });
  }

  const playObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const tile = en.target;
      if (tile.dataset.autoMount === "1") {
        tile.dataset.autoMount = "";
        const cfg = autoMountOpts.get(tile);
        if (cfg) gatedMount(tile, cfg.login, cfg.opts);
      } else {
        const entry = players.get(tile.dataset.login);
        if (entry && entryPaused(entry)) tryPlay(entry);
      }
    }
  }, { threshold: 0.4 });

  /** Arm a tile to get its player as soon as it's visible on screen. */
  function armAutoMount(tile, login, opts) {
    tile.dataset.autoMount = "1";
    autoMountOpts.set(tile, { login, opts });
    playObserver.observe(tile);
  }

  /** Catch-all, runs every 5s: mounts armed tiles that are now properly
      on screen, and re-nudges never-played players (Twitch re-evaluates
      autoplay on every play() call, so refusals heal at a quiet moment).
      A player that has played once is never auto-resumed — a user pause
      stays paused. */
  function sweepArmed() {
    if (!$("clipFeed").hidden) return; // feed covers the stage — don't churn
    document.querySelectorAll('[data-auto-mount="1"]').forEach((tile) => {
      const cfg = autoMountOpts.get(tile);
      if (!cfg || players.has(cfg.login)) return;
      if (visibleFrac(tile) >= 0.75) {
        tile.dataset.autoMount = "";
        gatedMount(tile, cfg.login, cfg.opts);
      }
    });
    const now = Date.now();
    for (const entry of players.values()) {
      if (entry.kind !== "api" || entry.everPlayed) continue;
      if (now - (entry.mountedAt || 0) > 60000) continue;
      if (!entry.tile.isConnected || visibleFrac(entry.tile) < 0.75) continue;
      tryPlay(entry);
    }
  }

  /* Small tiles can't host a plain player: Twitch refuses autoplay for
     embeds under 400x300 ("size"). CSS zoom is the escape hatch — the
     iframe's inner window keeps a 544x306 layout (past the minimum, and
     unlike transform:scale it doesn't trip the visibility check) while
     rendering at tile size. */
  const ZOOM_W = 544, ZOOM_H = 306;
  const zoomObserver = new ResizeObserver((entries) => {
    for (const en of entries) {
      const holder = en.target.querySelector("[data-zoomfit]");
      if (holder) holder.style.zoom = en.target.clientWidth / ZOOM_W;
    }
  });

  function mountPlayer(tile, login, opts = {}) {
    const { muted = true, maxHeight = 0, zoomFit = false } = opts;
    const media = tileMedia(tile);
    const holder = el("div");
    holder.id = "twp-" + (++playerSeq);
    if (zoomFit && "zoom" in document.body.style) {
      holder.dataset.zoomfit = "1";
      holder.style.cssText =
        `position:absolute;top:0;left:0;width:${ZOOM_W}px;height:${ZOOM_H}px;zoom:${media.clientWidth / ZOOM_W};`;
      zoomObserver.observe(media);
    } else {
      holder.style.cssText = "position:absolute;inset:0;";
    }
    media.appendChild(holder);
    tile.classList.add("has-video");

    if (embedReady && holder.isConnected) {
      try {
        const p = new Twitch.Player(holder.id, {
          channel: login,
          parent: [HOST],
          width: "100%",
          height: "100%",
          muted,
          autoplay: true,
        });
        p.addEventListener(Twitch.Player.READY, () => { try { p.play(); } catch (e) {} });
        // a few gentle retries — some browsers/Twitch defer the first attempt
        let nudges = 0;
        const nudge = setInterval(() => {
          try { if (p.isPaused()) p.play(); } catch (e) {}
          if (++nudges >= 3) clearInterval(nudge);
        }, 1500);
        if (maxHeight) {
          let done = false;
          p.addEventListener(Twitch.Player.PLAYING, () => {
            if (done) return; done = true;
            setTimeout(() => capQuality(p, maxHeight), 800);
          });
        }
        const entry = { kind: "api", p, tile, login, mountedAt: Date.now(), everPlayed: false };
        players.set(login, entry);
        if (!muted && opts.mainAudio) setAudio(login); // sync state + gold border
        p.addEventListener(Twitch.Player.PLAYING, () => { entry.everPlayed = true; });
        // Twitch re-evaluates its autoplay requirements on every play()
        // command — refusals are not final. The 5s sweep keeps nudging
        // never-played players while their tile is properly visible.
        p.addEventListener("playbackBlocked", () =>
          console.warn("[SU] autoplay blocked for", login, "— retrying while visible"));
        playObserver.observe(tile);
        return;
      } catch (e) {
        console.warn("Twitch.Player failed for", login, "— falling back to iframe", e);
      }
    }
    const f = document.createElement("iframe");
    f.src = iframeSrc(login, muted);
    f.allow = "autoplay; fullscreen";
    f.allowFullscreen = true;
    holder.appendChild(f);
    players.set(login, { kind: "iframe", f, holder, tile, login });
    if (!muted && opts.mainAudio) { state.audioLogin = login; tile.classList.add("has-audio"); }
  }

  /** Stage note with a START ALL button that pokes every paused player. */
  function noteWithPlayAll(html) {
    const p = el("p", "stage-note", html + ' <button class="btn-mini" type="button">▶ START ALL</button>');
    p.querySelector("button").addEventListener("click", () => {
      for (const entry of players.values()) tryPlay(entry);
    });
    return p;
  }

  function entryPaused(entry) {
    try { return entry.kind === "api" && entry.p.isPaused(); } catch (e) { return false; }
  }
  function tryPlay(entry) {
    try { if (entry && entry.kind === "api") entry.p.play(); } catch (e) {}
  }

  function setAudio(login) {
    state.audioLogin = login;
    for (const [l, entry] of players) {
      const on = l === login;
      if (entry.kind === "api") {
        try { entry.p.setMuted(!on); if (on) entry.p.setVolume(1); } catch (e) {}
      } else if (entry.kind === "iframe") {
        const want = `muted=${!on}`;
        if (!entry.f.src.includes(want)) {
          entry.f.src = `https://player.twitch.tv/?channel=${encodeURIComponent(l)}&parent=${encodeURIComponent(HOST)}&muted=${!on}&autoplay=true`;
        }
      }
      entry.tile.classList.toggle("has-audio", on);
    }
  }

  function iframeSrc(login, muted) {
    return `https://player.twitch.tv/?channel=${encodeURIComponent(login)}&parent=${encodeURIComponent(HOST)}&muted=${muted}&autoplay=true`;
  }

  /** Point an existing player at a different channel (no page reload). */
  function swapPlayerChannel(oldLogin, newLogin) {
    const entry = players.get(oldLogin);
    if (!entry) return false;
    players.delete(oldLogin);
    entry.login = newLogin;
    players.set(newLogin, entry);
    if (entry.kind === "api") {
      try { entry.p.setChannel(newLogin); } catch (e) { return false; }
    } else {
      entry.f.src = iframeSrc(newLogin, state.audioLogin !== oldLogin);
    }
    if (state.audioLogin === oldLogin) state.audioLogin = newLogin;
    return true;
  }


  // ---------- tiles ----------
  function viewersHTML(ch) {
    return ch.live
      ? `<span class="dot"></span>${state.apiOK ? fmtViewers(ch.viewers) : "LIVE"}`
      : `<span class="dot"></span>OFFLINE`;
  }

  /** Append an action button to a tile's label bar. */
  function barButton(tile, a) {
    const btn = el("button", "tb-btn" + (a.cls ? " " + a.cls : ""), a.label);
    btn.type = "button";
    if (a.title) btn.title = a.title;
    btn.addEventListener("click", (ev) => { ev.stopPropagation(); a.onClick(tile, btn); });
    tile.querySelector(".tile-bar").appendChild(btn);
    return btn;
  }

  /** Sound button: mounts/starts the stream if needed, then toggles audio. */
  const AUDIO_ACTION = {
    label: "🔊", cls: "audio", title: "Sound on/off",
    onClick: (tile) => {
      const login = tile.dataset.login;
      let entry = players.get(login);
      if (!entry && autoMountOpts.has(tile)) {
        tile.dataset.autoMount = "";
        const cfg = autoMountOpts.get(tile);
        tileMedia(tile).innerHTML = "";
        mountPlayer(tile, cfg.login, cfg.opts);
        entry = players.get(login);
      }
      if (entry && entryPaused(entry)) tryPlay(entry);
      setAudio(state.audioLogin === login ? null : login);
    },
  };

  /**
   * Tile = label bar (@handle left, viewers right, action buttons) ABOVE a
   * bare 16:9 media box. Nothing may overlay the video: Twitch's player
   * checks that it isn't occluded ("style visibility") and refuses to
   * autoplay if any element covers it — so all chrome lives in the bar.
   */
  function makeTile(ch, { actions = [] } = {}) {
    const tile = el("div", "tile" + (ch.live ? "" : " offline"));
    tile.dataset.login = ch.login;
    const bar = el("div", "tile-bar");
    bar.innerHTML =
      `<span class="chip handle">@${ch.login}</span>` +
      `<span class="tb-spacer"></span>` +
      `<span class="chip viewers" data-viewers="${ch.login}">${viewersHTML(ch)}</span>`;
    tile.appendChild(bar);
    tile.appendChild(el("div", "tile-media"));
    for (const a of actions) barButton(tile, a);
    tile.title = ch.title ? `${ch.displayName} — ${ch.title}` : ch.displayName;
    return tile;
  }

  function tileMedia(tile) { return tile.querySelector(".tile-media"); }

  function addPreview(tile, ch) {
    const media = tileMedia(tile);
    const img = el("img", "preview");
    img.loading = "lazy";
    img.alt = "";
    img.onerror = () => { img.style.visibility = "hidden"; };
    img.onload = () => { img.style.visibility = ""; };
    if (ch.live) {
      img.src = previewURL(ch.login);
      img.dataset.livePrev = ch.login;
    } else {
      media.appendChild(el("span", "badge-offline", "OFFLINE"));
    }
    media.insertBefore(img, media.firstChild);
  }

  // ---------- mode: THE WALL ----------
  function renderWall() {
    const live = liveSelected();
    const offline = sortChannels(selectedChannels().filter((c) => !c.live))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    // playing streams live in their own 16:9 row, sized past Twitch's
    // 400x300 autoplay minimum; previews keep the dense wall below
    const featured = el("div", "wall-featured");
    const grid = el("div", "wall-grid" + (live.length + offline.length > 40 ? " dense" : ""));
    stage.appendChild(featured); // attach first: players must mount into the live DOM
    stage.appendChild(grid);

    // promote a preview tile up into the featured row, where the player
    // is big enough for Twitch to allow it to start
    const promote = (tile, btn) => {
      const login = tile.dataset.login;
      if (players.has(login)) return;
      featured.appendChild(tile);
      gatedMount(tile, login, { muted: true, maxHeight: 480 });
      if (btn) btn.remove();
      barButton(tile, AUDIO_ACTION);
      tile.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };

    live.forEach((ch, i) => {
      const withVideo = i < state.videoCap;
      const tile = makeTile(ch, {
        actions: withVideo
          ? [AUDIO_ACTION]
          : [{ label: "▶", cls: "watch", title: "Start watching", onClick: (t, b) => promote(t, b) }],
      });
      (withVideo ? featured : grid).appendChild(tile);
      addPreview(tile, ch); // stays until the player mounts on-screen
      if (withVideo) {
        armAutoMount(tile, ch.login, { muted: true, maxHeight: 480 });
      } else {
        tileMedia(tile).addEventListener("click", () => promote(tile, tile.querySelector(".tb-btn")));
      }
    });

    offline.forEach((ch) => {
      const tile = makeTile(ch);
      addPreview(tile, ch);
      grid.appendChild(tile);
    });

    if (!live.length && !offline.length) {
      stage.appendChild(el("p", "stage-note", "Nobody selected — open the <b>ROSTER</b> and pick your streamers."));
    } else {
      stage.appendChild(noteWithPlayAll(
        `<b>${live.length}</b> live · top <b>${Math.min(state.videoCap, live.length)}</b> playing video, the rest are live previews · press <b>▶</b> on a preview to start it · press <b>🔊</b> on a tile for sound`));
    }
  }

  // ---------- pick strip (shared) ----------
  function renderPickStrip(onPick, isSelected) {
    const strip = el("div", "pick-strip");
    const chans = liveSelected();
    for (const ch of chans) {
      const chip = el("button", "pick-chip" + (isSelected(ch.login) ? " selected" : ""));
      chip.dataset.login = ch.login;
      chip.innerHTML = `<img src="${ch.avatar || ""}" alt="" onerror="this.style.visibility='hidden'">
        <span>@${ch.login}</span>
        <span class="pc-viewers">${state.apiOK ? fmtViewers(ch.viewers) : "LIVE"}</span>`;
      chip.addEventListener("click", () => onPick(ch.login));
      strip.appendChild(chip);
    }
    if (!chans.length) strip.appendChild(el("p", "stage-note", "No live channels in your selection right now."));
    return strip;
  }

  /**
   * Solve the lecture grid's column widths in px so the main column's
   * height EXACTLY equals the side stacks (the fixed ratios can't do
   * this — every small tile's label bar adds height, so the sides end
   * up taller and the main floats with space above/below). The main
   * must be n·s + (n-1)·(barH+gap)/(9/16) wide to match n stacked
   * side tiles of width s.
   */
  function layoutLecture(grid) {
    if (innerWidth <= 640) {
      grid.style.gridTemplateColumns = "";
      grid.style.width = "";
      grid.style.maxWidth = "";
      return;
    }
    const cfgMap = {
      "3c": { perCol: 3, sideCols: 1, chat: true, build: (s, m, c) => `${s}px ${m}px ${c}px` },
      "4":  { perCol: 2, sideCols: 2, build: (s, m) => `${s}px ${m}px ${s}px` },
      "6":  { perCol: 3, sideCols: 2, build: (s, m) => `${s}px ${m}px ${s}px` },
      "8":  { perCol: 4, sideCols: 2, build: (s, m) => `${s}px ${m}px ${s}px` },
      "12": { perCol: 3, sideCols: 4, build: (s, m) => `${s}px ${s}px ${m}px ${s}px ${s}px` },
    };
    const cfg = cfgMap[state.ringSize];
    if (!cfg) return;
    const fs = document.body.classList.contains("fs-mode");
    const gap = 8, R = 9 / 16;
    const W = stage.clientWidth - (fs ? 20 : 32);
    const H = innerHeight - (fs ? 84 : 200);
    const bar = grid.querySelector(".tile-bar");
    const barH = bar ? bar.offsetHeight : 29;
    const n = cfg.perCol;
    const K = ((n - 1) * (barH + gap)) / R; // extra main width that offsets the sides' bars+gaps
    const chatW = cfg.chat ? Math.max(260, Math.min(0.22 * W, 400)) : 0;
    const colCount = cfg.sideCols + 1 + (cfg.chat ? 1 : 0);
    const gapsTotal = (colCount - 1) * gap;
    let s = (W - chatW - gapsTotal - K) / (cfg.sideCols + n);
    let m = n * s + K;
    const mMax = (H - barH) / R; // don't exceed the viewport height
    if (m > mMax) { m = mMax; s = (m - K) / n; }
    if (s < 120) { s = 120; m = n * s + K; }
    const used = cfg.sideCols * s + m + chatW + gapsTotal;
    grid.style.maxWidth = "none";
    grid.style.width = Math.round(used) + "px";
    grid.style.gridTemplateColumns = cfg.build(Math.round(s), Math.round(m), Math.round(chatW));
  }

  // ---------- mode: LECTURE HALL ----------
  function renderLecture() {
    const live = liveSelected();
    if (!live.length) { stage.appendChild(el("p", "stage-note", "No live channels in your selection right now.")); return; }

    if (!state.focusLogin || !live.some((c) => c.login === state.focusLogin)) {
      state.focusLogin = live[0].login;
    }
    const withChat = state.ringSize === "3c";
    const ringCount = withChat ? 3 : +state.ringSize;
    const ring = live.filter((c) => c.login !== state.focusLogin).slice(0, ringCount);

    // ring flanks the main screen, everything on one viewport
    const AREAS = "abcdefghijkl";
    const grid = el("div", `lecture-grid ring-${state.ringSize}`);
    stage.appendChild(grid); // attach first: players must mount into the live DOM

    const focusCh = state.byLogin.get(state.focusLogin);
    const bigTile = makeTile(focusCh);
    bigTile.classList.add("main");
    grid.appendChild(bigTile);

    // "3 + chat": streams stack on the left, main center, chat column right
    let chatFrame = null;
    if (withChat) {
      const chatCol = el("div", "lecture-chat");
      chatFrame = document.createElement("iframe");
      chatFrame.src = `https://www.twitch.tv/embed/${encodeURIComponent(focusCh.login)}/chat?parent=${encodeURIComponent(HOST)}&darkpopout`;
      chatCol.appendChild(chatFrame);
      grid.appendChild(chatCol);
    }

    // Ring tiles carry real (zoom-fitted) players: the iframe's inner
    // window stays above Twitch's 400x300 autoplay minimum while
    // rendering small. Swapping exchanges channels — no reloads.
    const doSwap = (t) => {
      const oldBig = bigTile.dataset.login;
      const promote = t.dataset.login; // channel currently in this small tile
      if (promote === oldBig) return;
      const bigE = players.get(oldBig);
      const ringE = players.get(promote);
      players.delete(oldBig);
      players.delete(promote);
      if (bigE) {
        bigE.login = promote;
        if (bigE.kind === "api") { try { bigE.p.setChannel(promote); } catch (e) {} }
        else bigE.f.src = iframeSrc(promote, state.audioLogin !== oldBig);
        players.set(promote, bigE);
      } else if (autoMountOpts.has(bigTile)) {
        autoMountOpts.get(bigTile).login = promote; // not mounted yet
      }
      if (ringE) {
        ringE.login = oldBig;
        if (ringE.kind === "api") { try { ringE.p.setChannel(oldBig); } catch (e) {} }
        else ringE.f.src = iframeSrc(oldBig, true);
        players.set(oldBig, ringE);
      } else if (autoMountOpts.has(t)) {
        autoMountOpts.get(t).login = oldBig;
      }
      if (state.audioLogin === oldBig) state.audioLogin = promote; // sound stays on the big screen
      state.focusLogin = promote;
      if (chatFrame) chatFrame.src = `https://www.twitch.tv/embed/${encodeURIComponent(promote)}/chat?parent=${encodeURIComponent(HOST)}&darkpopout`;
      bigTile.dataset.login = promote;
      t.dataset.login = oldBig;
      refreshTileChips(bigTile, state.byLogin.get(promote));
      refreshTileChips(t, state.byLogin.get(oldBig));
      const img = t.querySelector(".preview");
      if (img) { img.dataset.livePrev = oldBig; img.src = previewURL(oldBig); }
      tryPlay(players.get(promote));
      tryPlay(players.get(oldBig));
      renderStrip();
      save();
    };

    ring.forEach((ch, i) => {
      const t = makeTile(ch, {
        actions: [{ label: "◉", cls: "swap", title: "Put on the main screen", onClick: (tt) => doSwap(tt) }],
      });
      t.style.gridArea = AREAS[i];
      grid.appendChild(t);
      addPreview(t, ch); // shows until its player mounts on-screen
      armAutoMount(t, ch.login, { muted: true, maxHeight: 360, zoomFit: true });
      tileMedia(t).addEventListener("click", () => doSwap(t));
    });

    requestAnimationFrame(() => layoutLecture(grid));

    let stripEl = null;
    const renderStrip = () => {
      const s = renderPickStrip(
        (login) => { state.focusLogin = login; renderStage(); },
        (login) => login === state.focusLogin
      );
      if (stripEl) stripEl.replaceWith(s); else stage.appendChild(s);
      stripEl = s;
    };

    // the player mounts once the tile is visible and layout has settled;
    // it starts WITH sound when the browser allows it (page already
    // interacted with), else muted until the first tap anywhere
    barButton(bigTile, { ...AUDIO_ACTION, label: "🔊 SOUND", cls: "audio gold" });
    armAutoMount(bigTile, focusCh.login, { muted: !pageActivated(), mainAudio: true });
    renderStrip();
    stage.appendChild(noteWithPlayAll(
      "Press <b>🔊 SOUND</b> on the big screen for audio. Click a side stream (or its <b>◉</b>) to put it on the main screen."));
  }

  function refreshTileChips(tile, ch) {
    if (!ch) return;
    tile.querySelector(".chip.handle").textContent = "@" + ch.login;
    const v = tile.querySelector(".chip.viewers");
    v.dataset.viewers = ch.login;
    v.innerHTML = ch.live
      ? `<span class="dot"></span>${state.apiOK ? fmtViewers(ch.viewers) : "LIVE"}`
      : `<span class="dot"></span>OFFLINE`;
    tile.title = ch.title ? `${ch.displayName} — ${ch.title}` : ch.displayName;
  }

  // ---------- mode: STUDY GROUP (quad) ----------
  function renderQuad() {
    const live = liveSelected();
    if (!live.length) { stage.appendChild(el("p", "stage-note", "No live channels in your selection right now.")); return; }

    state.quadLogins = state.quadLogins.filter((l) => live.some((c) => c.login === l));
    for (const c of live) {
      if (state.quadLogins.length >= 4) break;
      if (!state.quadLogins.includes(c.login)) state.quadLogins.push(c.login);
    }

    const grid = el("div", "quad-grid");
    stage.appendChild(grid); // attach first: players must mount into the live DOM
    state.quadLogins.forEach((login) => {
      const ch = state.byLogin.get(login);
      const t = makeTile(ch, { actions: [AUDIO_ACTION] });
      grid.appendChild(t);
      armAutoMount(t, login, { muted: true });
    });

    stage.appendChild(renderPickStrip(
      (login) => {
        const i = state.quadLogins.indexOf(login);
        if (i >= 0) state.quadLogins.splice(i, 1);
        else {
          if (state.quadLogins.length >= 4) state.quadLogins.shift();
          state.quadLogins.push(login);
        }
        renderStage(); save();
      },
      (login) => state.quadLogins.includes(login)
    ));
    stage.appendChild(el("p", "stage-note",
      "Pick up to <b>4</b> from the strip. Press <b>🔊</b> on a tile for its audio."));
  }

  // ---------- mode: MAIN STAGE (theater) ----------
  function renderTheater() {
    const live = liveSelected();
    if (!live.length) { stage.appendChild(el("p", "stage-note", "No live channels in your selection right now.")); return; }
    if (!state.theaterLogin || !live.some((c) => c.login === state.theaterLogin)) {
      state.theaterLogin = live[0].login;
    }
    const ch = state.byLogin.get(state.theaterLogin);

    const layout = el("div", "theater-layout");
    const t = makeTile(ch, { actions: [{ ...AUDIO_ACTION, label: "🔊 SOUND", cls: "audio gold" }] });
    layout.appendChild(t);

    const chatWrap = el("div", "theater-chat");
    const chat = document.createElement("iframe");
    chat.src = `https://www.twitch.tv/embed/${encodeURIComponent(ch.login)}/chat?parent=${encodeURIComponent(HOST)}&darkpopout`;
    chatWrap.appendChild(chat);
    layout.appendChild(chatWrap);
    stage.appendChild(layout);
    armAutoMount(t, ch.login, { muted: !pageActivated(), mainAudio: true });

    stage.appendChild(renderPickStrip(
      (login) => { state.theaterLogin = login; renderStage(); save(); },
      (login) => login === state.theaterLogin
    ));
  }

  // ---------- mode: CAMPUS TOUR ----------
  function renderTour() {
    const live = liveSelected();
    if (!live.length) { stage.appendChild(el("p", "stage-note", "No live channels in your selection right now.")); return; }

    tourIndex = Math.min(tourIndex, live.length - 1);
    tourPaused = false;
    let secondsLeft = state.tourSpeed;

    const wrap = el("div", "tour-wrap");
    const bar = el("div", "tour-bar");
    const info = el("span", "", "");
    const right = el("div", "");
    right.style.cssText = "display:flex;gap:8px;align-items:center;";
    const nextIn = el("span", "tour-next-in", "");
    const btnPrev = el("button", "", "◀ PREV");
    const btnPause = el("button", "", "PAUSE");
    const btnNext = el("button", "", "NEXT ▶");
    right.append(nextIn, btnPrev, btnPause, btnNext);
    bar.append(info, right);

    const ch0 = live[tourIndex];
    const tile = makeTile(ch0, { actions: [{ ...AUDIO_ACTION, label: "🔊 SOUND", cls: "audio gold" }] });

    wrap.append(bar, tile);
    stage.appendChild(wrap);
    armAutoMount(tile, ch0.login, { muted: !pageActivated(), mainAudio: true });
    stage.appendChild(el("p", "stage-note", "Touring every live channel in your selection, in order. Sit back."));

    const updateBar = () => {
      const list = liveSelected();
      const ch = list[tourIndex % Math.max(list.length, 1)];
      info.innerHTML = ch ? `NOW VISITING <b style="color:var(--parchment)">@${ch.login}</b> · ${tourIndex + 1}/${list.length}` : "";
      nextIn.textContent = tourPaused ? "PAUSED" : `NEXT IN ${secondsLeft}s`;
    };

    const goto = (dir) => {
      const list = liveSelected();
      if (!list.length) return;
      tourIndex = (tourIndex + dir + list.length) % list.length;
      const ch = list[tourIndex];
      const cur = players.keys().next().value;
      swapPlayerChannel(cur, ch.login);
      tile.dataset.login = ch.login;
      refreshTileChips(tile, ch);
      secondsLeft = state.tourSpeed;
      updateBar();
    };

    btnNext.addEventListener("click", () => goto(1));
    btnPrev.addEventListener("click", () => goto(-1));
    btnPause.addEventListener("click", () => {
      tourPaused = !tourPaused;
      btnPause.textContent = tourPaused ? "RESUME" : "PAUSE";
      updateBar();
    });

    updateBar();
    tourCountTimer = setInterval(() => {
      if (tourPaused) return;
      secondsLeft--;
      if (secondsLeft <= 0) goto(1);
      else updateBar();
    }, 1000);
  }

  // ---------- stage router ----------
  function renderStage() {
    clearInterval(tourCountTimer);
    clearTimeout(tourTimer);
    destroyPlayers();
    state.audioLogin = null;
    stage.innerHTML = "";
    state.randomSeed = state.sort === "random" ? state.randomSeed : Math.random();

    $("liveVideoCtl").hidden = state.mode !== "wall";
    $("ringSizeCtl").hidden = state.mode !== "lecture";
    $("tourSpeedCtl").hidden = state.mode !== "shuffle";

    try {
      ({
        wall: renderWall,
        lecture: renderLecture,
        quad: renderQuad,
        theater: renderTheater,
        shuffle: renderTour,
      }[state.mode] || renderWall)();
    } catch (e) {
      // never leave the stage blank — whatever happens, say so
      console.error("renderStage failed", e);
      stage.appendChild(el("p", "stage-note",
        "Something went wrong rendering this view — try another mode or refresh. (" + (e && e.message || e) + ")"));
    }
  }

  // ---------- live data ----------
  async function refreshData(first = false) {
    const roster = activeRoster();
    try {
      const map = await TwitchAPI.fetchChannels(roster.map((r) => r.login));
      state.apiOK = true;
      $("apiNotice").hidden = true;
      state.channels = roster.map((r) => {
        const d = map.get(r.login);
        return d
          ? { ...d, name: r.name, role: r.role, alum: r.alum }
          : { login: r.login, name: r.name, displayName: r.name, avatar: "", live: false, viewers: 0, game: "", title: "", role: r.role, alum: r.alum };
      });
    } catch (e) {
      console.warn("Twitch data fetch failed", e);
      state.apiOK = false;
      $("apiNotice").hidden = false;
      if (!state.channels.length || state.channels.length !== roster.length) {
        state.channels = roster.map((r) => ({
          login: r.login, name: r.name, displayName: r.name,
          avatar: "", live: true, viewers: 0, game: "", title: "", role: r.role, alum: r.alum,
        }));
      }
    }
    state.byLogin = new Map(state.channels.map((c) => [c.login, c]));

    // header stats (whole roster, not just selection)
    const liveAll = state.channels.filter((c) => c.live);
    $("statLive").textContent = state.apiOK ? `${liveAll.length}/${state.channels.length}` : "?";
    $("statViewers").textContent = state.apiOK ? fmtViewers(liveAll.reduce((s, c) => s + (c.viewers || 0), 0)) : "?";
    $("fsLive").textContent = $("statLive").textContent;
    $("fsViewers").textContent = $("statViewers").textContent;
    if (state.apiOK) {
      const top5 = liveAll.slice().sort((a, b) => (b.viewers || 0) - (a.viewers || 0)).slice(0, 5);
      $("fsTicker").innerHTML = '<span class="ft-label">TOP OF THE CLASS</span>' +
        top5.map((c, i) => `<span class="ft-item"><b>#${i + 1}</b> @${c.login} <i>${fmtViewers(c.viewers)}</i></span>`).join("");
    }

    if (first) return;

    // in-place chip updates so streams never reload on refresh
    document.querySelectorAll(".chip.viewers[data-viewers]").forEach((elv) => {
      const ch = state.byLogin.get(elv.dataset.viewers);
      if (!ch) return;
      elv.innerHTML = ch.live
        ? `<span class="dot"></span>${state.apiOK ? fmtViewers(ch.viewers) : "LIVE"}`
        : `<span class="dot"></span>OFFLINE`;
      const tile = elv.closest(".tile");
      if (tile) tile.classList.toggle("offline", !ch.live);
    });
    document.querySelectorAll(".pick-chip[data-login] .pc-viewers").forEach((pv) => {
      const ch = state.byLogin.get(pv.closest(".pick-chip").dataset.login);
      if (ch && ch.live) pv.textContent = state.apiOK ? fmtViewers(ch.viewers) : "LIVE";
    });
    if (!$("rosterDrawer").hidden) updateRosterLive();
    sweepArmed();
  }

  /** Refresh the live/viewer column of the roster drawer without
      rebuilding the rows (rebuilding under the cursor eats clicks). */
  function updateRosterLive() {
    document.querySelectorAll(".roster-row[data-login]").forEach((row) => {
      const ch = state.byLogin.get(row.dataset.login);
      if (!ch) return;
      const liveEl = row.querySelector(".rr-live");
      liveEl.classList.toggle("off", !ch.live);
      liveEl.textContent = ch.live ? "● " + (state.apiOK ? fmtViewers(ch.viewers) : "LIVE") : "offline";
    });
  }

  // Twitch pauses muted players in background tabs (bandwidth saving —
  // not preventable). Resume everything that had been playing as soon
  // as the tab is visible again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    setTimeout(() => {
      for (const entry of players.values()) {
        if (entry.kind === "api" && entry.everPlayed && entryPaused(entry)) tryPlay(entry);
      }
    }, 400);
  });

  // ---------- preview auto-refresh (the control-room effect) ----------
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    document.querySelectorAll("img[data-live-prev]").forEach((img, i) => {
      // stagger so 100 images don't refetch in the same frame
      setTimeout(() => {
        if (img.isConnected) img.src = previewURL(img.dataset.livePrev);
      }, (i % 20) * 150);
    });
  }, 20000);

  // ---------- roster drawer ----------
  function renderRosterList(filter = "") {
    const list = $("rosterList");
    const f = filter.trim().toLowerCase();
    const chans = state.channels.slice().sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return (b.viewers || 0) - (a.viewers || 0) || a.displayName.localeCompare(b.displayName);
    });
    list.innerHTML = "";
    for (const ch of chans) {
      if (f && !ch.login.includes(f) && !ch.displayName.toLowerCase().includes(f)) continue;
      const tag = ch.role ? `<span class="rr-role">${ch.role}</span>` : ch.alum ? `<span class="rr-role alum">Class of '25</span>` : "";
      const row = el("label", "roster-row");
      row.dataset.login = ch.login;
      row.innerHTML = `
        <input type="checkbox" ${state.selected.has(ch.login) ? "checked" : ""}>
        <img src="${ch.avatar || ""}" alt="" onerror="this.style.visibility='hidden'">
        <span><span class="rr-name">${ch.displayName}</span>${tag}<br><span class="rr-login">@${ch.login}</span></span>
        <span class="rr-live ${ch.live ? "" : "off"}">${ch.live ? "● " + (state.apiOK ? fmtViewers(ch.viewers) : "LIVE") : "offline"}</span>`;
      row.querySelector("input").addEventListener("change", (e) => {
        if (e.target.checked) state.selected.add(ch.login);
        else state.selected.delete(ch.login);
        onSelectionChanged();
      });
      list.appendChild(row);
    }
  }

  let selDebounce = null;
  function onSelectionChanged() {
    updateRosterCount();
    save();
    clearTimeout(selDebounce);
    selDebounce = setTimeout(renderStage, 600); // batch rapid checkbox clicks
  }

  function updateRosterCount() {
    $("rosterCount").textContent = `${state.selected.size}/${state.channels.length}`;
  }

  // ---------- clips ----------
  function renderClips() {
    const grid = $("clipsGrid");
    grid.innerHTML = "";
    if (!allClips.length) {
      grid.appendChild(el("p", "clips-empty", "No clips found this week — check back after class."));
      return;
    }
    const batch = allClips.slice(0, clipsShown);
    for (const c of batch) {
      const card = el("article", "clip-card");
      card.innerHTML = `
        <div class="clip-thumb">
          <img src="${c.thumb}" alt="" loading="lazy">
          <span class="chip handle">@${c.login}</span>
          <span class="chip viewers">▶ ${fmtViewers(c.views)}</span>
          <span class="clip-dur">${fmtDuration(c.duration)}</span>
          <span class="clip-play">▶</span>
        </div>
        <div class="clip-meta">
          <div class="clip-title"></div>
          <div class="clip-sub">${c.channel}${c.game ? " · " + c.game : ""}</div>
        </div>`;
      card.querySelector(".clip-title").textContent = c.title;
      card.addEventListener("click", () => openFeed(c));
      grid.appendChild(card);
    }
    $("clipsMoreBtn").hidden = clipsShown >= allClips.length;
    $("feedOpenBtn").hidden = !allClips.length;
  }

  // ---------- clip feed (TikTok-style vertical scroll) ----------
  let feedObserver = null;
  let feedMountSeq = 0;

  function clipIframe(slug) {
    const f = document.createElement("iframe");
    f.src = `https://clips.twitch.tv/embed?clip=${encodeURIComponent(slug)}&parent=${encodeURIComponent(HOST)}&autoplay=true&muted=false`;
    f.allow = "autoplay; fullscreen";
    f.allowFullscreen = true;
    return f;
  }

  /**
   * Feed clips play through a native <video> on the clip's actual MP4 —
   * the embed's player keeps its own muted-start policy we can't reach,
   * but our own element starts WITH sound (the feed was opened by a
   * click, so the page has user activation) and loops TikTok-style.
   * Falls back to the embed if the video URL can't be resolved.
   */
  async function mountClip(player) {
    const slug = player.dataset.slug;
    try {
      const url = await TwitchAPI.fetchClipVideo(slug);
      if (!player.isConnected || player.firstChild) return;
      const v = document.createElement("video");
      v.src = url;
      v.playsInline = true;
      v.loop = true;
      v.controls = true;
      v.autoplay = true;
      v.muted = false;
      player.appendChild(v);
      v.play().catch((err) => {
        // only fall back to muted when the browser blocked audible play —
        // muting won't fix a decode error
        if (err && err.name === "NotAllowedError") { v.muted = true; v.play().catch(() => {}); }
      });
    } catch (e) {
      console.warn("clip video fallback to embed for", slug, e);
      if (player.isConnected && !player.firstChild) player.appendChild(clipIframe(slug));
    }
  }

  function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  let feedPrevAudio = null;

  /** Opens the feed in a fresh random order — every scroll is a surprise
      (no repeats). Opening from a clip card plays that clip first. */
  function openFeed(startClip = null) {
    if (!allClips.length) return;
    const feed = $("clipFeed");
    if (!feed.hidden) return; // already open (e.g. Enter re-firing the button)
    if (feedObserver) { feedObserver.disconnect(); feedObserver = null; }
    // clips play with sound — silence any soloed live stream behind the feed
    feedPrevAudio = state.audioLogin;
    if (feedPrevAudio) setAudio(null);
    const scroll = $("feedScroll");
    scroll.innerHTML = "";

    let feedClips = shuffleArray(allClips);
    if (startClip) {
      feedClips = [startClip, ...feedClips.filter((c) => c !== startClip)];
    }

    feedClips.forEach((c, i) => {
      const ch = state.byLogin.get(c.login);
      const item = el("section", "feed-item");
      item.dataset.idx = i;
      // meta sits BELOW the player — overlaying it would block the clip's
      // autoplay (Twitch occlusion check), same rule as the stream tiles
      item.innerHTML = `
        <div class="feed-stage">
          <div class="feed-player" data-slug="${c.slug}"></div>
          <div class="feed-meta">
            <span class="feed-handle">@${c.login}${ch && ch.live ? ' <span class="feed-live">● LIVE</span>' : ""}</span>
            <p class="feed-title"></p>
            <p class="feed-sub">▶ ${fmtViewers(c.views)} views${c.game ? " · " + c.game : ""}</p>
          </div>
        </div>`;
      item.querySelector(".feed-title").textContent = c.title;
      scroll.appendChild(item);
    });

    feed.hidden = false;
    document.body.style.overflow = "hidden";
    $("feedCounter").textContent = `1 / ${feedClips.length}`;

    // Only the clip on screen has a live iframe. Mounting happens after
    // the snap animation settles — the clip player (like the stream
    // player) refuses autoplay when loaded mid-scroll — and everything
    // else unmounts, so exactly one clip plays and is audible at a time.
    feedObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const item = en.target;
        const player = item.querySelector(".feed-player");
        if (en.intersectionRatio <= 0.15) {
          if (player.firstChild) player.innerHTML = ""; // scrolled away: stop it
          continue;
        }
        if (en.intersectionRatio < 0.6) continue;
        $("feedCounter").textContent = `${+item.dataset.idx + 1} / ${feedClips.length}`;
        const seq = ++feedMountSeq;
        (async () => {
          await scrollIdle();
          if (seq !== feedMountSeq || !item.isConnected) return; // superseded
          const r = item.getBoundingClientRect();
          const rr = scroll.getBoundingClientRect();
          const shown = Math.min(r.bottom, rr.bottom) - Math.max(r.top, rr.top);
          if (shown / r.height < 0.6) return; // no longer the current snap
          scroll.querySelectorAll(".feed-player").forEach((p) => {
            if (p !== player && p.firstChild) p.innerHTML = "";
          });
          if (!player.firstChild) mountClip(player);
        })();
      }
    }, { root: scroll, threshold: [0.15, 0.6] });

    // observe only after the overlay has actually painted — evaluating
    // the first clip mid-appearance fails the same visibility check
    const obs = feedObserver;
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
      if (obs !== feedObserver) return; // feed was closed/reopened
      scroll.querySelectorAll(".feed-item").forEach((it) => obs.observe(it));
    }, 250)));

    scroll.scrollTop = 0;
  }

  function closeFeed() {
    const feed = $("clipFeed");
    if (feed.hidden) return;
    feed.hidden = true;
    if (feedObserver) { feedObserver.disconnect(); feedObserver = null; }
    $("feedScroll").innerHTML = "";
    document.body.style.overflow = "";
    // give the audio back to whichever stream had it before the feed
    if (feedPrevAudio && players.has(feedPrevAudio)) setAudio(feedPrevAudio);
    feedPrevAudio = null;
  }

  function feedStep(dir) {
    const scroll = $("feedScroll");
    scroll.scrollBy({ top: dir * scroll.clientHeight, behavior: "smooth" });
  }

  async function loadClips() {
    const cacheKey = "su_clips_v3_" + (state.includeAlumni ? "all" : "26");
    try {
      const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
      if (cached && Date.now() - cached.t < 15 * 60 * 1000 && cached.clips.length) {
        allClips = cached.clips;
      } else {
        $("clipsGrid").innerHTML = '<p class="clips-loading">Grading submissions…</p>';
        allClips = await TwitchAPI.fetchTopClips(activeRoster().map((r) => r.login), 5);
        try { sessionStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), clips: allClips.slice(0, 400) })); } catch (e) {}
      }
      // keep it varied: max 3 clips per channel in the visible list
      const perChan = new Map();
      allClips = allClips.filter((c) => {
        const n = (perChan.get(c.login) || 0) + 1;
        perChan.set(c.login, n);
        return n <= 3;
      });
      clipsShown = 18;
      renderClips();
    } catch (e) {
      console.warn("clips failed", e);
      $("clipsGrid").innerHTML = "";
      $("clipsGrid").appendChild(el("p", "clips-empty", "Couldn’t load clips right now."));
    }
  }

  // ---------- wire up controls ----------
  function bindUI() {
    document.querySelectorAll(".mode-tab").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll(".mode-tab").forEach((x) => x.classList.toggle("active", x === b));
        state.mode = b.dataset.mode;
        save();
        renderStage();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });

    $("sortSelect").addEventListener("change", (e) => {
      state.sort = e.target.value;
      state.randomSeed = Math.random();
      save(); renderStage();
    });
    $("videoCapSelect").addEventListener("change", (e) => { state.videoCap = +e.target.value; save(); renderStage(); });
    $("ringSizeSelect").addEventListener("change", (e) => { state.ringSize = e.target.value; save(); renderStage(); });
    $("tourSpeedSelect").addEventListener("change", (e) => { state.tourSpeed = +e.target.value; save(); renderStage(); });

    // roster drawer
    const openDrawer = () => { $("rosterDrawer").hidden = false; $("drawerOverlay").hidden = false; renderRosterList($("rosterSearch").value); };
    const closeDrawer = () => { $("rosterDrawer").hidden = true; $("drawerOverlay").hidden = true; };
    $("rosterBtn").addEventListener("click", openDrawer);
    $("drawerClose").addEventListener("click", closeDrawer);
    $("drawerOverlay").addEventListener("click", closeDrawer);
    $("rosterSearch").addEventListener("input", (e) => renderRosterList(e.target.value));
    $("rosterAll").addEventListener("click", () => { state.channels.forEach((c) => state.selected.add(c.login)); renderRosterList($("rosterSearch").value); onSelectionChanged(); });
    $("rosterNone").addEventListener("click", () => { state.selected.clear(); renderRosterList($("rosterSearch").value); onSelectionChanged(); });
    $("rosterLive").addEventListener("click", () => {
      state.selected = new Set(state.channels.filter((c) => c.live).map((c) => c.login));
      renderRosterList($("rosterSearch").value); onSelectionChanged();
    });
    $("alumniToggle").addEventListener("change", async (e) => {
      state.includeAlumni = e.target.checked;
      const before = new Set(state.channels.map((c) => c.login));
      await refreshData(true);
      if (state.includeAlumni) {
        for (const c of state.channels) if (!before.has(c.login)) state.selected.add(c.login);
      } else {
        const now = new Set(state.channels.map((c) => c.login));
        state.selected = new Set([...state.selected].filter((l) => now.has(l)));
      }
      renderRosterList($("rosterSearch").value);
      onSelectionChanged();
      loadClips();
    });

    // fullscreen mode: just the streams under a scoreboard banner
    const relayout = () => {
      const g = document.querySelector(".lecture-grid");
      if (g) layoutLecture(g);
    };
    const setFsMode = (on) => {
      document.body.classList.toggle("fs-mode", on);
      requestAnimationFrame(relayout);
    };
    let resizeT = null;
    addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(relayout, 120); });
    $("fsBtn").addEventListener("click", () => {
      const root = document.documentElement;
      if (root.requestFullscreen) {
        if (!document.fullscreenElement) {
          root.requestFullscreen().then(() => setFsMode(true)).catch(() => setFsMode(true));
        } else {
          document.exitFullscreen();
        }
      } else {
        setFsMode(!document.body.classList.contains("fs-mode")); // no FS API (iPhone): layout-only TV mode
      }
    });
    $("fsExit").addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else setFsMode(false);
    });
    document.addEventListener("fullscreenchange", () => setFsMode(!!document.fullscreenElement));

    // clips + feed
    $("clipsMoreBtn").addEventListener("click", () => { clipsShown += 18; renderClips(); });
    $("feedOpenBtn").addEventListener("click", () => openFeed());
    $("feedClose").addEventListener("click", closeFeed);
    $("feedUp").addEventListener("click", () => feedStep(-1));
    $("feedDown").addEventListener("click", () => feedStep(1));

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeFeed(); closeDrawer(); }
      if (!$("clipFeed").hidden) {
        if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); feedStep(1); }
        if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); feedStep(-1); }
      }
    });
  }

  /* Inline the crest SVGs so the blackletter webfont applies to the S/U
     (fonts never load inside <img>-embedded SVGs). */
  async function inlineCrests() {
    try {
      const svg = await (await fetch("assets/crest.svg")).text();
      document.querySelectorAll('img[src$="crest.svg"]').forEach((img) => {
        const span = document.createElement("span");
        span.innerHTML = svg;
        const s = span.querySelector("svg");
        if (!s) return;
        if (img.className) s.setAttribute("class", img.className);
        s.removeAttribute("width");
        s.removeAttribute("height");
        img.replaceWith(s);
      });
    } catch (e) { /* keep the <img> fallback */ }
  }

  // ---------- boot ----------
  async function boot() {
    if (IS_FILE) $("fileNotice").hidden = false;

    const savedSelected = load();

    // reflect saved prefs in the controls
    $("sortSelect").value = state.sort;
    $("videoCapSelect").value = String(state.videoCap);
    $("ringSizeSelect").value = String(state.ringSize);
    $("tourSpeedSelect").value = String(state.tourSpeed);
    $("alumniToggle").checked = state.includeAlumni;
    document.querySelectorAll(".mode-tab").forEach((x) => x.classList.toggle("active", x.dataset.mode === state.mode));

    bindUI();

    // Cold visits can't start with sound (browser rule) — so the first
    // tap anywhere turns on the current main screen's audio, once.
    const autoSoundOnFirstTap = () => {
      setTimeout(() => {
        if (!$("clipFeed").hidden) return; // feed has its own audio
        if (state.audioLogin) {
          document.removeEventListener("pointerdown", autoSoundOnFirstTap, true);
          return;
        }
        const mainTile = document.querySelector(".lecture-grid .tile.main, .theater-layout .tile, .tour-wrap .tile");
        const login = mainTile && mainTile.dataset.login;
        if (login && players.has(login)) {
          setAudio(login);
          document.removeEventListener("pointerdown", autoSoundOnFirstTap, true);
        }
      }, 700); // after the tap's own handlers (mode switches, mounts) run
    };
    document.addEventListener("pointerdown", autoSoundOnFirstTap, true);

    // wait for fonts + crest so the first layout is stable — Twitch's
    // player refuses autoplay if the page shifts during its checks
    const fontsReady = document.fonts && document.fonts.ready
      ? Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2500))])
      : Promise.resolve();
    await Promise.all([loadEmbedScript(), refreshData(true), fontsReady, inlineCrests()]);

    if (Array.isArray(savedSelected)) {
      state.selected = new Set(savedSelected.filter((l) => state.byLogin.has(l)));
      if (!state.selected.size) state.selected = new Set(state.channels.map((c) => c.login));
    } else {
      state.selected = new Set(state.channels.map((c) => c.login));
    }
    updateRosterCount();

    $("loading") && $("loading").remove();
    renderStage();
    loadClips();

    setInterval(refreshData, 5000);
  }

  // debugging hook (harmless): lets the console inspect live player state
  window.__SU_DEBUG__ = { players, state };

  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", boot)
    : boot();
})();
