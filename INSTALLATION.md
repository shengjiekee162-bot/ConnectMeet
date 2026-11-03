# ConnectMeet Installation Guide

## Requirements

- Windows 10/11 with XAMPP **or** Apache + PHP 8.3+ + MySQL/MariaDB
- PHP extensions: `pdo_mysql`, `json`, `mbstring`, `openssl`, `session`
- Modern Chrome, Edge, or Firefox (Safari where WebRTC is supported)

## Local XAMPP / Apache setup

### 1. Start services

Start **Apache**. Start **MySQL** (XAMPP Control Panel) **or** use an existing MySQL service (this project was tested against MySQL 8.0 on Windows).

### 2. Place files

```
C:\xampp\htdocs\connectmeet\
```

### 3. Create database

Using MySQL CLI (adjust user/password):

```bat
"C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p < C:\xampp\htdocs\connectmeet\database\install.sql
```

Or open phpMyAdmin → Import → select `database/install.sql`.

### 4. Configure the app

```bat
copy config\config.example.php config\config.php
```

Edit `config/config.php`:

| Key | Example |
|-----|---------|
| `database.user` / `database.pass` | Your MySQL credentials |
| `database.name` | `connectmeet` |
| `app.base_url` | `http://localhost/connectmeet` |
| `app.debug` | `true` locally, `false` in production |
| `security.session_secure_cookie` | `true` only when serving HTTPS |
| `ice_servers` | STUN (and TURN when available) |

### 5. Open the app

```
http://localhost/connectmeet/
```

Health check:

```
http://localhost/connectmeet/api/health.php
```

### 6. Test media

- Localhost is treated as a **secure context**, so `getUserMedia` usually works.
- Accessing by LAN IP over plain HTTP (`http://192.168.x.x/...`) often **blocks** camera/microphone. Use HTTPS or tunnel (e.g. reverse proxy with TLS) for remote devices.
- Allow camera/mic permissions when prompted.

### 7. Two-participant test

1. Browser A: Start Instant Meeting → copy code/link.
2. Browser B (another profile or private window): Join with the code.
3. Confirm remote video/audio when the network permits a WebRTC path.

### Optional cleanup cron

```bat
php C:\xampp\htdocs\connectmeet\scripts\cleanup.php
```

Schedule every 5–15 minutes. Debug-only web trigger: `/scripts/cleanup.php?key=local-cleanup` (disabled when `debug` is false).

---

## cPanel / shared hosting

1. Create a MySQL database and user; grant all privileges on that database.
2. Upload project files to `public_html/connectmeet/` (or your chosen subdirectory).
3. Import `database/install.sql` via phpMyAdmin.
4. Copy and edit `config/config.php` with cPanel DB credentials.
5. Set `app.base_url` to your HTTPS URL, e.g. `https://example.com/connectmeet`.
6. Set `app.env` to `production`, `app.debug` to `false`, `session_secure_cookie` to `true`.
7. Restrict CORS origins in `security.cors_origins` to your real origin(s). **Do not** use `Access-Control-Allow-Origin: *` with credentialed meeting APIs.
8. Ensure HTTPS is enabled (Let's Encrypt / AutoSSL).
9. File permissions: directories `755`, PHP files `644`; `storage/logs` writable by the web user if logging is enabled.
10. Add a cron job for `php /home/USER/public_html/connectmeet/scripts/cleanup.php`.

### Shared hosting limitations

- No WebSocket daemon, no built-in media relay, no SFU.
- PHP short polling works but is less efficient than WebSockets.
- Many participants behind strict firewalls will need an external **TURN** server.
- Large meetings need an external **SFU** (LiveKit, mediasoup, Janus, etc.) — document as a future upgrade; do not expect PHP alone to scale media.

---

## STUN / TURN configuration

Edit `ice_servers` in `config/config.php`:

```php
'ice_servers' => [
    ['urls' => 'stun:stun.l.google.com:19302'],
    [
        'urls' => 'turn:turn.example.com:3478',
        'username' => 'user',
        'credential' => 'pass',
    ],
],
```

| Scenario | Likely need |
|----------|-------------|
| Two browsers on same LAN / simple home NAT | STUN often enough |
| Mobile data ↔ corporate Wi‑Fi | TURN usually required |
| Symmetric NAT / strict firewall | TURN required |
| Many participants / bandwidth | SFU + TURN |

Options for TURN: coturn (self-hosted), Twilio Network Traversal, Cloudflare Calls, Metered, etc.

---

## Troubleshooting

| Symptom | What to check |
|---------|----------------|
| Blank page / 500 | PHP error log; missing `config.php`; DB credentials |
| Health API database false | MySQL running; DB name/user/pass; `pdo_mysql` enabled |
| CSRF errors | Cookies enabled; same site origin; refresh page |
| Meeting not found | Code typos; expired meeting; cleanup ran |
| No camera on LAN HTTP | Use HTTPS or localhost |
| Local video OK, remote black | ICE failed → configure TURN; check browser console WebRTC |
| Chat works, A/V does not | Signaling OK; media path blocked — TURN |
| High CPU with many peers | Expected for mesh; reduce participant limit |

---

## Browser notes

- **Captions:** Chrome/Edge Web Speech API; captions apply to the **local** microphone only in this architecture.
- **Recording:** MediaRecorder captures a **local browser mix**, not a server-side composite of all participants.
- **Audio output selection:** requires `HTMLMediaElement.setSinkId()` (Chromium); gracefully hidden when unavailable.
