# Copperbelt Province Interlaboratory Program — Full Stack

This replaces the old `window.storage`-based demo with a real client-server app:

```
frontend/   Static HTML/CSS/JS — hostable on GitHub Pages (or anywhere static)
backend/    Node.js + Express REST API — hostable on Render, Railway, Fly.io, etc.
```

Data lives in a real PostgreSQL database, accounts have real hashed passwords,
and every action is enforced by role on the server (not just hidden in the UI).

## 1. Set up the database

Create a free Postgres database on **Supabase**, **Neon**, or **Render Postgres**.
Then run the contents of `backend/schema.sql` against it (paste into the
provider's SQL editor, or `psql "$DATABASE_URL" -f backend/schema.sql`).

## 2. Run the backend locally first (recommended)

```bash
cd backend
npm install
cp .env.example .env
# edit .env: paste your DATABASE_URL, generate a JWT_SECRET, set FRONTEND_ORIGIN
npm start
```

You should see `Copperbelt ILC API listening on port 4000`.
Test it: `curl http://localhost:4000/api/health` → `{"ok":true}`

## 3. Run the frontend locally against it

Open `frontend/index.html` directly in a browser (or serve it with any static
server — e.g. the VS Code "Live Server" extension). Since `API_BASE` in the
script defaults to `http://localhost:4000/api`, it will just work against your
local backend. You should see the "Set up the Super Admin" screen — create an
account with a real username and password this time.

## 4. Deploy the backend

Any Node host works. Render's free tier is the simplest:

1. Push this whole folder to a GitHub repo.
2. On Render: New → Web Service → connect the repo → Root Directory: `backend`.
3. Build command: `npm install`. Start command: `npm start`.
4. Add environment variables: `DATABASE_URL`, `JWT_SECRET`, `FRONTEND_ORIGIN`
   (your GitHub Pages URL, e.g. `https://yourusername.github.io`).
5. Deploy. Note the URL Render gives you, e.g. `https://copperbelt-ilc-api.onrender.com`.

Render's free tier sleeps after inactivity — the first request after a while
takes ~30s to wake up. Fine for a pilot; upgrade later if that's a problem.

## 5. Deploy the frontend

In `frontend/index.html`, near the top of the `<script>` block, set:

```js
const API_BASE = 'https://copperbelt-ilc-api.onrender.com/api';
```

(replace with your real backend URL from step 4), then push `frontend/` to
GitHub Pages as before. Since the file no longer depends on `window.storage`,
it will now work as a normal static file anywhere — GitHub Pages, Netlify,
Vercel, or just double-clicking it locally.

## Security notes

- Passwords are hashed with bcrypt — never stored in plain text.
- Sessions use JWTs valid for 12 hours; users need to log back in after that.
- Every write endpoint checks the caller's role server-side, not just in the UI.
- This is still a lightweight auth system suitable for an internal pilot. If
  this program will hold real patient-identifiable data long-term, consider
  adding: forced password resets, audit logging of who changed what, and
  HTTPS enforcement (most hosts give you this by default) before wider rollout.
