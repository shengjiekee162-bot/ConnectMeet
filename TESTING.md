# ConnectMeet Testing Checklist & Report

Date: 2026-10-20  
Environment: Windows, PHP 8.4, MySQL 8.0, project path `C:\xampp\htdocs\connectmeet`  
Automated API tests run via PHP built-in server (`php -S localhost:8080`) when Apache was not listening on port 80.

## Checklist

| # | Test | Result | Notes |
|---|------|--------|-------|
| 1 | Landing page loads without PHP errors | PASS | `index.php` syntax + HTTP check |
| 2 | Meeting creation generates unique code | PASS | API create returns formatted code |
| 3 | Invalid meeting codes rejected | PASS | validate returns 404 |
| 4 | Two browser sessions can join same room | MANUAL | Requires two profiles/windows |
| 5 | Local camera/microphone permissions | MANUAL | Browser permission prompt |
| 6 | Remote A/V via WebRTC | MANUAL / NETWORK | Needs 2 clients; may need TURN |
| 7 | Mute sync | MANUAL | Via `update_media` + events |
| 8 | Camera on/off sync | MANUAL | Via `update_media` + events |
| 9 | Screen share start/stop | MANUAL | Chromium `getDisplayMedia` |
| 10 | Chat reaches other participants | PASS (API) | send + poll; UI MANUAL |
| 11 | Raised-hand sync | PASS (API) | hand endpoint + events |
| 12 | Participants appear/disappear | PASS (API) | join/leave/list |
| 13 | Leave releases media | MANUAL | JS `closeAll` on leave |
| 14 | Network interruption status | MANUAL | UI status + backoff |
| 15 | Unauthorized host actions rejected | PASS | non-host end → 403 |
| 16 | Malicious HTML in chat escaped | PASS | stored stripped; UI uses `escapeHtml` |
| 17 | Cleanup expired/stale | PASS | `scripts/cleanup.php` runs |
| 18 | Responsive layouts | MANUAL | CSS breakpoints present |
| 19 | Browser limitations reported | PASS | captions/record/share feature-detect |

**Legend:** PASS = automated/verified in this environment · MANUAL = needs human/browser · NETWORK = depends on ICE/TURN.

## Automated checks run during build

- PHP lint on all `*.php` files
- Database import of `install.sql`
- `GET api/health.php`
- Create meeting → validate → join second participant → chat → hand → leave
- Reject unknown meeting code
- Reject host-only action from participant

## Not fully verifiable without extra setup

- Cross-machine WebRTC with restrictive NATs (needs TURN + HTTPS)
- Safari-specific quirks
- Production cPanel deployment
- Load behavior beyond the configured participant limit
