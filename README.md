# Make a Playlist

A tool for building a playlist with commentary and sharing it as a link. Generalized from [Intro to Anna: A Playlist Experience](https://github.com/keyona-rerev/Intro-to-Anna-_-A-Playlist-Experience), which paired YouTube embeds with a written note on why each specific song and video made the cut.

The commentary is the point. A bare list of songs is a link to Spotify. A list of songs where someone explains that this particular live video is the only time the band ever played the song, and you can hear the crowd realize it, is something a person actually sits through.

## v1 scope: no accounts

Nobody signs up. Nobody logs in.

- **Creating a playlist** returns two links: a public one and a secret one.
- **Experience mode** (`/p/:slug`) is public and read-only. This is the link you send people.
- **Edit mode** (`/e/:slug#key`) requires the secret key. Anyone holding that link can add tracks and commentary.
- **Attribution** is self-reported. Contributors type a name when they add a track. Unverified by design.

The tradeoff: access cannot be revoked once the edit link is out, and there is no "my playlists" page. Accounts are a v2 concern, and the schema leaves room for them.

## Stack

- **Frontend:** static single-page app, Netlify
- **API:** Express on Railway
- **Database:** Postgres on Railway

## Data model

Two tables.

**playlists**
`id`, `slug`, `edit_token_hash`, `title`, `intro`, `creator_name`, `created_at`, `updated_at`, `view_count`

**playlist_tracks**
`id`, `playlist_id`, `position`, `title`, `artist`, `youtube_id`, `artist_name`, `artist_context`, `commentary`, `contributor_name`, `created_at`

Tracks are rows rather than a JSONB blob so two people adding songs at the same time do not overwrite each other.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/playlists` | Create. Returns `slug` and `edit_token`. |
| `GET` | `/api/playlists/:slug` | Read. Public. |
| `PATCH` | `/api/playlists/:slug` | Update title, intro, creator. Requires edit token. |
| `POST` | `/api/playlists/:slug/tracks` | Add a track. Requires edit token. |
| `PATCH` | `/api/playlists/:slug/tracks/:id` | Edit a track. Requires edit token. |
| `DELETE` | `/api/playlists/:slug/tracks/:id` | Remove a track. Requires edit token. |
| `GET` | `/p/:slug` | Server-rendered shell with OG tags for link previews. |

## Notes on the secret link

The edit key lives in the URL fragment (`#key`), not the query string, so it stays out of server logs and referrer headers. The client reads `location.hash` and sends the key as a request header. Only a hash of the token is stored.

## Constraints

- YouTube IDs are validated against `^[A-Za-z0-9_-]{11}$` before they reach an iframe `src`.
- All user text renders via `textContent`, never `innerHTML`.
- Playlist creation is rate limited by IP.
- Caps: 40 tracks per playlist, 2000 characters per commentary block.
