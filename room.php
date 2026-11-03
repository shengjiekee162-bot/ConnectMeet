<?php
declare(strict_types=1);
require_once __DIR__ . '/includes/bootstrap.php';
$appName = $GLOBALS['cm_config']['app']['name'] ?? 'ConnectMeet';
$csrf = cm_csrf_token();
$meeting = isset($_GET['meeting']) ? cm_normalize_meeting_code((string) $_GET['meeting']) : '';
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Meeting — <?= htmlspecialchars($appName, ENT_QUOTES, 'UTF-8') ?></title>
  <link rel="icon" href="assets/images/logo.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css" integrity="sha512-SnH5WK+bZxgPHs44uWIX+LLJAJ9/2PkPKZ5QiAj6Ta86w+fsb2TkcmfRyVX3pBnMFcV7oQPJkl9QevSCWr3W6A==" crossorigin="anonymous" referrerpolicy="no-referrer">
  <link rel="stylesheet" href="assets/css/style.css">
  <link rel="stylesheet" href="assets/css/responsive.css">
</head>
<body>
  <div id="toastHost" aria-live="polite"></div>

  <!-- Lobby -->
  <section id="lobbyView" class="lobby-shell" hidden>
    <div class="lobby-card">
      <div>
        <div class="preview-wrap">
          <video id="lobbyVideo" autoplay playsinline muted></video>
          <div class="lobby-avatar" id="lobbyAvatar" hidden>?</div>
          <div class="lobby-controls">
            <button type="button" class="btn-icon" id="toggleLobbyMic" aria-label="Toggle microphone" aria-pressed="true"><i class="fa-solid fa-microphone"></i></button>
            <button type="button" class="btn-icon" id="toggleLobbyCam" aria-label="Toggle camera" aria-pressed="true"><i class="fa-solid fa-video"></i></button>
          </div>
        </div>
        <canvas id="micMeter" class="mic-meter" width="320" height="8" aria-hidden="true"></canvas>
      </div>
      <div>
        <div class="brand" style="margin-bottom:1rem;">
          <div class="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 64 64" fill="none"><circle cx="22" cy="28" r="8" fill="#042f2e"/><circle cx="42" cy="28" r="8" fill="#042f2e"/><path d="M18 42c2.5-6 7-9 14-9s11.5 3 14 9" stroke="#042f2e" stroke-width="4" stroke-linecap="round"/></svg>
          </div>
          <div>
            <div class="brand-name"><?= htmlspecialchars($appName, ENT_QUOTES, 'UTF-8') ?></div>
            <span class="brand-tag">Ready to join</span>
          </div>
        </div>
        <h2 id="lobbyTitle" style="margin:0 0 0.35rem;font-family:var(--font-display);">Meeting</h2>
        <div style="color:var(--text-muted);margin-bottom:0.75rem;">Code: <strong id="lobbyCode"><?= htmlspecialchars($meeting, ENT_QUOTES, 'UTF-8') ?></strong></div>
        <p id="lobbyMeta" style="color:var(--text-muted);font-size:0.9rem;"></p>

        <div class="field">
          <label for="displayName">Display name</label>
          <input id="displayName" maxlength="60" placeholder="Your name" required>
        </div>
        <div class="field">
          <label for="lobbyMicSelect">Microphone</label>
          <select id="lobbyMicSelect"></select>
        </div>
        <div class="field">
          <label for="lobbyCamSelect">Camera</label>
          <select id="lobbyCamSelect"></select>
        </div>
        <button type="button" class="btn btn-primary" id="joinNowBtn" style="width:100%;">
          <i class="fa-solid fa-right-to-bracket"></i> Join Now
        </button>
        <p style="color:var(--text-muted);font-size:0.8rem;margin-top:0.85rem;">If camera access fails, you can continue with audio only or without media.</p>
      </div>
    </div>
  </section>

  <!-- In-meeting -->
  <section id="roomView" class="room" hidden>
    <header class="room-top">
      <div class="room-top-left">
        <div class="brand-mark" style="width:36px;height:36px;border-radius:10px;" aria-hidden="true">
          <svg viewBox="0 0 64 64" fill="none" width="20" height="20"><circle cx="22" cy="28" r="8" fill="#042f2e"/><circle cx="42" cy="28" r="8" fill="#042f2e"/></svg>
        </div>
        <div style="min-width:0;">
          <div class="room-title" id="meetingTitleLabel">ConnectMeet Meeting</div>
          <div class="room-code">Code: <span id="meetingCodeLabel">—</span> · <span id="participantCount">1</span> people · <span id="connStatus" data-level="ok">Connecting…</span></div>
        </div>
        <span class="badge lock" id="lockBadge" hidden><i class="fa-solid fa-lock"></i> Locked</span>
        <span class="badge record" id="recordBadge" hidden><i class="fa-solid fa-circle"></i> REC</span>
      </div>
      <div class="header-actions">
        <button type="button" class="btn-ghost" id="btnInfo"><i class="fa-solid fa-circle-info"></i> Info</button>
        <button type="button" class="btn-ghost" data-host-only hidden id="btnLock"><i class="fa-solid fa-lock"></i> Lock</button>
        <button type="button" class="btn-ghost" data-host-only hidden id="btnEndMeeting"><i class="fa-solid fa-phone-slash"></i> End for all</button>
      </div>
    </header>

    <div class="room-main">
      <div id="videoGrid" class="video-grid" data-count="1"></div>
      <div id="reactionStage"></div>
      <!-- Local camera always docks at the bottom when the lens is on -->
      <div id="localCamDock" class="local-cam-dock" hidden>
        <video id="localCamDockVideo" autoplay playsinline muted></video>
        <div class="local-cam-dock-label"><i class="fa-solid fa-video"></i> Camera</div>
      </div>
      <div id="panel-captions" class="captions-panel" hidden>
        <div id="captionText">Captions will appear here…</div>
      </div>

      <aside id="panel-chat" class="side-panel" hidden>
        <div class="panel-head">
          <strong>Chat</strong>
          <button type="button" class="btn-ghost" id="closeChat" aria-label="Close chat"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="panel-body" id="chatMessages"></div>
        <div class="panel-foot">
          <form id="chatForm" class="chat-compose" action="javascript:void(0)" onsubmit="return false;">
            <input id="chatInput" maxlength="500" placeholder="Type a message…" autocomplete="off" enterkeyhint="send">
            <button type="button" class="btn btn-primary" id="chatSendBtn">Send</button>
          </form>
        </div>
      </aside>

      <aside id="panel-people" class="side-panel" hidden>
        <div class="panel-head">
          <strong>Participants</strong>
          <button type="button" class="btn-ghost" id="closePeople" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="panel-body">
          <ul id="peopleList" style="margin:0;padding:0;"></ul>
        </div>
      </aside>

      <aside id="panel-info" class="side-panel" hidden>
        <div class="panel-head">
          <strong>Meeting details</strong>
          <button type="button" class="btn-ghost" id="closeInfo" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="panel-body">
          <div class="field">
            <label>Meeting code</label>
            <div id="infoCode" class="created-code" style="font-size:1.3rem;">—</div>
          </div>
          <div class="field">
            <label for="infoLink">Invite link</label>
            <input id="infoLink" readonly>
          </div>
          <button type="button" class="btn btn-secondary" id="btnCopyLink"><i class="fa-solid fa-copy"></i> Copy link</button>
          <p style="color:var(--text-muted);font-size:0.85rem;margin-top:1rem;">Mesh WebRTC: each participant connects directly to others. For larger meetings or strict NATs, configure TURN or an SFU (see docs).</p>
        </div>
      </aside>
    </div>

    <footer class="room-bottom">
      <div class="reactions-bar" aria-label="Reactions">
        <button type="button" data-reaction="👍" title="Thumbs up">👍</button>
        <button type="button" data-reaction="👏" title="Clap">👏</button>
        <button type="button" data-reaction="❤️" title="Heart">❤️</button>
        <button type="button" data-reaction="😂" title="Laugh">😂</button>
        <button type="button" data-reaction="🎉" title="Celebrate">🎉</button>
      </div>
      <button type="button" class="btn-icon" id="btnMic" title="Microphone (M)" aria-label="Toggle microphone"><i class="fa-solid fa-microphone"></i></button>
      <button type="button" class="btn-icon" id="btnCam" title="Camera (V)" aria-label="Toggle camera"><i class="fa-solid fa-video"></i></button>
      <button type="button" class="btn-icon" id="btnShare" title="Share screen" aria-label="Share screen"><i class="fa-solid fa-desktop"></i></button>
      <button type="button" class="btn-icon" id="btnHand" title="Raise hand" aria-label="Raise hand"><i class="fa-solid fa-hand"></i></button>
      <button type="button" class="btn-icon" id="btnChat" title="Chat (C)" aria-label="Chat"><i class="fa-solid fa-comment"></i></button>
      <button type="button" class="btn-icon" id="btnPeople" title="Participants (P)" aria-label="Participants"><i class="fa-solid fa-users"></i></button>
      <button type="button" class="btn-icon" id="btnCaptions" title="Captions" aria-label="Captions"><i class="fa-solid fa-closed-captioning"></i></button>
      <button type="button" class="btn-icon" id="btnRecord" title="Local recording" aria-label="Record"><i class="fa-solid fa-record-vinyl"></i></button>
      <button type="button" class="btn-icon" id="btnSettings" title="Settings" aria-label="Settings"><i class="fa-solid fa-gear"></i></button>
      <button type="button" class="btn-icon leave" id="btnLeave" title="Leave (Esc)" aria-label="Leave meeting"><i class="fa-solid fa-phone"></i></button>
    </footer>
  </section>

  <div class="modal" id="settingsModal" hidden>
    <div class="modal-card">
      <h3>Settings</h3>
      <form id="settingsForm">
        <div class="field">
          <label for="settingsName">Display name (local preference)</label>
          <input id="settingsName" maxlength="60">
        </div>
        <div class="field">
          <label for="settingsMic">Microphone</label>
          <select id="settingsMic"></select>
        </div>
        <div class="field">
          <label for="settingsCam">Camera</label>
          <select id="settingsCam"></select>
        </div>
        <div class="field" id="outputDeviceWrap">
          <label for="settingsOutput">Speaker / output</label>
          <select id="settingsOutput"></select>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="btnSpeakerTest">Test speaker</button>
          <button type="button" class="btn btn-secondary" id="closeSettings">Cancel</button>
          <button type="submit" class="btn btn-primary">Apply</button>
        </div>
      </form>
    </div>
  </div>

  <script>window.CM_CSRF = <?= json_encode($csrf, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>;</script>
  <script src="assets/js/settings.js"></script>
  <script src="assets/js/signaling.js"></script>
  <script src="assets/js/webrtc.js"></script>
  <script src="assets/js/meeting.js"></script>
  <script>
    document.addEventListener('DOMContentLoaded', function () {
      ConnectMeetMeeting.init();
    });
  </script>
</body>
</html>
