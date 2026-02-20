# 🏋️ BodyBank — Deployment Guide

## Repo / live readiness

- **Database:** Admin and Superadmin are stored in PostgreSQL (`users` table with `role = 'admin'` or `'superadmin'`). On first start, the server creates one admin and one superadmin user if missing, using `ADMIN_EMAIL`/`ADMIN_PASS` and `SUPERADMIN_EMAIL`/`SUPERADMIN_PASS` from the environment. In **production**, default passwords are refused — set strong values in your host (e.g. Render env vars).
- **Superadmin backend:** All superadmin data (dashboard, share link, shared view) is served from the same DB via `GET /api/superadmin/dashboard`, `POST /api/superadmin/share-link`, and `GET /api/superadmin/shared`. Auth is JWT; share links use `JWT_SECRET` and optional `PUBLIC_URL`.
- **Live Superadmin login:** After deployment, use the **email** and **password** you set for `SUPERADMIN_EMAIL` and `SUPERADMIN_PASS` in your hosting environment. See [Deploy to Render](#deploy-to-render-free--recommended) and the table below for required variables.

---

## Quick Start (Local)
```bash
npm install
node server.js
```
Open **http://localhost:3000**

**Admin Login:** `admin@bodybank.fit` / `admin123`  
**Superadmin (business overview):** `superadmin@bodybank.fit` / `superadmin123` — single-page dashboard with stats, audit/part2/sunday check-ins, users, workouts, tribe, meetings, messages; filters (date/user), CSV export per block, and time-limited “Share via link”. Set `SUPERADMIN_EMAIL` and `SUPERADMIN_PASS` in `.env` to override.

### Verify API & Database Connection
1. Start the server: `npm start`
2. Open **http://localhost:3000** (do not open `index.html` as a file; the API needs the server)
3. Check health: visit **http://localhost:3000/api/health** — should return `{"ok":true,"db":"connected","admin_email":"admin@bodybank.fit","admin_exists":true}`
4. Login with `admin@bodybank.fit` / `admin123`

If login fails with "Invalid email or password", ensure you're using the correct credentials.

### Database (PostgreSQL)
1. Create a database, e.g. `createdb bodybank` (or use pgAdmin / psql: `CREATE DATABASE bodybank;`).
2. In `.env` set `DATABASE_URL=postgresql://localhost:5432/bodybank` (adjust user/password if needed).
3. To **migrate existing data from SQLite**: put your old `data/bodybank.db` in place, set `DB_PATH=data/bodybank.db` in `.env`, then run `node scripts/migrate-sqlite-to-postgres.js`. After that, start the server with `DATABASE_URL` set.

### End-to-end tests
With the server running (`npm run dev`), run: `npm test`. This exercises sign up → admin approval → login → profile, workouts, contact, meetings, sunday check-in, public audit/part2 forms, admin dashboard and DB.

---

## Deploy to Render (FREE — Recommended)

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Settings will auto-detect from `render.yaml`
5. Add a **PostgreSQL** database (Render Postgres or external) and set `DATABASE_URL` in the web service environment variables.
6. **Required environment variables** (Dashboard → your Web Service → Environment):
   | Key | Value | Notes |
   |-----|--------|------|
   | `DATABASE_URL` | `postgresql://...` | From Render Postgres (Internal URL) or your DB |
   | `ADMIN_EMAIL` | your-admin@example.com | Admin login email |
   | `ADMIN_PASS` | **strong password** | Required in production (default blocked) |
   | `SUPERADMIN_EMAIL` | your-superadmin@example.com | Superadmin / business overview login |
   | `SUPERADMIN_PASS` | **strong password** | Required in production (default blocked) |
   | `JWT_SECRET` | long random string | Recommended in production for auth tokens |
   | `NODE_ENV` | `production` | Usually set by Render |
   | `PUBLIC_URL` | (optional) `https://your-app.onrender.com` | Override share-link base URL if needed |
7. Click **Deploy**

Your site will be live at `https://bodybank-xxxx.onrender.com` (or your custom domain).

### Live server: Superadmin login (after deployment)

- **URL:** Your live app URL (e.g. `https://bodybank-xxxx.onrender.com`). Open the site and click **Login**.
- **Superadmin credentials:** Use the **email** and **password** you set for `SUPERADMIN_EMAIL` and `SUPERADMIN_PASS` in Render environment variables.
- **Behaviour:** After login, if the user has role `superadmin`, they are taken to the **BodyBank – Superadmin** single-page dashboard (stats, audit forms, Part-2, Sunday check-ins, users, workouts, tribe, meetings, messages; filters, CSV export, “Share via link”).
- **First deploy:** On first deploy, the server creates one superadmin user in the database using `SUPERADMIN_EMAIL` and `SUPERADMIN_PASS`. If you do not set these, the app will **not** create a superadmin in production (default password is refused). Set both in Render before the first deploy so the superadmin account exists and you can log in.

### Superadmin login not working

1. **Check health:** Open `https://your-app.onrender.com/api/health`. You should see `superadmin_exists: true` and `superadmin_email: "your@email.com"`. If `superadmin_exists` is `false`, the user was never created.
2. **Check Render logs:** In Render → your Web Service → Logs, look for `✅ Superadmin created: your@email.com` after a deploy. If you see `❌ Refusing to create superadmin with default password`, the server refused to create one until you set a non-default `SUPERADMIN_PASS` and redeployed.
3. **Fix from your machine:** Run the update script against the production DB so the superadmin is created or its password is set from your env:
   - In your project folder, create or edit `.env` with:
     - `DATABASE_URL` = Render’s **Internal Database URL** (Render → Postgres → Connect → Internal Database URL)
     - `SUPERADMIN_EMAIL` = the email you want to use to log in
     - `SUPERADMIN_PASS` = the password you want
   - Run: `node scripts/update-superadmin.js`
   - Log in on the live site with that email and password.

---

## Deploy to Railway

1. Push to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Settings auto-detect from `railway.toml`
4. Add environment variables in Railway dashboard
5. Railway gives you a public URL automatically

---

## Deploy to VPS (DigitalOcean / AWS / Any Linux Server)

```bash
# 1. SSH into your server
ssh user@your-server-ip

# 2. Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 3. Clone your repo
git clone https://github.com/yourusername/bodybank.git
cd bodybank

# 4. Install dependencies
npm install --production

# 5. Set environment variables
cp .env.example .env
nano .env  # Edit with your admin credentials

# 6. Install PM2 for process management
sudo npm install -g pm2

# 7. Start with PM2
pm2 start server.js --name bodybank
pm2 save
pm2 startup  # Auto-start on reboot

# 8. Setup Nginx reverse proxy
sudo apt install nginx
sudo nano /etc/nginx/sites-available/bodybank
```

**Nginx config:**
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/bodybank /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

# 9. SSL with Let's Encrypt (free HTTPS)
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

---

## Deploy with Docker

```bash
# Build
docker build -t bodybank .

# Run
docker run -d \
  --name bodybank \
  -p 3000:3000 \
  -v bodybank-data:/app/data \
  -e NODE_ENV=production \
  -e ADMIN_EMAIL=admin@bodybank.fit \
  -e ADMIN_PASS=YourSecurePassword \
  bodybank
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `NODE_ENV` | development | Set to `production` for deployment |
| `ADMIN_EMAIL` | admin@bodybank.fit | Admin login email |
| `ADMIN_PASS` | admin123 | Admin login password |
| `DATABASE_URL` | postgresql://localhost:5432/bodybank | PostgreSQL connection string |

---

## Project Structure
```
bodybank/
├── server.js           # Backend (Express + PostgreSQL)
├── public/
│   └── index.html      # Complete frontend
├── scripts/
│   ├── migrate-sqlite-to-postgres.js  # One-time SQLite → PostgreSQL migration
│   ├── view-db.js      # View DB contents (PostgreSQL)
│   └── seed-user.js    # Seed a test user
├── package.json
├── Dockerfile
├── render.yaml         # Render.com config
├── railway.toml        # Railway config
├── .env.example
├── .gitignore
└── README.md
```

## API Reference

### Auth
- `GET /api/health` — Health check (API + DB); returns `{ok, db, admin_email, admin_exists}`
- `POST /api/auth/login` — `{email, password}` → user object with role
- `POST /api/auth/signup` — `{email, password, first_name, last_name, phone}`

### Audit Requests  
- `POST /api/audit` — Submit body audit form (public)
- `GET /api/audit` — List all requests (admin)
- `GET /api/audit/:id` — Get request details
- `PUT /api/audit/:id` — `{status: 'approved'|'rejected'}`
- `DELETE /api/audit/:id` — Delete request

### Tribe Members
- `GET /api/tribe` — List active members (admin)
- `GET /api/tribe/:id` — Get member details
- `POST /api/tribe` — Add member
- `PUT /api/tribe/:id` — Update member
- `DELETE /api/tribe/:id` — Remove member

### Dashboard
- `GET /api/stats` — `{pending_requests, active_members, completed, success_rate}`
