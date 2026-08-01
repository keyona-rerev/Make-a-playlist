# Make a Playlist

A tool for building a playlist with commentary and sharing it as a link. Generalized from [Intro to Anna: A Playlist Experience](https://github.com/keyona-rerev/Intro-to-Anna-_-A-Playlist-Experience), which paired YouTube embeds with a written note on why each specific song and video made the cut.

The commentary is the point. A bare list of songs is a link to Spotify. A list of songs where someone explains that this particular live video is the only time the band ever played the song, and you can hear the crowd realize it, is something a person actually sits through.

## Roles

Three kinds of people use this, and the app treats them differently.

- **Listener** — opens `/p/:slug`. Public, read-only, no account. This is the link you send people.
- **Owner** — made the playlist, or claimed it. Adds songs, reorders them, edits any track, renames the playlist, changes its look and visibility, replaces the edit link, deletes the whole thing.
- **Contributor** — was handed the edit link. Adds songs, and edits or removes the ones they added. Cannot rename, reorder, delete the playlist, or touch anyone else's tracks.

## Accounts are optional

Nobody has to sign up. Everything works signed out, and links already sent keep working — accounts are additive, never a gate.

- **Creating a playlist** returns a public link and a secret edit link.
- **Signed out**, the edit link is the only way back in. It is kept in `localStorage` and offered as an email or a downloadable file at the moment it is created, because that is the only time it is shown.
- **Signed in** (Google), a playlist you create is owned by you and reachable from `/mine` on any device, with or without the edit link.
- **Claiming**: a playlist with no owner can be attached to your account by anyone holding its edit link. First claim wins, so handing out the link cannot take the playlist from you.
- **Attribution** is self-reported for signed-out contributors and taken from the account for signed-in ones, which is what the ✓ next to a name means.

## Permissions

Adding a song is open to anyone with the edit link — that is what the link is for. Changing what is already there is not.

| | Listener | Contributor (edit link) | Owner |
| --- | --- | --- | --- |
| Listen | ✓ | ✓ | ✓ |
| Add a track | | ✓ | ✓ |
| Edit / remove **their own** track | | ✓ (signed in) | ✓ |
| Edit / remove **anyone's** track | | | ✓ |
| Reorder | | | ✓ |
| Title, intro, look, visibility | | | ✓ |
| Replace the edit link, delete the playlist | | | ✓ |

A playlist with no owner has nobody else to ask, so the edit key carries the owner's rights until someone claims it.

## Stack

- **Frontend:** static pages, no build step, no framework
- **API:** Express on Railway
- **Database:** Postgres on Railway

## Data model

**playlists**
`id`, `slug`, `edit_token_hash`, `title`, `intro`, `creator_name`, `theme`, `owner_id`, `is_public`, `created_at`, `updated_at`, `view_count`

**playlist_tracks**
`id`, `playlist_id`, `position`, `title`, `artist`, `youtube_id`, `artist_name`, `artist_context`, `commentary`, `contributor_name`, `contributor_user_id`, `created_at`

**users** `id`, `google_sub`, `email`, `display_name`, `avatar_url`, `created_at`
**sessions** `token_hash`, `user_id`, `expires_at`, `created_at` — one row per login, so signing in on your phone does not end the session on your laptop.

Tracks are rows rather than a JSONB blob so two people adding songs at the same time do not overwrite each other.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/playlists` | Create. Returns `slug` and `editKey`. Owned by you if signed in. |
| `GET` | `/api/playlists` | Browse. `q`, `sort`, `limit`, `offset`, `includeEmpty`. Public and non-empty by default. |
| `GET` | `/api/playlists/:slug` | Read. Public. Also reports what the caller may do. `?count=1` records a play. |
| `PATCH` | `/api/playlists/:slug` | Title, intro, creator, theme, `isPublic`. Owner. |
| `DELETE` | `/api/playlists/:slug` | Delete the playlist and its tracks. Owner. |
| `PUT` | `/api/playlists/:slug/order` | Reorder. Takes every track id in its new order. Owner. |
| `POST` | `/api/playlists/:slug/rotate-key` | New edit link; every old copy stops working. Owner. |
| `POST` | `/api/playlists/:slug/claim` | Attach an unowned playlist to your account. |
| `POST` | `/api/playlists/:slug/tracks` | Add a track. Edit link or owner. |
| `PATCH` | `/api/playlists/:slug/tracks/:id` | Edit a track. Your own, or any if you own the playlist. |
| `DELETE` | `/api/playlists/:slug/tracks/:id` | Remove a track. Same rule as editing. |
| `GET` | `/api/me` | Current user, and whether sign-in is configured. |
| `GET` | `/api/my/playlists` | Playlists you own or have contributed to. |
| `GET` | `/api/oembed` | YouTube title lookup, proxied because oEmbed sends no CORS headers. |
| `GET` | `/p/:slug` | Server-rendered shell with OG tags for link previews. |

Sign-in lives at `/auth/google`, `/auth/google/callback` and `/auth/signout`, and is only advertised when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.

## Notes on the secret link

The edit key lives in the URL fragment (`#key`), not the query string, so it stays out of server logs and referrer headers. The client reads `location.hash` and sends the key as a request header. Only a hash of the token is stored, so a lost key cannot be looked up — an owner mints a replacement instead, which also revokes the old one.

A fragment does not survive an OAuth round trip, so the key is restored from `localStorage` on return. That also means a bare `/e/:slug` bookmark still works.

## Constraints

- YouTube IDs are validated against `^[A-Za-z0-9_-]{11}$` before they reach an iframe `src`.
- All user text renders via `textContent`, never `innerHTML`.
- API responses are `Cache-Control: no-store`. What comes back depends on the edit-key header and the session cookie, neither of which the browser cache keys on.
- Playlist creation is rate limited by IP.
- Caps: 40 tracks per playlist, 2000 characters per commentary block.

## Running it

```
npm install
DATABASE_URL=postgres://... npm start     # migrates on boot, then listens
DATABASE_URL=postgres://... npm run seed   # optional demo playlist
```

Optional: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL`, `PORT`.
