# AniVerse — anime & donghua discovery

The existing homepage structure, Express API, authentication, data stores, and vanilla-JavaScript architecture are preserved. AniVerse adds the requested dark palette and supplied blue-dragon hero art, responsive discovery filters, schedule and title-detail pages, a playback-status view, guest/account My List, and browser-local discovery/reduced-motion preferences. Episode updates, release times, ratings, episode counts, and viewing progress appear only when corresponding metadata exists; the seed catalogue does not invent those values. Artwork is local, with no remote image or font requests.

## Run locally

Requires Node.js 22 or newer.

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:8000`. When running behind a single trusted preview proxy, start with `TRUST_PROXY=1 npm run dev`; do not enable that option for an unproxied public server. With no `MONGODB_URI`, local development uses an **in-memory demo store**: accounts and saved titles disappear when the server restarts. This mode is not used in production. To use MongoDB locally, configure the URI and all three persistent secrets described below.

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

Encryption cannot stop someone from copying public content that their browser must receive. AniVerse applies rate limits and server-side bounds as friction, but this is not a guarantee against scraping, bots, screenshots, or a distributed client. Do not put private catalogue records, credentials, or unreleased media in the public frontend/API. Real video protection requires authorized source integration and access control; signed, short-lived stream URLs and a licensed DRM/provider workflow can raise the bar but cannot make rendered content impossible to capture.

## Catalogue and streaming

The initial catalogue is sample metadata based on the supplied homepage. Update `src/catalog.js` when you provide a final, verified catalogue. The homepage cards remain present immediately so the layout renders without waiting for JavaScript; discovery, title details, and schedule views use the existing `/api/catalog` data. Optional schedule, language, year, episode, and rating metadata is sanitized before becoming public.

The playback-status view is intentionally **not** a pirate stream or a fake playable video: no authorized provider URLs were supplied. It clearly reports that playback is unavailable and does not embed a video. The schedule and latest-updates views show empty states until verified data is added. Add authorized source details only when provided; never put provider credentials in client-side JavaScript. Discovery and reduced-motion preferences are saved in the current browser's local storage and are not synced to the user account.
