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

The playback-status view is intentionally **not** a pirate stream or a fake playable video: no stream source is embedded. It clearly reports when playback is unavailable. An optional owner-provided download link is shown only when an admin explicitly adds an authorized link; it never enables video playback. The schedule and latest-updates views show empty states until verified data is added. Never put provider credentials in client-side JavaScript. Discovery and reduced-motion preferences are saved in the current browser's local storage and are not synced to the user account.

## Poster sourcing and Telegram admin bot

Poster lookup uses exact normalized title matches only. When Animexin is explicitly enabled, donghua movies try it first, then MyAnimeList, AniList, and TMDB; when disabled, lookup starts with MyAnimeList. Other anime titles try MyAnimeList, then AniList, then TMDB. TMDB is limited to anime series/movies and donghua movies; donghua series do not fall through to TMDB. The Animexin scraper reads only the title and poster image from a public search result; it does not extract episodes, streams, or download links. `ANIMEXIN_BASE_URL` defaults to `https://animexin.dev` and can be overridden if the site moves. Animexin scraping is disabled by default; set `ANIMEXIN_ENABLED=true` only after confirming automated poster reuse is permitted. `ANIMEXIN_ENABLED=false` keeps it disabled. If poster files use another public CDN, list its hostname in `ANIMEXIN_IMAGE_HOSTS`. No live Animexin request is made while the source is disabled.

In production, poster synchronization runs on startup unless `POSTER_SYNC_ENABLED=false`. In development/test it is off unless `POSTER_SYNC_ENABLED=true`. Resolved artwork and admin overrides are persisted in the `AnimeDonghuaTitleMedia` MongoDB collection. With `IMGBB_API_KEY`, fetched posters are uploaded to ImgBB and the cached URL is stored; without it, the app keeps the provider image URL when it is on the approved host list. The linked [AnimeDonghuo/imgtolink bot](https://github.com/AnimeDonghuo/imgtolink/tree/arena/01a052c3-imgtolink) uses ImgBB, not a separate ImgDB API. This app follows its official ImgBB upload flow only; its legacy proxy and keyless third-party fallback are intentionally not used.

Optional Telegram setup uses deployment secrets/environment variables:

- `TELEGRAM_BOT_TOKEN` — token from BotFather.
- `TELEGRAM_WEBHOOK_SECRET` — a random URL-safe secret of at least 32 characters.
- `TELEGRAM_ADMIN_IDS` — comma-separated numeric Telegram user IDs allowed to manage catalogue media.
- `PUBLIC_ORIGIN` — the exact public app origin. When all Telegram values and `PUBLIC_ORIGIN` are set, the server registers the webhook at `/api/telegram/webhook` and installs the bot commands. Otherwise, register that webhook manually using Telegram's Bot API and the same secret token header.
- `IMGBB_API_KEY` — required for poster uploads from Telegram.

In a private chat with the bot, send a photo with caption `/poster perfect-world` to set an existing title's poster. You can also send `/poster perfect-world` and reply to that command with the photo. IDs must already exist in `src/catalog.js`; updates are admin-only. To add a download URL for a file you own or are authorized to distribute, send `/download big-fish-and-begonia https://www.mediafire.com/file/...`. The URL is validated and stored per title; the app does not search MediaFire, resolve third-party links, or prefill links for the rest of the catalogue. Do not send bot tokens or API keys in chat or commit them.
