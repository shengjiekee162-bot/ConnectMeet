# ConnectMeet Architecture

## Goals

Deliver a maintainable PHP + vanilla JS prototype that establishes **real** WebRTC sessions between browsers, with durable meeting membership in MySQL and HTTP-based signaling suitable for shared hosting.

## Components

| Path | Role |
|------|------|
| `index.php` | Landing: create/join, clock, settings, help |
| `room.php` | Lobby + in-meeting UI shell |
| `api/*.php` | JSON APIs for meetings, participants, signaling, events, chat, health |
| `assets/js/webrtc.js` | `RTCPeerConnection` mesh, media, screen share |
| `assets/js/signaling.js` | Polling client, CSRF + participant token headers |
| `assets/js/meeting.js` | Room lifecycle, UI bindings, chat/reactions/captions/recording |
| `scripts/cleanup.php` | Expire meetings, prune stale participants and signals |

## Meeting lifecycle

1. **Create** — cryptographically random meeting code; store `host_token_hash`; instant mode also inserts the host participant and returns a participant token.
2. **Join** — validate code, expiry, lock, capacity; insert participant with hashed token; emit `participant_joined`.
3. **Heartbeat / poll** — refresh `last_seen_at`; deliver events and WebRTC signals.
4. **Leave** — set `left_at`, delete pending signals, emit leave event.
5. **End (host)** — meeting `status = ended`; all participants marked left.
6. **Cleanup** — timeout silent disconnects; expire meetings past `expires_at`.

## WebRTC mesh

- Each peer may connect to every other peer (`n×(n-1)` directed signaling paths; roughly `n(n-1)/2` media relationships).
- Negotiation uses a polite/impolite pattern based on participant ID ordering to reduce glare.
- Screen share replaces the outbound video track via `replaceTrack`, then restores the camera track when stopped.
- ICE servers come from server config and are exposed in public bootstrap/join payloads (TURN credentials should be short-lived in production hardening).

## Signaling transport

Short polling (configurable interval, error backoff, single-flight guards):

- `POST /api/signaling.php?action=send|poll`
- `POST /api/events.php?action=poll`
- `POST /api/participants.php?action=heartbeat`

Long-poll timeout can be enabled in config (`polling.long_poll_timeout_seconds`) for fewer empty responses on shared hosting that allow longer PHP execution.

Transient SDP/ICE payloads live in `signaling_messages` and are marked delivered / deleted quickly — they are not treated as permanent history.

## Security model

- **Participant token** (random, shown once) → SHA-256 stored; required on protected APIs via `X-Participant-Token`.
- **Host token** (create response) → used only to reclaim host seat if no host is present; does not bypass membership for arbitrary meetings.
- **CSRF** session token on state-changing requests.
- **Rate limits** per IP for create/join/chat/signal/events.
- Prepared statements everywhere; chat stripped of tags; HTML escaped in the UI.
- Config/includes/storage blocked from direct HTTP access via `.htaccess`.

## Known limitations

1. Mesh does not scale to large meetings.
2. No SFU / MCU; no server-side recording composite.
3. Captions only cover local speech via browser APIs — remote audio is not sent to a speech service.
4. Polling adds latency versus WebSockets.
5. Without TURN, some networks cannot establish media even when signaling succeeds.
6. Guest mode only — optional full user accounts table exists but login UI is not required for the prototype.

## Recommended future upgrades

1. External TURN (coturn or managed).
2. WebSocket signaling (Node/Go/Ratchet) or SSE.
3. SFU (LiveKit, mediasoup, Janus, Ion).
4. Short-lived TURN REST credentials.
5. Optional waiting-room admission UI (schema flag already present).
6. Persistent registered users and calendar integrations.
