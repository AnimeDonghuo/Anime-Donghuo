# Anime Donghua — anime & donghua discovery

The existing homepage structure, Express API, authentication, data stores, and vanilla-JavaScript architecture are preserved. Anime Donghua adds the requested dark palette and supplied blue-dragon hero art, responsive discovery filters, schedule and title-detail pages, a playback-status view, guest/account My List, and browser-local discovery/reduced-motion preferences. Episode updates, release times, ratings, episode counts, and viewing progress appear only when corresponding metadata exists; the seed catalogue does not invent those values. Poster artwork can be resolved from the configured catalogues and stored on ImgBB when its API key is configured; there are no remote font requests.

## Run locally

Requires Node.js 22 or newer.

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:8000`. When running behind a single trusted preview proxy, start with `TRUST_PROXY=1 npm run dev`; do not enable that option for an unproxied public server. With no `MONGODB_URI`, local development uses an **in-memory demo store**: accounts, saved titles, and Telegram media overrides disappear when the server restarts. This mode is not used in production. To use MongoDB locally, configure the URI and all three persistent secrets described below.

Run the automated checks with:

```bash
npm test
```

## Koyeb deployment (Docker Web Service)

The repository includes a small, non-root Node 22 Docker image. It listens on `0.0.0.0:$PORT` (default `8000`), compresses responses, and exposes `/healthz` for the Web Service health check. It uses one Node process and a small MongoDB connection pool; there are no workers, local media files, or Koyeb volumes.

1. Create a TLS-enabled MongoDB database (for example, MongoDB Atlas) and a dedicated application database user with only the permissions this app needs. Keep the connection URI private.
2. Connect this repository to Koyeb and create a **Web Service** using the repository's Dockerfile. Set the exposed HTTP port to `8000` and the health-check path to `/healthz`.
3. Use the free instance in a supported region, then add these as **Koyeb secrets/environment variables** (never commit real values):
   - `NODE_ENV=production`
   - `PORT=8000`
   - `MONGODB_URI=mongodb+srv://...` (TLS is required in production)
   - `SESSION_SECRET` — generate with `openssl rand -hex 32`
   - `EMAIL_LOOKUP_SECRET` — generate a different value with `openssl rand -hex 32`
   - `DATA_ENCRYPTION_KEY` — generate with `openssl rand -base64 32`
   - optionally `PUBLIC_ORIGIN=https://<your-koyeb-domain>` for an explicit origin allowlist
4. Deploy and check `/healthz` and `/readyz`. `/readyz` is 503 if MongoDB is not connected.

Koyeb's free instance is a small hobby/testing target (512 MB RAM, 0.1 vCPU, 2 GB disk; one free instance per organization, no attached volumes or worker services, and it scales to zero after an hour without traffic). Free instances are not recommended for production by Koyeb. MongoDB therefore must be external; the app stores no durable user data on the Koyeb filesystem. Review current platform limits before deploying: [Koyeb instance reference](https://www.koyeb.com/docs/reference/instances) and [pricing FAQ](https://www.koyeb.com/docs/faqs/pricing).

The app is intentionally kept lean for this limit. Password hashing is rate-limited and restricted to two concurrent operations to bound CPU and memory use. A free instance still cannot promise production availability or absorb abusive traffic; use a paid/scaled setup for a real public launch.

### MongoDB network access

Use a dedicated database user with a strong password, keep TLS enabled, and limit network access as tightly as your MongoDB provider and Koyeb egress setup permit. Koyeb free services do not provide a persistent disk for MongoDB. Never paste the full connection string into source control or browser code.

## Security model

- Passwords are stored as salted `scrypt` hashes (not reversible encryption); request bodies and passwords are never logged.
- Email and display name are encrypted with AES-256-GCM before MongoDB storage. A keyed HMAC of the normalized email is used only for lookup/uniqueness, so the database does not need a plaintext email index.
- Session cookies are HttpOnly, `Secure` in production, `SameSite=Lax`, HMAC-signed, and revocable on sign-out. Write requests also require a same-origin check and a CSRF token.
- Helmet security headers include a restrictive Content Security Policy; the app has no CORS allowlist, limits JSON bodies, bounds catalogue filters, and rate-limits API/authentication requests.
- Production startup refuses to use in-memory storage or a MongoDB URI that disables TLS. Secrets stay in the environment, not in Git.

**Back up the two data keys securely.** Rotating `SESSION_SECRET` signs users out. Changing `DATA_ENCRYPTION_KEY` or `EMAIL_LOOKUP_SECRET` without an explicit data migration makes existing account email/name values unavailable or unfindable. Key rotation tooling is not included in this first version.

### Important scraping limitation

Encryption cannot stop someone from copying public content that their browser must receive. Anime Donghua applies rate limits and server-side bounds as friction, but this is not a guarantee against scraping, bots, screenshots, or a distributed client. Do not put private catalogue records, credentials, or unreleased media in the public frontend/API. Real video protection requires authorized source integration and access control; signed, short-lived stream URLs and a licensed DRM/provider workflow can raise the bar but cannot make rendered content impossible to capture.

