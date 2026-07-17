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
    mode: "wall",
    sort: "viewers",
    videoCap: 9,             // wall: how many tiles get real video
    ringSize: 6,             // lecture: small tiles around the big one
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
      }));
    } catch (e) { /* private mode etc. */ }
  }

  function load() {
    try {
      const p = JSON.parse(localStorage.getItem("su_prefs") || "{}");
      if (p.mode) state.mode = p.mode;
      if (p.sort) state.sort = p.sort;
      if (p.videoCap != null) state.videoCap = +p.videoCap;
      if (p.ringSize) state.ringSize = +p.ringSize;
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
  function mountPlayer(tile, login, { muted = true, maxHeight = 0 } = {}) {
    const holder = el("div");
    holder.id = "twp-" + (++playerSeq);
    holder.style.cssText = "position:absolute;inset:0;";
    tile.appendChild(holder);

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
        // When autoplay is blocked (iOS, Low Power Mode, strict browsers)
        // the only thing that reliably starts playback is a tap on the
        // player's own play button — so the click-shield stands down until
        // the stream is actually playing, then arms for audio/swap taps.
        const shield = tile.querySelector(".click-shield");
        if (shield) {
          const arm = (on) => { shield.style.pointerEvents = on ? "" : "none"; };
          arm(false);
          p.addEventListener(Twitch.Player.PLAYING, () => arm(true));
          p.addEventListener(Twitch.Player.PAUSE, () => arm(false));
          if (Twitch.Player.ENDED) p.addEventListener(Twitch.Player.ENDED, () => arm(false));
        }
        tile.classList.add("has-video");
        if (maxHeight) {
          let done = false;
          p.addEventListener(Twitch.Player.PLAYING, () => {
            if (done) return; done = true;
            setTimeout(() => capQuality(p, maxHeight), 800);
          });
        }
        players.set(login, { kind: "api", p, tile, login });
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
    // no player API in iframe mode, so the shield can't know the play
    // state — leave it down so the native play button always works
    const shield = tile.querySelector(".click-shield");
    if (shield) shield.style.pointerEvents = "none";
    tile.classList.add("has-video");
    players.set(login, { kind: "iframe", f, holder, tile, login });
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

  /**
   * Exchange the channels of two mounted players. Audio stays with the
   * physical tile (the big lecture screen keeps the sound), so no mute
   * toggling is needed — just two setChannel calls.
   */
  function swapTwoPlayers(loginA, loginB) {
    const a = players.get(loginA), b = players.get(loginB);
    if (!a || !b) return false;
    const aMuted = state.audioLogin !== loginA;
    const bMuted = state.audioLogin !== loginB;
    players.set(loginA, b);
    players.set(loginB, a);
    a.login = loginB; b.login = loginA;
    if (a.kind === "api") { try { a.p.setChannel(loginB); } catch (e) {} }
    else a.f.src = iframeSrc(loginB, aMuted);
    if (b.kind === "api") { try { b.p.setChannel(loginA); } catch (e) {} }
    else b.f.src = iframeSrc(loginA, bMuted);
    if (state.audioLogin === loginA) state.audioLogin = loginB;
    else if (state.audioLogin === loginB) state.audioLogin = loginA;
    return true;
  }

  // ---------- tiles ----------
  function chipHTML(ch) {
    const v = ch.live
      ? `<span class="dot"></span>${state.apiOK ? fmtViewers(ch.viewers) : "LIVE"}`
      : `<span class="dot"></span>OFFLINE`;
    return `<span class="chip handle">@${ch.login}</span><span class="chip viewers" data-viewers="${ch.login}">${v}</span>`;
  }

  function makeTile(ch, { hint = "", shield = false } = {}) {
    const tile = el("div", "tile" + (ch.live ? "" : " offline"));
    tile.dataset.login = ch.login;
    tile.innerHTML = chipHTML(ch);
    if (hint) tile.appendChild(el("span", "hint", hint));
    // player iframes swallow clicks — small tiles get a transparent shield
    // above the player so click-to-sound / click-to-swap keeps working
    if (shield) tile.appendChild(el("div", "click-shield"));
    tile.title = ch.title ? `${ch.displayName} — ${ch.title}` : ch.displayName;
    return tile;
  }

  function addPreview(tile, ch) {
    const img = el("img", "preview");
    img.loading = "lazy";
    img.alt = "";
    img.onerror = () => { img.style.visibility = "hidden"; };
    img.onload = () => { img.style.visibility = ""; };
    if (ch.live) {
      img.src = previewURL(ch.login);
      img.dataset.livePrev = ch.login;
    } else {
      tile.appendChild(el("span", "badge-offline", "OFFLINE"));
    }
    tile.insertBefore(img, tile.firstChild);
  }

  // ---------- mode: THE WALL ----------
  function renderWall() {
    const live = liveSelected();
    const offline = sortChannels(selectedChannels().filter((c) => !c.live))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    const grid = el("div", "wall-grid" + (live.length + offline.length > 40 ? " dense" : ""));
    stage.appendChild(grid); // attach first: players must mount into the live DOM

    live.forEach((ch, i) => {
      const withVideo = i < state.videoCap;
      const tile = makeTile(ch, { hint: withVideo ? "CLICK · SOUND" : "CLICK · PLAY", shield: true });
      grid.appendChild(tile);
      if (withVideo) {
        mountPlayer(tile, ch.login, { muted: true, maxHeight: 480 });
      } else {
        addPreview(tile, ch);
      }
      tile.addEventListener("click", () => {
        const entry = players.get(ch.login);
        if (entry) {
          if (entryPaused(entry)) { tryPlay(entry); return; } // resume beats audio toggle
          setAudio(state.audioLogin === ch.login ? null : ch.login);
        } else {
          tile.querySelectorAll(".preview, .badge-offline").forEach((n) => n.remove());
          mountPlayer(tile, ch.login, { muted: true, maxHeight: 480 });
          tile.querySelector(".hint").textContent = "CLICK · SOUND";
        }
      });
    });

    offline.forEach((ch) => {
      const tile = makeTile(ch);
      addPreview(tile, ch);
      grid.appendChild(tile);
    });

    if (!live.length && !offline.length) {
      stage.appendChild(el("p", "stage-note", "Nobody selected — open the <b>ROSTER</b> and pick your streamers."));
    } else {
      stage.appendChild(el("p", "stage-note",
        `<b>${live.length}</b> live · top <b>${Math.min(state.videoCap, live.length)}</b> playing video, the rest are live previews (click any to start video · click a playing tile for sound)`));
    }
  }

  // ---------- pick strip (shared) ----------
  function renderPickStrip(onPick, isSelected) {
    const strip = el("div", "pick-strip");
    const chans = liveSelected();
    for (const ch of chans) {
      const chip = el("button", "pick-chip" + (isSelected(ch.login) ? " selected" : ""));
      chip.innerHTML = `<img src="${ch.avatar || ""}" alt="" onerror="this.style.visibility='hidden'">
        <span>@${ch.login}</span>
        <span class="pc-viewers">${state.apiOK ? fmtViewers(ch.viewers) : "LIVE"}</span>`;
      chip.addEventListener("click", () => onPick(ch.login));
      strip.appendChild(chip);
    }
    if (!chans.length) strip.appendChild(el("p", "stage-note", "No live channels in your selection right now."));
    return strip;
  }

  // ---------- mode: LECTURE HALL ----------
  function renderLecture() {
    const live = liveSelected();
    if (!live.length) { stage.appendChild(el("p", "stage-note", "No live channels in your selection right now.")); return; }

    if (!state.focusLogin || !live.some((c) => c.login === state.focusLogin)) {
      state.focusLogin = live[0].login;
    }
    const ring = live.filter((c) => c.login !== state.focusLogin).slice(0, state.ringSize);

    const layout = el("div", "lecture-layout");
    const mainWrap = el("div", "lecture-main");
    const focusCh = state.byLogin.get(state.focusLogin);
    const bigTile = makeTile(focusCh);
    bigTile.classList.add("has-audio");
    mainWrap.appendChild(bigTile);

    const ringWrap = el("div", "lecture-ring" + (state.ringSize > 6 ? " cols-2" : ""));
    const ringTiles = [];
    for (const ch of ring) {
      const t = makeTile(ch, { hint: "CLICK · SWAP TO MAIN", shield: true });
      ringWrap.appendChild(t);
      ringTiles.push([t, ch]);
      t.addEventListener("click", () => {
        const oldBig = bigTile.dataset.login;
        const promote = t.dataset.login; // channel currently in this small tile
        if (promote === oldBig) return;
        if (!swapTwoPlayers(oldBig, promote)) return;
        tryPlay(players.get(oldBig));
        tryPlay(players.get(promote));
        state.focusLogin = promote;
        t.dataset.login = oldBig;
        bigTile.dataset.login = promote;
        refreshTileChips(t, state.byLogin.get(oldBig));
        refreshTileChips(bigTile, state.byLogin.get(promote));
        renderStrip();
        save();
      });
    }

    layout.appendChild(mainWrap);
    layout.appendChild(ringWrap);

    let stripEl = null;
    const renderStrip = () => {
      const s = renderPickStrip(
        (login) => { state.focusLogin = login; renderStage(); },
        (login) => login === state.focusLogin
      );
      if (stripEl) stripEl.replaceWith(s); else stage.appendChild(s);
      stripEl = s;
    };

    stage.appendChild(layout);
    // players mount only after the layout is in the document
    mountPlayer(bigTile, focusCh.login, { muted: false });
    state.audioLogin = focusCh.login;
    for (const [t, ch] of ringTiles) mountPlayer(t, ch.login, { muted: true, maxHeight: 480 });
    renderStrip();
    stage.appendChild(el("p", "stage-note",
      "Big screen carries the <b>audio</b>. Click a small tile to swap it into the main slot, or pick from the strip below."));
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
    state.quadLogins.forEach((login, i) => {
      const ch = state.byLogin.get(login);
      const t = makeTile(ch, { hint: "CLICK · SOUND", shield: true });
      grid.appendChild(t);
      mountPlayer(t, login, { muted: i !== 0 });
      if (i === 0) { t.classList.add("has-audio"); state.audioLogin = login; }
      t.addEventListener("click", () => {
        const entry = players.get(login);
        if (entry && entryPaused(entry)) { tryPlay(entry); return; }
        setAudio(state.audioLogin === login ? null : login);
      });
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
      "Pick up to <b>4</b> from the strip. Click a tile to move the <b>audio</b>."));
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
    const t = makeTile(ch);
    t.classList.add("has-audio");
    layout.appendChild(t);

    const chatWrap = el("div", "theater-chat");
    const chat = document.createElement("iframe");
    chat.src = `https://www.twitch.tv/embed/${encodeURIComponent(ch.login)}/chat?parent=${encodeURIComponent(HOST)}&darkpopout`;
    chatWrap.appendChild(chat);
    layout.appendChild(chatWrap);
    stage.appendChild(layout);
    mountPlayer(t, ch.login, { muted: false });
    state.audioLogin = ch.login;

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
    const tile = makeTile(ch0);
    tile.classList.add("has-audio");

    wrap.append(bar, tile);
    stage.appendChild(wrap);
    mountPlayer(tile, ch0.login, { muted: false });
    state.audioLogin = ch0.login;
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
    renderRosterList($("rosterSearch").value);
  }

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
      card.addEventListener("click", () => openFeed(allClips.indexOf(c)));
      grid.appendChild(card);
    }
    $("clipsMoreBtn").hidden = clipsShown >= allClips.length;
    $("feedOpenBtn").hidden = !allClips.length;
  }

  // ---------- clip feed (TikTok-style vertical scroll) ----------
  let feedObserver = null;

  function clipIframe(slug) {
    const f = document.createElement("iframe");
    f.src = `https://clips.twitch.tv/embed?clip=${encodeURIComponent(slug)}&parent=${encodeURIComponent(HOST)}&autoplay=true`;
    f.allow = "autoplay; fullscreen";
    f.allowFullscreen = true;
    return f;
  }

  function openFeed(startIdx = 0) {
    if (!allClips.length) return;
    const feed = $("clipFeed");
    const scroll = $("feedScroll");
    scroll.innerHTML = "";

    allClips.forEach((c, i) => {
      const ch = state.byLogin.get(c.login);
      const item = el("section", "feed-item");
      item.dataset.idx = i;
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

    // Only the clip on screen has a live iframe: it mounts (autoplaying)
    // when its item snaps into view and unmounts once fully scrolled away,
    // so exactly one clip plays — and is audible — at a time.
    feedObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.intersectionRatio < 0.6) continue;
        const player = en.target.querySelector(".feed-player");
        $("feedCounter").textContent = `${+en.target.dataset.idx + 1} / ${allClips.length}`;
        // exactly one live clip at a time: kill every other player first
        scroll.querySelectorAll(".feed-player").forEach((p) => {
          if (p !== player && p.firstChild) p.innerHTML = "";
        });
        if (!player.querySelector("iframe")) player.appendChild(clipIframe(player.dataset.slug));
      }
    }, { root: scroll, threshold: 0.6 });
    scroll.querySelectorAll(".feed-item").forEach((it) => feedObserver.observe(it));

    requestAnimationFrame(() => { scroll.scrollTop = startIdx * scroll.clientHeight; });
  }

  function closeFeed() {
    const feed = $("clipFeed");
    if (feed.hidden) return;
    feed.hidden = true;
    if (feedObserver) { feedObserver.disconnect(); feedObserver = null; }
    $("feedScroll").innerHTML = "";
    document.body.style.overflow = "";
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
    $("ringSizeSelect").addEventListener("change", (e) => { state.ringSize = +e.target.value; save(); renderStage(); });
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

    // clips + feed
    $("clipsMoreBtn").addEventListener("click", () => { clipsShown += 18; renderClips(); });
    $("feedOpenBtn").addEventListener("click", () => openFeed(0));
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
    inlineCrests();

    const savedSelected = load();

    // reflect saved prefs in the controls
    $("sortSelect").value = state.sort;
    $("videoCapSelect").value = String(state.videoCap);
    $("ringSizeSelect").value = String(state.ringSize);
    $("tourSpeedSelect").value = String(state.tourSpeed);
    $("alumniToggle").checked = state.includeAlumni;
    document.querySelectorAll(".mode-tab").forEach((x) => x.classList.toggle("active", x.dataset.mode === state.mode));

    bindUI();

    await Promise.all([loadEmbedScript(), refreshData(true)]);

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

    setInterval(refreshData, 60000);
  }

  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", boot)
    : boot();
})();
