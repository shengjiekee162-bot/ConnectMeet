<?php
declare(strict_types=1);
require_once __DIR__ . '/includes/bootstrap.php';
$appName = $GLOBALS['cm_config']['app']['name'] ?? 'ConnectMeet';
$csrf = cm_csrf_token();
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="description" content="ConnectMeet — web-based video meetings with WebRTC.">
  <title><?= htmlspecialchars($appName, ENT_QUOTES, 'UTF-8') ?> — Video Meetings</title>
  <link rel="icon" href="assets/images/logo.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css" integrity="sha512-SnH5WK+bZxgPHs44uWIX+LLJAJ9/2PkPKZ5QiAj6Ta86w+fsb2TkcmfRyVX3pBnMFcV7oQPJkl9QevSCWr3W6A==" crossorigin="anonymous" referrerpolicy="no-referrer">
  <link rel="stylesheet" href="assets/css/style.css">
  <link rel="stylesheet" href="assets/css/responsive.css">
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <div id="toastHost" aria-live="polite"></div>

  <header class="site-header">
    <div class="brand">
      <div class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 64 64" fill="none"><circle cx="22" cy="28" r="8" fill="#042f2e"/><circle cx="42" cy="28" r="8" fill="#042f2e"/><path d="M18 42c2.5-6 7-9 14-9s11.5 3 14 9" stroke="#042f2e" stroke-width="4" stroke-linecap="round"/></svg>
      </div>
      <div>
        <div class="brand-name"><?= htmlspecialchars($appName, ENT_QUOTES, 'UTF-8') ?></div>
        <span class="brand-tag">Meet. Share. Connect.</span>
      </div>
    </div>
    <div class="header-actions">
      <div class="local-time" id="localTime" aria-live="off">—</div>
      <button type="button" class="btn-ghost" id="btnOpenSettingsHome"><i class="fa-solid fa-sliders"></i> Settings</button>
      <button type="button" class="btn-ghost" id="btnShortcuts"><i class="fa-solid fa-keyboard"></i></button>
      <button type="button" class="btn-ghost" id="btnHelp"><i class="fa-solid fa-circle-question"></i> Help</button>
    </div>
  </header>

  <main id="main" class="hero">
    <section class="hero-copy">
      <h1><?= htmlspecialchars($appName, ENT_QUOTES, 'UTF-8') ?></h1>
      <p>Start an instant video meeting or join with a code. Peer-to-peer WebRTC, chat, screen share, and more — built for small rooms and learning environments.</p>
      <p id="appReady" hidden style="color:var(--ok);font-size:0.9rem;"><i class="fa-solid fa-circle-check"></i> Ready</p>
    </section>

    <aside class="hero-panel">
      <div class="hero-visual" aria-hidden="true">
        <div class="hero-orb"></div>
        <div class="hero-orb alt"></div>
      </div>

      <div class="panel" style="margin-top:1rem;">
        <h2>Your name</h2>
        <div class="field">
          <label for="homeDisplayName">Display name</label>
          <input id="homeDisplayName" maxlength="60" placeholder="e.g. Alex Chen" autocomplete="nickname">
        </div>

        <div class="actions-row">
          <button type="button" class="btn btn-primary" id="btnInstant">
            <i class="fa-solid fa-video"></i> Start Instant Meeting
          </button>
          <button type="button" class="btn btn-secondary" id="btnLater">
            <i class="fa-solid fa-calendar-plus"></i> Create Meeting for Later
          </button>
        </div>

        <div id="createdCard" class="created-card" hidden>
          <div style="color:var(--text-muted);font-size:0.85rem;">Share this meeting</div>
          <div class="created-code" id="createdCode">—</div>
          <div class="field">
            <label for="createdLink">Invitation link</label>
            <input id="createdLink" readonly>
          </div>
          <button type="button" class="btn btn-secondary" id="btnCopyCreated"><i class="fa-solid fa-link"></i> Copy link</button>
        </div>
      </div>

      <div class="panel" style="margin-top:1rem;">
        <h2>Join a meeting</h2>
        <form id="joinForm">
          <div class="field">
            <label for="meetingCodeInput">Meeting code</label>
            <div class="join-row">
              <input id="meetingCodeInput" name="meeting" placeholder="123-456-789" inputmode="numeric" autocomplete="off" maxlength="11" required>
              <button type="submit" class="btn btn-primary">Join</button>
            </div>
          </div>
        </form>
      </div>
    </aside>
  </main>

  <footer class="home-footer">
    <span>© <?= date('Y') ?> <?= htmlspecialchars($appName, ENT_QUOTES, 'UTF-8') ?>. Independent project — not affiliated with Google or other providers.</span>
    <span>Prototype mesh WebRTC · PHP signaling</span>
  </footer>

  <div class="modal" id="helpModal" hidden>
    <div class="modal-card">
      <h3>Help</h3>
      <p>Use <strong>Start Instant Meeting</strong> to create a room and enter immediately. Share the meeting code or link so others can join.</p>
      <p>Camera and microphone require a secure context (localhost or HTTPS). On restrictive networks you may need a TURN server — see INSTALLATION.md.</p>
      <p>This prototype uses a peer-to-peer mesh. Keep rooms small (default limit 8).</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-close-modal>Close</button>
      </div>
    </div>
  </div>

  <div class="modal" id="shortcutsModal" hidden>
    <div class="modal-card">
      <h3>Keyboard shortcuts</h3>
      <ul>
        <li><strong>M</strong> — Mute / unmute microphone</li>
        <li><strong>V</strong> — Camera on / off</li>
        <li><strong>C</strong> — Toggle chat</li>
        <li><strong>P</strong> — Toggle participants</li>
        <li><strong>Esc</strong> — Leave meeting</li>
      </ul>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-close-modal>Close</button>
      </div>
    </div>
  </div>

  <div class="modal" id="homeSettingsModal" hidden>
    <div class="modal-card">
      <h3>Device preferences</h3>
      <p style="color:var(--text-muted);font-size:0.9rem;">Saved only in this browser. Grant media permission to see device labels.</p>
      <div class="field">
        <label for="homeMic">Microphone</label>
        <select id="homeMic"></select>
      </div>
      <div class="field">
        <label for="homeCam">Camera</label>
        <select id="homeCam"></select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="btnRequestMedia">Allow camera/mic</button>
        <button type="button" class="btn btn-secondary" data-close-modal>Cancel</button>
        <button type="button" class="btn btn-primary" id="homeSettingsSave">Save</button>
      </div>
    </div>
  </div>

  <script>window.CM_CSRF = <?= json_encode($csrf, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>;</script>
  <script src="assets/js/settings.js"></script>
  <script src="assets/js/signaling.js"></script>
  <script src="assets/js/app.js"></script>
</body>
</html>
