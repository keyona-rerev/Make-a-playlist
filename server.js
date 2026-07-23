const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

/* ---------------------------------------------------------------- database */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("proxy.rlwy.net")
    ? { rejectUnauthorized: false }
    : false,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS playlists (
  id              BIGSERIAL PRIMARY KEY,
  slug            TEXT UNIQUE NOT NULL,
  edit_token_hash TEXT NOT NULL,
  title           TEXT NOT NULL,
  intro           TEXT NOT NULL DEFAULT '',
  creator_name    TEXT NOT NULL DEFAULT '',
  view_count      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  id               BIGSERIAL PRIMARY KEY,
  playlist_id      BIGINT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  title            TEXT NOT NULL,
  artist           TEXT NOT NULL DEFAULT '',
  youtube_id       TEXT NOT NULL,
  artist_name      TEXT NOT NULL DEFAULT '',
  artist_context   TEXT NOT NULL DEFAULT '',
  commentary       TEXT NOT NULL DEFAULT '',
  contributor_name TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tracks_playlist ON playlist_tracks (playlist_id, position);

ALTER TABLE playlists ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT '';
`;

// Templates a playlist can be rendered with. Anything not listed falls back
// to the default liner-notes page.
const THEMES = { birthday: "play-birthday.html" };

async function migrate() {
  await pool.query(SCHEMA);
  console.log("schema ready");
}

/* ------------------------------------------------------------------ limits */

const MAX_TRACKS = 40;
const MAX_COMMENTARY = 2000;
const MAX_SHORT = 200;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/* ------------------------------------------------------------------ tokens */

const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

function randomId(len) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

function tokenMatches(supplied, storedHash) {
  if (!supplied) return false;
  const a = Buffer.from(hashToken(supplied));
  const b = Buffer.from(storedHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* -------------------------------------------------------------- rate limit */

const hits = new Map();

function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip;
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      return res.status(429).json({ error: "Too many playlists too fast. Try again in a bit." });
    }
    recent.push(now);
    hits.set(ip, recent);
    next();
  };
}

setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [ip, times] of hits) {
    const keep = times.filter((t) => t > cutoff);
    if (keep.length) hits.set(ip, keep);
    else hits.delete(ip);
  }
}, 600000).unref();

/* ------------------------------------------------------------------ helpers */

const clean = (v, max) => String(v ?? "").trim().slice(0, max);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function loadPlaylist(slug) {
  const { rows } = await pool.query("SELECT * FROM playlists WHERE slug = $1", [slug]);
  if (!rows[0]) return null;
  const playlist = rows[0];
  const tracks = await pool.query(
    "SELECT * FROM playlist_tracks WHERE playlist_id = $1 ORDER BY position ASC, id ASC",
    [playlist.id]
  );
  return { playlist, tracks: tracks.rows };
}

function publicShape(playlist, tracks) {
  return {
    slug: playlist.slug,
    title: playlist.title,
    intro: playlist.intro,
    creatorName: playlist.creator_name,
    theme: playlist.theme || "",
    viewCount: playlist.view_count,
    tracks: tracks.map((t) => ({
      id: t.id,
      position: t.position,
      title: t.title,
      artist: t.artist,
      youtubeId: t.youtube_id,
      artistName: t.artist_name,
      artistContext: t.artist_context,
      commentary: t.commentary,
      contributorName: t.contributor_name,
    })),
  };
}

// Loads the playlist and verifies the edit key from the X-Edit-Key header.
async function requireEditKey(req, res) {
  const found = await loadPlaylist(req.params.slug);
  if (!found) {
    res.status(404).json({ error: "No playlist with that link." });
    return null;
  }
  if (!tokenMatches(req.get("X-Edit-Key"), found.playlist.edit_token_hash)) {
    res.status(403).json({ error: "That edit key is not valid for this playlist." });
    return null;
  }
  return found;
}

app.use(express.json({ limit: "256kb" }));
app.set("trust proxy", 1);

/* --------------------------------------------------------------------- api */

app.get("/healthz", (req, res) => res.json({ ok: true }));

// Proxied because YouTube's oEmbed endpoint sends no CORS headers,
// so the browser cannot call it directly.
app.get("/api/oembed", async (req, res) => {
  const id = clean(req.query.videoId, 20);
  if (!YT_ID.test(id)) return res.status(400).json({ error: "That is not a YouTube video ID." });
  try {
    const r = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`
    );
    if (!r.ok) return res.status(404).json({ error: "YouTube does not have a video at that link." });
    const data = await r.json();
    res.json({ title: data.title, author: data.author_name, thumbnail: data.thumbnail_url });
  } catch {
    res.status(502).json({ error: "Could not reach YouTube. Try again." });
  }
});

