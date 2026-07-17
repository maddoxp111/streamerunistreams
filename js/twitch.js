/* ============================================================
   Twitch data layer.
   Uses Twitch's public web GraphQL endpoint with the public
   web client-id — the same way twitch.tv's own site (and every
   multi-stream viewer) fetches live status, viewer counts and
   clips from the browser. No secrets involved.
   ============================================================ */

const TwitchAPI = (() => {
  const GQL_URL = "https://gql.twitch.tv/gql";
  const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"; // Twitch's public web client-id

  async function gql(body) {
    const res = await fetch(GQL_URL, {
      method: "POST",
      headers: { "Client-ID": CLIENT_ID, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("GQL HTTP " + res.status);
    return res.json();
  }

  function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  /**
   * Fetch live status / viewer counts / avatars for a list of logins.
   * Returns Map<login, {id, login, displayName, avatar, live, viewers, game, title}>
   */
  async function fetchChannels(logins) {
    const QUERY = `query($logins:[String!]!){
      users(logins:$logins){
        id login displayName profileImageURL(width:70)
        broadcastSettings{ title }
        stream{ id viewersCount game{ displayName } }
      }
    }`;
    const batches = chunk(logins, 50);
    const results = await Promise.all(
      batches.map((b) => gql({ query: QUERY, variables: { logins: b } }))
    );
    const map = new Map();
    for (const r of results) {
      for (const u of (r.data && r.data.users) || []) {
        if (!u) continue;
        map.set(u.login.toLowerCase(), {
          id: u.id,
          login: u.login.toLowerCase(),
          displayName: u.displayName || u.login,
          avatar: u.profileImageURL || "",
          live: !!u.stream,
          viewers: u.stream ? u.stream.viewersCount || 0 : 0,
          game: u.stream && u.stream.game ? u.stream.game.displayName : "",
          title: (u.broadcastSettings && u.broadcastSettings.title) || "",
        });
      }
    }
    return map;
  }

  /**
   * Fetch top clips of the past week for many channels.
   * Sends batched GQL requests (one aliased query per channel, 15 channels
   * per HTTP request). Returns a flat array of clip objects.
   */
  async function fetchTopClips(logins, perChannel = 5) {
    const one = (login) => ({
      query: `query($login:String!,$n:Int!){
        user(login:$login){
          login displayName
          clips(first:$n, criteria:{period:LAST_WEEK, sort:VIEWS_DESC}){
            edges{ node{
              id slug title viewCount durationSeconds createdAt
              thumbnailURL(width:480,height:272)
              game{ displayName }
            }}
          }
        }
      }`,
      variables: { login, n: perChannel },
    });

    const clips = [];
    const batches = chunk(logins, 15);
    for (const batch of batches) {
      try {
        const res = await gql(batch.map(one));
        const arr = Array.isArray(res) ? res : [res];
        for (const r of arr) {
          const u = r && r.data && r.data.user;
          if (!u || !u.clips) continue;
          for (const e of u.clips.edges || []) {
            const c = e && e.node;
            if (!c || !c.slug) continue;
            clips.push({
              slug: c.slug,
              title: c.title || "Untitled clip",
              views: c.viewCount || 0,
              duration: c.durationSeconds || 0,
              createdAt: c.createdAt,
              thumb: c.thumbnailURL || "",
              game: c.game ? c.game.displayName : "",
              login: u.login.toLowerCase(),
              channel: u.displayName || u.login,
            });
          }
        }
      } catch (e) {
        // one bad batch shouldn't kill the whole clips section
        console.warn("clips batch failed", e);
      }
    }
    clips.sort((a, b) => b.views - a.views);
    return clips;
  }

  return { fetchChannels, fetchTopClips };
})();
