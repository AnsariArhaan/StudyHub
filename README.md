# StudyHub

StudyHub is a standalone, responsive study material management app.

## Features
- Student registration and sign-in with bcrypt password hashing
- Admin-only dashboard, upload, material deletion and user management
- Subject-wise PDF library with keyword search and subject filters
- Per-user bookmarks
- Authenticated PDF viewing (PDFs are not exposed as a public static directory)
- Responsive desktop/mobile layout
- 20 MB upload limit; server checks PDF extension, MIME type and the %PDF- header
- Session cookies marked HttpOnly and SameSite=Lax, basic security headers and login/register rate limiting
- Local JSON data store with atomic file replacement; uploaded PDFs saved in `uploads/`
- Focus timer (Pomodoro) with per-subject session log stored on the device (localStorage)
- Installable as a PWA: web manifest, service worker and offline app shell

## Tech Stack
- **Backend:** Node.js, Express.js
- **Frontend:** HTML, CSS, Vanilla JavaScript
- **Data Store:** Local JSON file
- **Security:** bcryptjs, helmet, express-rate-limit, session-file-store

## Local Setup Steps

1. Clone the repository:
   ```bash
   git clone https://github.com/AnsariArhaan/StudyHub.git
   cd StudyHub
   ```
2. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
3. Update `.env` with your secure credentials.
4. Install dependencies:
   ```bash
   npm install
   ```
5. Start the development server:
   ```bash
   npm run dev
   ```
6. Open your browser and visit `http://localhost:3000`.

## Screenshots
> [!NOTE]
> Screenshots coming soon...

## Sessions and deployment

Sessions are stored in `data/sessions/` (8-hour expiry, hourly expired-file cleanup).
Keep this private directory and a stable `SESSION_SECRET` on persistent storage to
preserve sign-ins across restarts. It is ignored by Git. This store is for a single
server with local disk, not multiple instances or an ephemeral filesystem.

`TRUST_PROXY=0` is the safe default for direct connections. If your deployment has
exactly one trusted reverse proxy and direct access to the app is blocked, set
`TRUST_PROXY=1`. For a different topology use the correct hop count or comma-separated
trusted proxy IPs/CIDRs. Do not trust arbitrary client forwarding headers. Production
cookies require HTTPS; the trusted proxy must forward `X-Forwarded-Proto: https`.

Set your own `ADMIN_PASSWORD` and production `SESSION_SECRET`; do not use the dummy
values in `.env.example`. Changing `ADMIN_PASSWORD` does not reset an existing account.