app.post("/api/playlists", rateLimit(5, 3600000), async (req, res) => {
  const title = clean(req.body.title, MAX_SHORT);
  if (!title) return res.status(400).json({ error: "Give the playlist a title." });

  const slug = randomId(8);
  const editToken = randomId(32);

  const { rows } = await pool.query(
    `INSERT INTO playlists (slug, edit_token_hash, title, intro, creator_name, theme)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      slug,
      hashToken(editToken),
      title,
      clean(req.body.intro, MAX_COMMENTARY),
      clean(req.body.creatorName, MAX_SHORT),
      THEMES[req.body.theme] ? req.body.theme : "",
    ]
  );

  res.status(201).json({ slug: rows[0].slug, editKey: editToken });
});

app.get("/api/playlists/:slug", async (req, res) => {
  const found = await loadPlaylist(req.params.slug);
  if (!found) return res.status(404).json({ error: "No playlist with that link." });
  pool
    .query("UPDATE playlists SET view_count = view_count + 1 WHERE id = $1", [found.playlist.id])
    .catch(() => {});
  res.json(publicShape(found.playlist, found.tracks));
});

app.patch("/api/playlists/:slug", async (req, res) => {
  const found = await requireEditKey(req, res);
  if (!found) return;
  const p = found.playlist;
  const { rows } = await pool.query(
    `UPDATE playlists SET title = $1, intro = $2, creator_name = $3, theme = $4, updated_at = now()
     WHERE id = $5 RETURNING *`,
    [
      req.body.title !== undefined ? clean(req.body.title, MAX_SHORT) || p.title : p.title,
      req.body.intro !== undefined ? clean(req.body.intro, MAX_COMMENTARY) : p.intro,
      req.body.creatorName !== undefined ? clean(req.body.creatorName, MAX_SHORT) : p.creator_name,
      req.body.theme !== undefined ? (THEMES[req.body.theme] ? req.body.theme : "") : p.theme,
      p.id,
    ]
  );
  res.json(publicShape(rows[0], found.tracks));
});

app.post("/api/playlists/:slug/tracks", async (req, res) => {
  const found = await requireEditKey(req, res);
  if (!found) return;

  if (found.tracks.length >= MAX_TRACKS) {
    return res.status(400).json({ error: `A playlist holds ${MAX_TRACKS} tracks. This one is full.` });
  }

  const youtubeId = clean(req.body.youtubeId, 20);
  if (!YT_ID.test(youtubeId)) {
    return res.status(400).json({ error: "That YouTube link did not resolve to a video." });
  }
  const title = clean(req.body.title, MAX_SHORT);
  if (!title) return res.status(400).json({ error: "The track needs a title." });

  const nextPosition = found.tracks.length
    ? Math.max(...found.tracks.map((t) => t.position)) + 1
    : 1;

  const { rows } = await pool.query(
    `INSERT INTO playlist_tracks
       (playlist_id, position, title, artist, youtube_id, artist_name, artist_context, commentary, contributor_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      found.playlist.id,
      nextPosition,
      title,
      clean(req.body.artist, MAX_SHORT),
      youtubeId,
      clean(req.body.artistName, MAX_SHORT),
      clean(req.body.artistContext, MAX_COMMENTARY),
      clean(req.body.commentary, MAX_COMMENTARY),
      clean(req.body.contributorName, MAX_SHORT),
    ]
  );

  await pool.query("UPDATE playlists SET updated_at = now() WHERE id = $1", [found.playlist.id]);
  res.status(201).json(rows[0]);
});

