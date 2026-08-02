const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
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

CREATE TABLE IF NOT EXISTS users (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url   TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per login rather than one token column per user, so signing in on
-- your phone does not silently kill the session on your laptop.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

ALTER TABLE playlists ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE playlist_tracks ADD COLUMN IF NOT EXISTS contributor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_playlists_owner ON playlists (owner_id);
CREATE INDEX IF NOT EXISTS idx_tracks_contributor ON playlist_tracks (contributor_user_id);

-- Public by default: the homepage's Browse all is the discovery surface,
-- so every playlist is listed there unless this is later flipped to false.
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_playlists_public ON playlists (is_public, updated_at DESC);

-- Accounts are email and password. The point of an account here is having one
-- place that lists your playlists, not protecting anything sensitive — so
-- there is no external identity provider to configure and nothing to set up
-- before sign-in works.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users DROP COLUMN IF EXISTS google_sub;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));

-- Extra edit keys, so inviting a contributor never depends on still having
-- the original link lying around. Only a hash of that one is kept, which
-- meant an owner who signed in on a new device — or simply claimed their
-- playlist — had no way to invite anyone without replacing the link they
-- had already sent out. Each invite is its own token and can stand alongside
-- the others.
CREATE TABLE IF NOT EXISTS playlist_invites (
  id          BIGSERIAL PRIMARY KEY,
  playlist_id BIGINT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invites_playlist ON playlist_invites (playlist_id);
`;

const SESSION_DAYS = 30;

// Templates a playlist can be rendered with. Anything not listed falls back
// to the default liner-notes page.
const THEMES = { birthday: "play-birthday.html" };

// Every ALTER here takes an ACCESS EXCLUSIVE lock, and a zero-downtime deploy
// leaves the previous container connected and using these same tables while
// the new one boots. With no bound on the wait, the new container blocks on
// that lock forever and never starts listening — no error, no log, just a
// deploy that hangs. So the lock wait is bounded and the whole thing retried:
// the contention clears on its own once the old container is torn down.
const MIGRATE_ATTEMPTS = 12;

async function migrate() {
  for (let attempt = 1; attempt <= MIGRATE_ATTEMPTS; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("SET lock_timeout = '5s'");
      await client.query(SCHEMA);
      console.log("schema ready");
      return;
    } catch (err) {
      if (err.code !== "55P03" || attempt === MIGRATE_ATTEMPTS) throw err;
      console.log(`schema locked by the previous instance, retrying (${attempt}/${MIGRATE_ATTEMPTS})`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } finally {
      client.release();
    }
  }
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

// Counted per route as well as per address. Sharing one counter across every
// limited route meant mistyping a password a few times used up the budget for
// creating a playlist, which is not a connection anyone would expect.
function rateLimit(bucket, max, windowMs, message) {
  return (req, res, next) => {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip;
    const cacheKey = bucket + "|" + ip;
    const now = Date.now();
    const recent = (hits.get(cacheKey) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      return res.status(429).json({ error: message || "Too many requests too fast. Try again in a bit." });
    }
    recent.push(now);
    hits.set(cacheKey, recent);
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

/* ------------------------------------------------------------------ cookies */
// Parsed by hand so the dependency list stays at express and pg.

function cookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function setCookie(res, name, value, maxAgeSeconds) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (maxAgeSeconds !== null) parts.push(`Max-Age=${maxAgeSeconds}`);
  if (process.env.NODE_ENV !== "development") parts.push("Secure");
  const prev = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", prev ? [].concat(prev, parts.join("; ")) : parts.join("; "));
}

const clearCookie = (res, name) => setCookie(res, name, "", 0);

/* ---------------------------------------------------------------- passwords */
// scrypt from Node's own crypto, so the dependency list stays at express and
// pg. Nothing here is sensitive, but people reuse passwords across sites, so
// what gets stored is a salted hash rather than the password itself.

const scrypt = promisify(crypto.scrypt);
const SCRYPT_KEYLEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

async function passwordMatches(password, stored) {
  if (!stored) return false;
  const [scheme, salt, hex] = String(stored).split("$");
  if (scheme !== "scrypt" || !salt || !hex) return false;
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hex, "hex");
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

const MIN_PASSWORD = 8;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Never includes password_hash. Everything that hands a user back to the
// browser goes through here so that stays true.
const shapeUser = (u) => ({
  id: u.id,
  name: u.display_name,
  email: u.email,
  avatar: u.avatar_url || "",
});

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
  // Carried on the playlist so checking a key stays synchronous everywhere.
  const invites = await pool.query(
    "SELECT token_hash FROM playlist_invites WHERE playlist_id = $1",
    [playlist.id]
  );
  playlist.invite_hashes = invites.rows.map((r) => r.token_hash);
  const tracks = await pool.query(
    "SELECT * FROM playlist_tracks WHERE playlist_id = $1 ORDER BY position ASC, id ASC",
    [playlist.id]
  );
  return { playlist, tracks: tracks.rows };
}

// The `req` argument is what the caller is holding — an edit key header, a
// session, or neither. Folding it in here means the edit page learns what it
// is allowed to do from the same read that fetches the playlist, instead of
// probing with a write.
function publicShape(playlist, tracks, req) {
  const isOwner = req ? ownsIt(req, playlist) : false;
  const operator = req ? isOperator(req) : false;
  const hasKey = req ? holdsEditKey(req, playlist) : false;
  const canEdit = isOwner || operator || hasKey;
  return {
    slug: playlist.slug,
    title: playlist.title,
    intro: playlist.intro,
    creatorName: playlist.creator_name,
    theme: playlist.theme || "",
    isPublic: playlist.is_public !== false,
    hasOwner: Boolean(playlist.owner_id),
    viewCount: playlist.view_count,
    canEdit,
    isOwner,
    // Administrative actions belong to the owner once there is one. Until
    // then the edit key is the only credential in existence, so it carries them.
    canAdminister: playlist.owner_id ? isOwner || operator : hasKey || operator,
    isOperator: operator,
    reportEmail: process.env.REPORT_EMAIL || "",
    claimable: Boolean(!playlist.owner_id && hasKey),
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
      verified: Boolean(t.contributor_user_id),
      canModify: canEdit && canModifyTrack(req, playlist, t),
      mine: Boolean(
        req && req.user && t.contributor_user_id &&
          String(t.contributor_user_id) === String(req.user.id)
      ),
    })),
  };
}

/* ---------------------------------------------------------------- sessions */

async function newSession(userId) {
  const token = randomId(40);
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [hashToken(token), userId, String(SESSION_DAYS)]
  );
  return token;
}

async function loadSession(req) {
  const token = cookies(req).sid;
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.*, s.token_hash FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  if (!rows[0]) return null;

  // Sliding expiry, so an active person is never logged out mid-use.
  pool
    .query(
      `UPDATE sessions SET expires_at = now() + ($2 || ' days')::interval WHERE token_hash = $1`,
      [rows[0].token_hash, String(SESSION_DAYS)]
    )
    .catch(() => {});

  return rows[0];
}

app.use(express.json({ limit: "256kb" }));
app.set("trust proxy", 1);

app.use(async (req, res, next) => {
  try { req.user = await loadSession(req); } catch { req.user = null; }
  next();
});

// What comes back from the API depends on the edit key header and the session
// cookie, neither of which the browser cache keys on. Without this a reply
// built for one viewer gets replayed for another — a guest kept seeing the
// owner's view, and a revoked link kept working until a hard reload.
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

/* ----------------------------------------------------------- authorization */
// Two ways in. Accounts are additive rather than a gate, so a link already
// sent out keeps working until its owner deliberately replaces it.

const holdsEditKey = (req, playlist) => {
  const supplied = req.get("X-Edit-Key");
  if (!supplied) return false;
  if (tokenMatches(supplied, playlist.edit_token_hash)) return true;
  return (playlist.invite_hashes || []).some((hash) => tokenMatches(supplied, hash));
};

const ownsIt = (req, playlist) =>
  Boolean(req.user && playlist.owner_id && String(playlist.owner_id) === String(req.user.id));

// Anyone can publish to the public feed without an account, so somebody has to
// be able to take something down. Operators act on any playlist through the
// ordinary edit page rather than a separate admin surface.
const OPERATORS = new Set(
  (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

const isOperator = (req) =>
  Boolean(req.user && OPERATORS.has(String(req.user.email || "").toLowerCase()));

// Kept separate from ownsIt so "this is yours" stays literally true in the UI
// and an operator is shown as what they actually are.
const canAct = (req, playlist) => ownsIt(req, playlist) || isOperator(req);

async function requireEditKey(req, res) {
  const found = await loadPlaylist(req.params.slug);
  if (!found) {
    res.status(404).json({ error: "No playlist with that link." });
    return null;
  }
  if (!holdsEditKey(req, found.playlist) && !canAct(req, found.playlist)) {
    res.status(403).json({ error: "You need the edit link for this playlist, or to be signed in as its owner." });
    return null;
  }
  return found;
}

// Adding a song is open to anyone holding the edit link — that is the whole
// point of handing it out. Changing or removing one that is already there is
// not, once a playlist has an owner, or a single forwarded link would be
// enough to quietly erase someone else's work.
function canModifyTrack(req, playlist, track) {
  if (!playlist.owner_id) return true;
  if (canAct(req, playlist)) return true;
  return Boolean(
    req.user &&
      track.contributor_user_id &&
      String(track.contributor_user_id) === String(req.user.id)
  );
}

// Renaming, hiding and deleting are the owner's, not every guest holding the
// edit link. Ownerless playlists have nobody else to ask, so the key stands in.
async function requireAdmin(req, res) {
  const found = await requireEditKey(req, res);
  if (!found) return null;
  const p = found.playlist;
  if (p.owner_id && !canAct(req, p)) {
    res.status(403).json({
      error: "Only the person who owns this playlist can change or delete it. You can still add songs.",
    });
    return null;
  }
  return found;
}

/* --------------------------------------------------------------------- api */

app.get("/healthz", (req, res) => res.json({ ok: true, signIn: true }));

/* ------------------------------------------------------------ auth routes */

app.get("/api/me", (req, res) => {
  // Always available now: accounts are email and password, so there is no
  // provider to configure and nothing that can leave sign-in switched off.
  res.json({
    signInAvailable: true,
    user: req.user ? shapeUser(req.user) : null,
  });
});

// Signing up is the same shape as signing in, because the difference is not
// interesting to the person doing it: give an email and a password, get an
// account. Both hand back a session cookie and the user, so the page that
// called them can carry straight on.
app.post("/api/auth/signup", rateLimit("signup", 10, 3600000, "Too many accounts from here. Try again later."), async (req, res, next) => {
  const email = clean(req.body.email, MAX_SHORT).toLowerCase();
  const password = String(req.body.password ?? "");
  const name = clean(req.body.name, MAX_SHORT);

  if (!EMAIL_SHAPE.test(email)) return res.status(400).json({ error: "That does not look like an email address." });
  if (password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Use at least ${MIN_PASSWORD} characters for the password.` });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, display_name, password_hash)
       VALUES ($1, $2, $3) RETURNING *`,
      [email, name || email.split("@")[0], await hashPassword(password)]
    );

    setCookie(res, "sid", await newSession(rows[0].id), SESSION_DAYS * 24 * 3600);
    res.status(201).json({ user: shapeUser(rows[0]) });
  } catch (err) {
    // The unique index on lower(email) is what decides this, rather than a
    // read first, so two simultaneous signups cannot both think they won.
    if (err.code === "23505") {
      return res.status(409).json({ error: "There is already an account with that email. Sign in instead." });
    }
    next(err);
  }
});

app.post("/api/auth/signin", rateLimit("signin", 20, 900000, "Too many sign-in attempts. Wait a few minutes and try again."), async (req, res, next) => {
  const email = clean(req.body.email, MAX_SHORT).toLowerCase();
  const password = String(req.body.password ?? "");

  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE lower(email) = $1", [email]);
    // One message for both a missing account and a wrong password, so this
    // cannot be used to find out which emails have accounts.
    const wrong = { error: "That email and password do not match an account." };
    if (!rows[0] || !(await passwordMatches(password, rows[0].password_hash))) {
      return res.status(401).json(wrong);
    }

    setCookie(res, "sid", await newSession(rows[0].id), SESSION_DAYS * 24 * 3600);
    res.json({ user: shapeUser(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.post("/auth/signout", async (req, res) => {
  const token = cookies(req).sid;
  if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
  clearCookie(res, "sid");
  res.json({ ok: true });
});

/* ------------------------------------------------------ owned playlists */

app.get("/api/my/playlists", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Sign in to see your playlists." });

  const { rows } = await pool.query(
    `SELECT p.*,
            (SELECT count(*) FROM playlist_tracks t WHERE t.playlist_id = p.id) AS track_count,
            (SELECT youtube_id FROM playlist_tracks t
              WHERE t.playlist_id = p.id ORDER BY t.position ASC, t.id ASC LIMIT 1) AS cover_youtube_id,
            (p.owner_id = $1) AS is_owner
       FROM playlists p
      WHERE p.owner_id = $1
         OR EXISTS (SELECT 1 FROM playlist_tracks t
                     WHERE t.playlist_id = p.id AND t.contributor_user_id = $1)
      ORDER BY p.updated_at DESC`,
    [req.user.id]
  );

  res.json({
    playlists: rows.map((p) => ({
      slug: p.slug,
      title: p.title,
      creatorName: p.creator_name,
      theme: p.theme || "",
      trackCount: Number(p.track_count),
      viewCount: p.view_count,
      isPublic: p.is_public !== false,
      coverYoutubeId: p.cover_youtube_id || null,
      isOwner: p.is_owner,
      updatedAt: p.updated_at,
    })),
  });
});

// Signing in and opening an edit link once turns an ownerless playlist into
// yours. First claim wins, so a link you hand out cannot take it from you.
app.post("/api/playlists/:slug/claim", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Sign in first." });

  const found = await loadPlaylist(req.params.slug);
  if (!found) return res.status(404).json({ error: "No playlist with that link." });

  const p = found.playlist;
  if (p.owner_id) {
    return res.json({ claimed: ownsIt(req, p), alreadyOwned: true, mine: ownsIt(req, p) });
  }
  if (!holdsEditKey(req, p)) {
    return res.status(403).json({ error: "You need this playlist's edit link to claim it." });
  }

  await pool.query("UPDATE playlists SET owner_id = $1 WHERE id = $2 AND owner_id IS NULL", [req.user.id, p.id]);
  res.json({ claimed: true, alreadyOwned: false, mine: true });
});

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

// Browse-all: the discovery surface. Playlists are public by default but can
// be unlisted, and one with no songs in it is not worth a row, so both are
// filtered out here. Cover art comes from the first track's YouTube thumbnail.
const BROWSE_SORTS = {
  recent: "p.updated_at DESC",
  new: "p.created_at DESC",
  popular: "p.view_count DESC, p.updated_at DESC",
  songs: "track_count DESC, p.updated_at DESC",
  title: "lower(p.title) ASC",
};

app.get("/api/playlists", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const order = BROWSE_SORTS[req.query.sort] || BROWSE_SORTS.recent;
  const q = clean(req.query.q, 80);

  // A playlist with no songs in it is not something anyone can listen to, and
  // every playlist starts that way — so the feed would otherwise fill with
  // empty rows the moment people start creating them.
  const includeEmpty = req.query.includeEmpty === "1";

  // One extra row is fetched purely to answer "is there another page", which
  // avoids a second count query on every browse.
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT p.*,
              (SELECT count(*) FROM playlist_tracks t WHERE t.playlist_id = p.id) AS track_count,
              (SELECT youtube_id FROM playlist_tracks t
                WHERE t.playlist_id = p.id ORDER BY t.position ASC, t.id ASC LIMIT 1) AS cover_youtube_id
         FROM playlists p
        WHERE p.is_public = true
          AND ($3::text = '' OR p.title ILIKE '%' || $3::text || '%'
                             OR p.creator_name ILIKE '%' || $3::text || '%')
     ) p
     WHERE ($4::boolean OR track_count > 0)
     ORDER BY ${order}
     LIMIT $1 OFFSET $2`,
    [limit + 1, offset, q, includeEmpty]
  );

  const page = rows.slice(0, limit);

  res.json({
    hasMore: rows.length > limit,
    playlists: page.map((p) => ({
      slug: p.slug,
      title: p.title,
      creatorName: p.creator_name,
      theme: p.theme || "",
      trackCount: Number(p.track_count),
      viewCount: p.view_count,
      coverYoutubeId: p.cover_youtube_id || null,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    })),
  });
});