## Catalogue and streaming

The initial catalogue is sample metadata based on the supplied homepage. Update `src/catalog.js` when you provide a final, verified catalogue. The homepage cards remain present immediately so the layout renders without waiting for JavaScript; discovery, title details, and schedule views use the existing `/api/catalog` data. Optional schedule, language, year, episode, and rating metadata is sanitized before becoming public.

The playback-status view reports unavailable playback until an admin adds a supported, authorized player. The Animexin importer accepts only Dailymotion and Rumble links and embeds those providers directly; this app does not host, download, or proxy video. An optional owner-provided MediaFire download link remains a separate action and does not enable playback. The schedule and latest-updates views show empty states until verified data is added. Never put provider credentials in client-side JavaScript. Discovery and reduced-motion preferences are saved in the current browser's local storage and are not synced to the user account.

## Poster sourcing and Telegram admin bot

Poster lookup uses exact normalized title matches only. Donghua movies and series try Animexin first, then MyAnimeList and AniList; TMDB remains limited to anime series/movies and donghua movies. Other anime titles try MyAnimeList, AniList, then TMDB. Animexin poster lookup reads title and artwork metadata only. Separately, the admin-only `/animexinplayers <catalog ID, title, or SB-ID> [Animexin page URL]` command checks an exact donghua result and extracts only Dailymotion and Rumble player URLs; it never downloads video bytes or follows the player links server-side. Those approved embeds appear on a static catalogue title’s playback view. `ANIMEXIN_BASE_URL` defaults to `https://animexin.dev` and can be overridden if the site moves. Animexin is enabled by default because permission has been confirmed; set `ANIMEXIN_ENABLED=false` to disable both Animexin poster lookup and player extraction. If poster files use another public CDN, list its hostname in `ANIMEXIN_IMAGE_HOSTS`. No live Animexin request is made when the source is disabled.

### Public domain, published posts, and the shelves this site shows

Set `PUBLIC_SITE_URL` (or `PUBLIC_ORIGIN`) to the **custom domain**, e.g. `https://app.animedonghua.nx.kg`. Koyeb keeps its auto-assigned `*.koyeb.app` value in the environment after a domain is attached, so a custom domain always wins when links are built — announcements, `/postid`, and publish confirmations all print the domain visitors actually use. Leaving only `KOYEB_PUBLIC_DOMAIN` set still works; it is simply the fallback.

Posts created through the Telegram publisher are part of the website, not a separate catalogue. The app opens the publisher catalog at startup and serves those cards through:

- `/<category>/<slug>` (the link the bot prints), `/title/<slug>`, `/watch/<slug>`
- `/api/catalog` (list) and `/api/catalog/<slug>` (detail)

A slug that does not exist (deleted or unpublished post, or a shelf this site does not show) answers with a readable "that post is not available" page instead of a bare 404. Discovery and playback still render from the same public title shape, so approved Dailymotion/Rumble players attached with `/animexinplayers` or `/cmd` appear on `/watch/<slug>`.

Only **anime and donghua** are published here (series or movie). The bot's draft panel and command menu expose `/anime`, `/donghua`, and `/movie`; the upstream shelves (cartoon, K-Drama, web series, TV/OTT, 18+) reply with guidance instead of creating a draft the site could never display, and `/category` accepts only anime, donghua, and movie.

### Latest releases with English playback

The site keeps a rolling list of the newest Animexin episodes at `/releases` (and on the home page). A background refresh reads the Animexin RSS feed at `ANIMEXIN_BASE_URL/feed/` on startup and every `ANIMEXIN_REFRESH_MINUTES` (default 30, range 5–1440), falls back to the Animexin home page when the feed is empty, then reads each release page. Only servers whose label is English **and** whose provider is Dailymotion or Rumble become playable: Indonesian, Ok.ru, Odysee, Dtube, Mega, Dood, and every other mirror are discarded at scrape time and again when the public JSON is serialized. Each release embeds at most six approved players plus any MediaFire downloads, and the app never downloads, hosts, or proxies the video bytes. `/api/releases` and `/api/releases/:id` expose only that public shape — never the scrape page URL or raw server list — and the HTML routes `/releases` and `/release/:id` render natively. Cached releases live in the `AnimeDonghuaAnimexinRelease` MongoDB collection when `MONGODB_URI` is set, otherwise in memory for the life of the process.

New episodes are also mirrored into the publisher catalog automatically: each English release becomes one donghua card with a real `SB-…` Post ID, a site page at `/<category>/<slug>`, and (when `/addchannel` channels exist) a channel announcement. The card keeps updating in place on later refreshes instead of creating a second copy, and a release with no English Dailymotion/Rumble server is never published. `ANIMEXIN_REFRESH_MINUTES` controls the cadence.