app.patch("/api/playlists/:slug/tracks/:id", async (req, res) => {
  const found = await requireEditKey(req, res);
  if (!found) return;
  const track = found.tracks.find((t) => String(t.id) === req.params.id);
  if (!track) return res.status(404).json({ error: "That track is not in this playlist." });

  const { rows } = await pool.query(
    `UPDATE playlist_tracks
       SET title = $1, artist = $2, artist_name = $3, artist_context = $4, commentary = $5, position = $6
     WHERE id = $7 RETURNING *`,
    [
      req.body.title !== undefined ? clean(req.body.title, MAX_SHORT) || track.title : track.title,
      req.body.artist !== undefined ? clean(req.body.artist, MAX_SHORT) : track.artist,
      req.body.artistName !== undefined ? clean(req.body.artistName, MAX_SHORT) : track.artist_name,
      req.body.artistContext !== undefined ? clean(req.body.artistContext, MAX_COMMENTARY) : track.artist_context,
      req.body.commentary !== undefined ? clean(req.body.commentary, MAX_COMMENTARY) : track.commentary,
      Number.isInteger(req.body.position) ? req.body.position : track.position,
      track.id,
    ]
  );
  res.json(rows[0]);
});

app.delete("/api/playlists/:slug/tracks/:id", async (req, res) => {
  const found = await requireEditKey(req, res);
  if (!found) return;
  await pool.query("DELETE FROM playlist_tracks WHERE id = $1 AND playlist_id = $2", [
    req.params.id,
    found.playlist.id,
  ]);
  res.status(204).end();
});

/* ------------------------------------------------------------------- pages */

// Injects real OG tags so the link unfurls with the playlist title and cover
// in a group chat. Crawlers do not run JavaScript, so this has to happen here.
app.get("/p/:slug", async (req, res, next) => {
  try {
    const found = await loadPlaylist(req.params.slug);
    if (!found) return next();

    const { playlist, tracks } = found;
    const by = playlist.creator_name ? ` by ${playlist.creator_name}` : "";
    const description =
      playlist.intro ||
      `${tracks.length} ${tracks.length === 1 ? "song" : "songs"}, each with a note on why it is here.`;
    const cover = tracks.length
      ? `https://i.ytimg.com/vi/${tracks[0].youtube_id}/hqdefault.jpg`
      : "";

    const template = THEMES[playlist.theme] || "play.html";

    const html = fs
      .readFileSync(path.join(PUBLIC_DIR, template), "utf8")
      .replace(
        "<!--OG-->",
        [
          `<title>${escapeHtml(playlist.title)}${escapeHtml(by)}</title>`,
          `<meta property="og:title" content="${escapeHtml(playlist.title + by)}">`,
          `<meta property="og:description" content="${escapeHtml(description)}">`,
          `<meta property="og:type" content="music.playlist">`,
          cover ? `<meta property="og:image" content="${escapeHtml(cover)}">` : "",
          `<meta name="twitter:card" content="summary_large_image">`,
          `<meta name="description" content="${escapeHtml(description)}">`,
        ].join("\n    ")
      );

    res.type("html").send(html);
  } catch (err) {
    next(err);
  }
});

app.get("/e/:slug", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "edit.html")));

app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something broke on our end." });
});

migrate()
  .then(() => app.listen(PORT, () => console.log(`listening on ${PORT}`)))
  .catch((err) => {
    console.error("migration failed", err);
    process.exit(1);
  });
