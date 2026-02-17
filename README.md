# 🏋️ BodyBank — Deployment Guide

## Quick Start (Local)
```bash
npm install
node server.js
```
Open **http://localhost:3000**

**Admin Login:** `admin@bodybank.fit` / `admin123`

### Verify API & Database Connection
1. Start the server: `npm start`
2. Open **http://localhost:3000** (do not open `index.html` as a file; the API needs the server)
3. Check health: visit **http://localhost:3000/api/health** — should return `{"ok":true,"db":"connected","admin_email":"admin@bodybank.fit","admin_exists":true}`
4. Login with `admin@bodybank.fit` / `admin123`

If login fails with "Invalid email or password", ensure you're using the correct credentials. To reset the database and re-create the admin, delete `data/bodybank.db` and restart the server.

---

## Deploy to Render (FREE — Recommended)

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Settings will auto-detect from `render.yaml`
5. Add environment variables:
   - `ADMIN_EMAIL` = your email
   - `ADMIN_PASS` = your secure password
6. Add a **Disk** (for SQLite persistence): mount path `/app/data`, 1GB
7. Click **Deploy**

Your site will be live at `https://bodybank-xxxx.onrender.com`

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
| `DB_PATH` | ./data/bodybank.db | SQLite database path |

---

## Project Structure
```
bodybank/
├── server.js           # Backend (Express + SQLite)
├── public/
│   └── index.html      # Complete frontend
├── data/
│   └── bodybank.db     # Database (auto-created)
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