app.post("/api/playlists", rateLimit("create", 5, 3600000, "Too many playlists too fast. Try again in a bit."), async (req, res) => {
  const title = clean(req.body.title, MAX_SHORT);
  if (!title) return res.status(400).json({ error: "Give the playlist a title." });

  const slug = randomId(8);
  const editToken = randomId(32);

  const { rows } = await pool.query(
    `INSERT INTO playlists (slug, edit_token_hash, title, intro, creator_name, theme, owner_id, is_public)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      slug,
      hashToken(editToken),
      title,
      clean(req.body.intro, MAX_COMMENTARY),
      clean(req.body.creatorName, MAX_SHORT),
      THEMES[req.body.theme] ? req.body.theme : "",
      req.user ? req.user.id : null,
      req.body.isPublic === undefined ? true : Boolean(req.body.isPublic),
    ]
  );

  res.status(201).json({ slug: rows[0].slug, editKey: editToken });
});

app.get("/api/playlists/:slug", async (req, res) => {
  const found = await loadPlaylist(req.params.slug);
  if (!found) return res.status(404).json({ error: "No playlist with that link." });

  // Only an actual listen counts. The edit page and the dashboard read this
  // same endpoint, and counting those made the number meaningless.
  if (req.query.count === "1") {
    pool
      .query("UPDATE playlists SET view_count = view_count + 1 WHERE id = $1", [found.playlist.id])
      .catch(() => {});
  }
  res.json(publicShape(found.playlist, found.tracks, req));
});

app.patch("/api/playlists/:slug", async (req, res) => {
  const found = await requireAdmin(req, res);
  if (!found) return;
  const p = found.playlist;
  const { rows } = await pool.query(
    `UPDATE playlists
        SET title = $1, intro = $2, creator_name = $3, theme = $4, is_public = $5, updated_at = now()
      WHERE id = $6 RETURNING *`,
    [
      req.body.title !== undefined ? clean(req.body.title, MAX_SHORT) || p.title : p.title,
      req.body.intro !== undefined ? clean(req.body.intro, MAX_COMMENTARY) : p.intro,
      req.body.creatorName !== undefined ? clean(req.body.creatorName, MAX_SHORT) : p.creator_name,
      req.body.theme !== undefined ? (THEMES[req.body.theme] ? req.body.theme : "") : p.theme,
      req.body.isPublic !== undefined ? Boolean(req.body.isPublic) : p.is_public,
      p.id,
    ]
  );
  res.json(publicShape(rows[0], found.tracks, req));
});

// Hands back a link that lets someone add songs. Minted fresh each time and
// valid alongside every other one, so an owner can invite a person without
// having kept the original link and without breaking anyone else's.
app.post("/api/playlists/:slug/invite", async (req, res) => {
  const found = await requireAdmin(req, res);
  if (!found) return;

  const token = randomId(32);
  await pool.query(
    "INSERT INTO playlist_invites (playlist_id, token_hash) VALUES ($1, $2)",
    [found.playlist.id, hashToken(token)]
  );
  res.status(201).json({ editKey: token });
});

// Losing the edit link used to be permanent, and a link once sent out could
// never be taken back. Rotating replaces the token: the owner gets a fresh
// link to hand out, and every copy of the old one stops working.
app.post("/api/playlists/:slug/rotate-key", async (req, res) => {
  const found = await requireAdmin(req, res);
  if (!found) return;

  const editToken = randomId(32);
  await pool.query("UPDATE playlists SET edit_token_hash = $1 WHERE id = $2", [
    hashToken(editToken),
    found.playlist.id,
  ]);
  // "Every old copy stops working" has to include the invites, or it is a lie.
  await pool.query("DELETE FROM playlist_invites WHERE playlist_id = $1", [found.playlist.id]);
  res.json({ editKey: editToken });
});

app.delete("/api/playlists/:slug", async (req, res) => {
  const found = await requireAdmin(req, res);
  if (!found) return;
  // Tracks go with it via ON DELETE CASCADE.
  await pool.query("DELETE FROM playlists WHERE id = $1", [found.playlist.id]);
  res.status(204).end();
});

// Takes the full list of track ids in their new order. Sending the whole
// order rather than one moved track keeps positions consistent when two
// people are rearranging at once — last write wins on the entire sequence
// instead of leaving a half-applied swap behind.
app.put("/api/playlists/:slug/order", async (req, res, next) => {
  // Sequencing is an editorial call, so it stays with whoever owns the playlist.
  const found = await requireAdmin(req, res);
  if (!found) return;

  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : null;
  if (!ids) return res.status(400).json({ error: "Send the track ids in their new order." });

  const known = found.tracks.map((t) => String(t.id));
  const sameSet =
    ids.length === known.length &&
    new Set(ids).size === ids.length &&
    ids.every((id) => known.includes(id));
  if (!sameSet) {
    return res.status(409).json({
      error: "This playlist changed while you were rearranging it. Reload and try again.",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < ids.length; i++) {
      await client.query(
        "UPDATE playlist_tracks SET position = $1 WHERE id = $2 AND playlist_id = $3",
        [i + 1, ids[i], found.playlist.id]
      );
    }
    await client.query("UPDATE playlists SET updated_at = now() WHERE id = $1", [found.playlist.id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    return next(err);
  }
  client.release();

  const fresh = await loadPlaylist(req.params.slug);
  res.json(publicShape(fresh.playlist, fresh.tracks, req));
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
       (playlist_id, position, title, artist, youtube_id, artist_name, artist_context, commentary, contributor_name, contributor_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      found.playlist.id,
      nextPosition,
      title,
      clean(req.body.artist, MAX_SHORT),
      youtubeId,
      clean(req.body.artistName, MAX_SHORT),
      clean(req.body.artistContext, MAX_COMMENTARY),
      clean(req.body.commentary, MAX_COMMENTARY),
      // A signed-in contributor gets their real name, not a typed one.
      req.user ? clean(req.user.display_name, MAX_SHORT) : clean(req.body.contributorName, MAX_SHORT),
      req.user ? req.user.id : null,
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
  if (!canModifyTrack(req, found.playlist, track)) {
    return res.status(403).json({
      error: "You can only change songs you added yourself. Ask whoever owns this playlist to edit that one.",
    });
  }

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
  await pool.query("UPDATE playlists SET updated_at = now() WHERE id = $1", [found.playlist.id]);
  res.json(rows[0]);
});

app.delete("/api/playlists/:slug/tracks/:id", async (req, res) => {
  const found = await requireEditKey(req, res);
  if (!found) return;

  const track = found.tracks.find((t) => String(t.id) === req.params.id);
  if (!track) return res.status(404).json({ error: "That track is not in this playlist." });
  if (!canModifyTrack(req, found.playlist, track)) {
    return res.status(403).json({
      error: "You can only remove songs you added yourself.",
    });
  }

  await pool.query("DELETE FROM playlist_tracks WHERE id = $1 AND playlist_id = $2", [
    req.params.id,
    found.playlist.id,
  ]);
  await pool.query("UPDATE playlists SET updated_at = now() WHERE id = $1", [found.playlist.id]);
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
