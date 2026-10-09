# StudyHub

AI-powered study hub built with Base44. A standalone, responsive study material management app.

## Features
- Student registration and sign-in with bcrypt password hashing
- Admin-only dashboard, upload, material deletion and user management
- Subject-wise PDF library with keyword search and subject filters
- Per-user bookmarks
- Authenticated PDF viewing (PDFs are not exposed as a public static directory)
- Responsive desktop/mobile layout
- 20 MB upload limit; server checks PDF extension and MIME type
- Session cookies marked HttpOnly and SameSite=Lax, basic security headers and auth rate limiting
- Local JSON data store with atomic file replacement; uploaded PDFs saved in `uploads/`

## Tech Stack
- **Backend:** Node.js, Express.js
- **Frontend:** HTML, CSS, Vanilla JavaScript
- **Data Store:** Local JSON file
- **Security:** bcryptjs, helmet, express-rate-limit

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