Admins can review and extend the list from a private chat with the bot: `/releases` refreshes and prints the current release IDs with their English player counts, and `/releasedownload <release-id> <https://www.mediafire.com/file/...>` attaches an authorized MediaFire file you own or may distribute. Admin-added downloads survive later refreshes; scraped MediaFire links are shown only when the release page itself links them.

Artwork comes from the release page's own featured image (including the Jetpack/WordPress CDN Animexin serves it from) and is re-hosted on ImgBB, so every post has a poster that stays up; when ImgBB is not configured the scraped URL is used as-is.

`/checkanimexin` runs that reconciliation on demand instead of waiting for the schedule: it reads the feed, every release page, attaches the approved English Dailymotion/Rumble players to a post that already exists for the episode (no duplicate card), and publishes any episode that has no post yet. It replies with the Post IDs and the `/donghua/<slug>` page it created or updated, and it removes the non-episode cards an early homepage scan could publish (theme-menu entries such as "Genres" or "Release Date") together with any duplicate episode card.

The home page is rendered from the live catalogue. `/api/catalog` supplies the hero, the Featured/Donghua/Anime shelves, and the latest-posts row, so a post published through the bot appears there on the next refresh without a redeploy. Only `anime` and `donghua` (plus their movie formats) are exposed, and an unpublished draft is never served — not in a shelf, not by slug, and not by Post ID.

In production, poster synchronization runs on startup unless `POSTER_SYNC_ENABLED=false`. In development/test it is off unless `POSTER_SYNC_ENABLED=true`. Resolved artwork and admin overrides are persisted in the `AnimeDonghuaTitleMedia` MongoDB collection. With `IMGBB_API_KEY`, fetched posters are uploaded to ImgBB and the cached URL is stored; without it, the app keeps the provider image URL when it is on the approved host list. The linked [AnimeDonghuo/imgtolink bot](https://github.com/AnimeDonghuo/imgtolink/tree/arena/01a052c3-imgtolink) uses ImgBB, not a separate ImgDB API. This app follows its official ImgBB upload flow only; its legacy proxy and keyless third-party fallback are intentionally not used.

Optional Telegram setup uses deployment secrets/environment variables:

- `TELEGRAM_BOT_TOKEN` — token from BotFather.
- `TELEGRAM_ADMIN_IDS` — comma-separated numeric Telegram user IDs allowed to access app-specific admin tools and publisher login.
- `ADMIN_LOGIN_CODE` — 8–128 byte publisher passcode. Admins use `/login <code>` to unlock the full upstream publisher command set; `/logout` locks it again.
- `TELEGRAM_STORAGE_CHANNEL_ID` — private database channel for upload, `/batch`, and optional auto-publish workflows. Make the bot an administrator with the required post/read permissions.
- `TELEGRAM_ADULT_STORAGE_CHANNEL_ID` — optional, distinct private channel for isolated adult-category content.
- `TELEGRAM_REQUEST_CHANNEL_ID` — optional destination for visitor title requests.
- `TELEGRAM_CATALOG_DB` — optional database override. By default publisher records use the database named in `MONGODB_URI`, in a separate `content` collection.
- `IMGBB_API_KEY` — used for poster hosting. Additional `IMGBB_API_KEYS` may be configured for publisher uploads.
- `TELEGRAM_WEBHOOK_SECRET` — optional secret for the legacy webhook handler; the integrated command bot uses Telegraf long polling and does not need `PUBLIC_ORIGIN` to register a webhook. It clears any old webhook without dropping queued updates. Run one application replica so only one poller owns the bot token.

Visitors can use `/start`, `/request <title>`, and `/help`. Set `ADMIN_LOGIN_CODE` to activate the complete upstream publisher command set (drafts, direct uploads, batches, metadata edits, poster tools, player management, backup/recovery, channel controls, requests, and system controls); use `/help all` for the full reference. Without it, visitors and the existing app-specific admin commands remain available, but publisher sessions cannot be unlocked. Publisher records and their delivery links are managed by the Telegram catalog repository, which shares MongoDB but is separate from the static discovery catalogue.

The existing static-catalog tools remain available in a private chat: use `/catalogposter perfect-world` and reply to that command with a photo (or caption a photo with `/catalogposter perfect-world`) to set artwork. The upstream publisher `/poster` workflow is preserved; the older photo-caption shortcut `/poster perfect-world` also remains supported. Use `/download big-fish-and-begonia https://www.mediafire.com/file/...` to save an authorized link. Static-catalog writes are restricted to `TELEGRAM_ADMIN_IDS`. Use `/releases` to list the newest Animexin episodes with their English player counts and release IDs, and `/releasedownload <release-id> <https://www.mediafire.com/file/...>` to attach your own MediaFire file to one of them. To add player links to a catalogue title or published post, use `/animexinplayers <catalog ID, exact title, or SB-Post-ID> [Animexin page URL]`; the scraper validates the Animexin page host and stores only normalized Dailymotion/Rumble embeds. Static titles display their authorized players at `/watch/<catalog-id>`. The target must already exist as a static catalog title or published donghua post. Do not send bot tokens or API keys in chat or commit them.
