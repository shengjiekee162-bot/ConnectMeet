/**
 * ConnectMeet in-meeting controller: lobby + room UI, chat, reactions, captions, recording.
 */
(function (global) {
  'use strict';

  function $(sel, root = document) { return root.querySelector(sel); }
  function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
    return parts.map((p) => p.charAt(0).toUpperCase()).join('') || '?';
  }

  function toast(message, type = 'info') {
    const host = $('#toastHost') || document.body;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 3200);
  }

  const MeetingApp = {
    config: null,
    signaling: null,
    webrtc: null,
    meetingCode: '',
    self: null,
    hostToken: '',
    participants: [],
    remoteStreams: new Map(),
    media: { audio: true, video: true },
    lobbyStream: null,
    meter: null,
    recognition: null,
    recorder: null,
    recordedChunks: [],
    recording: false,
    handRaised: false,
    panels: { chat: false, people: false, info: false, captions: false },
    left: false,

    async init() {
      const params = new URLSearchParams(location.search);
      const readStore = (key) => {
        try {
          return sessionStorage.getItem(key) || localStorage.getItem(key) || '';
        } catch (_) {
          try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
        }
      };
      this.meetingCode = params.get('meeting') || readStore('cm_pending_code') || '';
      this.hostToken = readStore('cm_host_token') || '';

      const prefs = ConnectMeetSettings.load();
      const nameInput = $('#displayName');
      if (nameInput && prefs.displayName) nameInput.value = prefs.displayName;

      this.signaling = new ConnectMeetSignaling({
        baseUrl: this._baseUrl(),
      });

      try {
        this.config = await this.signaling.bootstrap();
      } catch (err) {
        toast('Unable to reach server: ' + err.message, 'error');
        return;
      }

      if (this.hostToken) {
        this.signaling.setTokens({ hostToken: this.hostToken });
      }

      // Resume existing session if host created instant meeting
      const saved = this._loadSession();
      if (saved && saved.meetingCode === this.meetingCode && saved.token) {
        this.self = { ...saved.self, token: saved.token };
        this.signaling.setTokens({
          participantToken: saved.token,
          hostToken: this.hostToken,
        });
        try {
          const info = await this.signaling.request('/api/meetings.php?action=info', {
            method: 'POST',
            body: {},
          });
          await this._enterRoom({
            title: info.data?.title,
            ice_servers: info.data?.ice_servers || this.config?.ice_servers,
            participants: info.data?.participants || [info.data?.self].filter(Boolean),
          });
          return;
        } catch (err) {
          console.warn('Session resume failed, showing lobby', err);
          this._clearSession();
          this.self = null;
          $('#roomView').hidden = true;
          document.body.classList.remove('in-meeting');
        }
      }

      if (!this.meetingCode) {
        toast('Missing meeting code.', 'error');
        setTimeout(() => { location.href = this._baseUrl() + '/index.php'; }, 1500);
        return;
      }

      // Always keep room shell hidden until join succeeds
      const roomView = $('#roomView');
      if (roomView) roomView.hidden = true;
      document.body.classList.remove('in-meeting');

      await this._validateAndShowLobby();
      this._bindLobby();
    },

    _baseUrl() {
      const path = location.pathname.replace(/\/[^/]*$/, '');
      return path || '';
    },

    _saveSession() {
      if (!this.self) return;
      const payload = JSON.stringify({
        meetingCode: this.meetingCode,
        token: this.self.token,
        self: this.self,
      });
      try { sessionStorage.setItem('cm_session', payload); } catch (_) { /* ignore */ }
      try { localStorage.setItem('cm_session', payload); } catch (_) { /* ignore */ }
      if (this.hostToken) {
        try { sessionStorage.setItem('cm_host_token', this.hostToken); } catch (_) { /* ignore */ }
        try { localStorage.setItem('cm_host_token', this.hostToken); } catch (_) { /* ignore */ }
      }
    },

    _loadSession() {
      try {
        const raw = sessionStorage.getItem('cm_session') || localStorage.getItem('cm_session');
        return raw ? JSON.parse(raw) : null;
      } catch (_) {
        return null;
      }
    },

    _clearSession() {
      ['cm_session', 'cm_pending_code'].forEach((key) => {
        try { sessionStorage.removeItem(key); } catch (_) { /* ignore */ }
        try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
      });
    },

    async _validateAndShowLobby() {
      try {
        const res = await this.signaling.validateMeeting(this.meetingCode);
        const info = res.data;
        $('#lobbyTitle').textContent = info.title || 'ConnectMeet';
        $('#lobbyCode').textContent = info.meeting_code;
        $('#lobbyMeta').textContent = info.message || '';
        if (!info.joinable) {
          $('#joinNowBtn').disabled = true;
          toast(info.message || 'Cannot join this meeting.', 'warning');
        }
        $('#roomView').hidden = true;
        $('#lobbyView').hidden = false;
        await this._startLobbyPreview();
      } catch (err) {
        toast(err.message || 'Meeting not found.', 'error');
        $('#roomView').hidden = true;
        $('#lobbyView').hidden = false;
        $('#joinNowBtn').disabled = true;
        $('#lobbyMeta').textContent = err.message || 'Invalid meeting';
      }
    },

    async _startLobbyPreview() {
      const prefs = ConnectMeetSettings.load();
      const video = $('#lobbyVideo');
      try {
        this.lobbyStream = await navigator.mediaDevices.getUserMedia({
          audio: prefs.audioDeviceId
            ? { deviceId: { exact: prefs.audioDeviceId } }
            : true,
          video: prefs.videoDeviceId
            ? { deviceId: { exact: prefs.videoDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
            : { width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (video) {
          video.srcObject = this.lobbyStream;
          video.muted = true;
          await video.play().catch(() => {});
        }
        this.media.audio = true;
        this.media.video = true;
        this._updateLobbyButtons();
        if (this.meter) this.meter.stop();
        this.meter = ConnectMeetSettings.createMeter(this.lobbyStream, $('#micMeter'));
        await this._refreshDeviceSelects();
      } catch (err) {
        console.warn(err);
        toast(this._mediaErrorMessage(err), 'warning');
        this.media.video = false;
        try {
          this.lobbyStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          this.media.audio = true;
          if (this.meter) this.meter.stop();
          this.meter = ConnectMeetSettings.createMeter(this.lobbyStream, $('#micMeter'));
          toast('Joining with audio only is available.', 'info');
        } catch (audioErr) {
          this.lobbyStream = null;
          this.media.audio = false;
          this.media.video = false;
          toast('No camera/microphone access. You can still join without media.', 'warning');
        }
        const video = $('#lobbyVideo');
        const avatar = $('#lobbyAvatar');
        if (video) video.hidden = !this.media.video;
        if (avatar) {
          avatar.hidden = this.media.video;
          avatar.textContent = initials($('#displayName')?.value || 'You');
        }
        this._updateLobbyButtons();
        await this._refreshDeviceSelects();
      }
    },

    _mediaErrorMessage(err) {
      const name = err?.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        return 'Camera/microphone permission denied. Check browser site settings.';
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        return 'No camera or microphone was found.';
      }
      if (name === 'NotReadableError' || name === 'TrackStartError') {
        return 'Device is in use by another application.';
      }
      return err?.message || 'Unable to access media devices.';
    },

    async _refreshDeviceSelects() {
      const devices = await ConnectMeetSettings.enumerate();
      const prefs = ConnectMeetSettings.load();
      ConnectMeetSettings.fillSelect($('#lobbyMicSelect'), devices.audioInputs, prefs.audioDeviceId);
      ConnectMeetSettings.fillSelect($('#lobbyCamSelect'), devices.videoInputs, prefs.videoDeviceId);
      ConnectMeetSettings.fillSelect($('#settingsMic'), devices.audioInputs, prefs.audioDeviceId);
      ConnectMeetSettings.fillSelect($('#settingsCam'), devices.videoInputs, prefs.videoDeviceId);
      ConnectMeetSettings.fillSelect($('#settingsOutput'), devices.audioOutputs, prefs.outputDeviceId);
      const sinkSupported = typeof HTMLMediaElement !== 'undefined'
        && typeof HTMLMediaElement.prototype.setSinkId === 'function';
      const outWrap = $('#outputDeviceWrap');
      if (outWrap) outWrap.hidden = !sinkSupported;
    },

    _bindLobby() {
      $('#toggleLobbyMic')?.addEventListener('click', () => {
        this.media.audio = !this.media.audio;
        this.lobbyStream?.getAudioTracks().forEach((t) => { t.enabled = this.media.audio; });
        this._updateLobbyButtons();
      });
      $('#toggleLobbyCam')?.addEventListener('click', () => {
        this.media.video = !this.media.video;
        this.lobbyStream?.getVideoTracks().forEach((t) => { t.enabled = this.media.video; });
        this._updateLobbyButtons();
        const video = $('#lobbyVideo');
        const avatar = $('#lobbyAvatar');
        if (video && avatar) {
          video.hidden = !this.media.video;
          avatar.hidden = this.media.video;
          avatar.textContent = initials($('#displayName')?.value || 'You');
        }
      });
      $('#joinNowBtn')?.addEventListener('click', () => this.joinNow());
      $('#lobbyMicSelect')?.addEventListener('change', async (e) => {
        ConnectMeetSettings.save({ audioDeviceId: e.target.value });
        await this._restartLobbyPreview();
      });
      $('#lobbyCamSelect')?.addEventListener('change', async (e) => {
        ConnectMeetSettings.save({ videoDeviceId: e.target.value });
        await this._restartLobbyPreview();
      });
      $('#displayName')?.addEventListener('change', (e) => {
        ConnectMeetSettings.save({ displayName: e.target.value.trim() });
      });
      navigator.mediaDevices?.addEventListener?.('devicechange', () => this._refreshDeviceSelects());
    },

    async _restartLobbyPreview() {
      this.lobbyStream?.getTracks().forEach((t) => t.stop());
      if (this.meter) this.meter.stop();
      await this._startLobbyPreview();
    },

    _updateLobbyButtons() {
      const mic = $('#toggleLobbyMic');
      const cam = $('#toggleLobbyCam');
      if (mic) {
        mic.classList.toggle('off', !this.media.audio);
        mic.setAttribute('aria-pressed', String(this.media.audio));
        mic.innerHTML = this.media.audio
          ? '<i class="fa-solid fa-microphone"></i>'
          : '<i class="fa-solid fa-microphone-slash"></i>';
      }
      if (cam) {
        cam.classList.toggle('off', !this.media.video);
        cam.setAttribute('aria-pressed', String(this.media.video));
        cam.innerHTML = this.media.video
          ? '<i class="fa-solid fa-video"></i>'
          : '<i class="fa-solid fa-video-slash"></i>';
      }
    },

    async joinNow() {
      const name = ($('#displayName')?.value || '').trim();
      if (!name) {
        toast('Enter a display name before joining.', 'warning');
        $('#displayName')?.focus();
        return;
      }
      ConnectMeetSettings.save({ displayName: name });
      const btn = $('#joinNowBtn');
      if (btn) btn.disabled = true;

      try {
        // Prefer resuming the existing seat so we don't create a second "self"
        const saved = this._loadSession();
        const existingToken = (saved && saved.meetingCode === this.meetingCode && saved.token)
          ? saved.token
          : (this.self?.token || '');

        const payload = {
          meeting_code: this.meetingCode,
          display_name: name,
          audio_enabled: this.media.audio,
          video_enabled: this.media.video,
        };
        if (existingToken) {
          payload.participant_token = existingToken;
        }

        const res = await this.signaling.joinMeeting(payload);
        const data = res.data;
        this.self = { ...data.participant, token: data.participant.token };
        this.meetingCode = data.meeting_code;
        this.signaling.setTokens({
          participantToken: this.self.token,
          hostToken: this.hostToken,
        });
        this._saveSession();
        await this._enterRoom(data);
      } catch (err) {
        toast(err.message || 'Unable to join.', 'error');
        if (btn) btn.disabled = false;
      }
    },

    async _enterRoom(joinData) {
      // Stop lobby preview tracks — WebRTC will acquire fresh media
      if (this.meter) this.meter.stop();
      this.lobbyStream?.getTracks().forEach((t) => t.stop());
      this.lobbyStream = null;

      $('#lobbyView').hidden = true;
      $('#roomView').hidden = false;
      document.body.classList.add('in-meeting');

      $('#meetingCodeLabel').textContent = this.meetingCode;
      $('#meetingTitleLabel').textContent = joinData.title || 'ConnectMeet Meeting';

      // Bind UI first so chat/controls work even if camera permission is slow.
      this.participants = joinData.participants || [];
      this._bindRoomControls();
      this._bindSignalingEvents();
      this.signaling.start();
      this._setStatus('Connected', 'ok');
      $all('[data-host-only]').forEach((el) => {
        el.hidden = this.self?.role !== 'host';
      });
      this._renderParticipants();
      this._renderGrid();

      const prefs = ConnectMeetSettings.load();
      this.webrtc = new ConnectMeetWebRTC({
        iceServers: joinData.ice_servers || this.config?.ice_servers || [],
        selfId: this.self.id,
        sendSignal: (toId, type, payload) =>
          this.signaling.sendSignal(toId, type, payload).then(() => {}),
        onRemoteStream: (peerId, stream) => this._onRemoteStream(peerId, stream),
        onPeerState: (peerId, state) => this._onPeerState(peerId, state),
        onError: (err) => console.warn('WebRTC:', err),
      });

      try {
        // Always try to acquire tracks so mute/camera toggles work instantly later.
        await this.webrtc.getLocalMedia({
          audio: true,
          video: true,
          audioDeviceId: prefs.audioDeviceId || undefined,
          videoDeviceId: prefs.videoDeviceId || undefined,
        });
        this.webrtc.setAudioEnabled(this.media.audio);
        this.webrtc.setVideoEnabled(this.media.video);
        this._renderGrid();
      } catch (err) {
        toast(this._mediaErrorMessage(err), 'warning');
      }

      this.webrtc.onSpeakingChange((speaking) => {
        const tile = $(`#tile-${this.self.id}`);
        tile?.classList.toggle('speaking', speaking);
      });
    },

    _bindSignalingEvents() {
      if (this._signalingBound) return;
      this._signalingBound = true;

      this.signaling.on('participants', (list) => {
        this.participants = list || [];
        this._renderParticipants();
        this._renderGrid();
        const ids = this.participants.map((p) => p.id);
        this.webrtc?.syncPeers(ids);
      });

      this.signaling.on('signal', (signal) => {
        this.webrtc?.handleSignal(signal);
      });

      this.signaling.on('chat_message', (ev) => {
        this._appendChat(ev.payload || {});
      });

      this.signaling.on('reaction', (ev) => {
        this._showReaction(ev.payload || {});
      });

      this.signaling.on('hand_state', (ev) => {
        const p = ev.payload || {};
        const person = this.participants.find((x) => x.id === p.participant_id);
        if (person) person.hand_raised = !!p.hand_raised;
        this._renderParticipants();
        this._renderGrid();
      });

      this.signaling.on('media_state', (ev) => {
        const p = ev.payload || {};
        const person = this.participants.find((x) => x.id === p.participant_id);
        if (person) {
          person.audio_enabled = !!p.audio_enabled;
          person.video_enabled = !!p.video_enabled;
          person.screen_sharing = !!p.screen_sharing;
        }
        this._renderParticipants();
        this._renderGrid();
      });

      this.signaling.on('meeting_ended', () => {
        toast('The host ended this meeting.', 'warning');
        this.leave({ silent: true, ended: true });
      });

      this.signaling.on('meeting_status', (info) => {
        if (info.status === 'ended' || info.status === 'expired') {
          toast('This meeting is no longer active.', 'warning');
          this.leave({ silent: true, ended: true });
        }
        const lockBadge = $('#lockBadge');
        if (lockBadge) lockBadge.hidden = !info.is_locked;
      });

      this.signaling.on('participant_removed', (ev) => {
        if (ev.payload?.participant_id === this.self?.id) {
          toast('You were removed from the meeting.', 'warning');
          this.leave({ silent: true, ended: true });
        }
      });

      this.signaling.on('kicked', (err) => {
        console.warn('kicked', err);
        toast((err && err.message) ? err.message : 'Your session ended.', 'warning');
        this.leave({ silent: true, ended: true });
      });

      this.signaling.on('error', (err) => {
        this._setStatus('Reconnecting…', 'warn');
        console.warn(err);
      });
    },

    _bindRoomControls() {
      if (this._controlsBound) return;
      this._controlsBound = true;

      $('#btnMic')?.addEventListener('click', () => this.toggleMic());
      $('#btnCam')?.addEventListener('click', () => this.toggleCam());
      $('#btnShare')?.addEventListener('click', () => this.toggleShare());
      $('#btnHand')?.addEventListener('click', () => this.toggleHand());
      $('#btnChat')?.addEventListener('click', () => this.togglePanel('chat'));
      $('#btnPeople')?.addEventListener('click', () => this.togglePanel('people'));
      $('#btnInfo')?.addEventListener('click', () => this.togglePanel('info'));
      $('#btnCaptions')?.addEventListener('click', () => this.toggleCaptions());
      $('#btnRecord')?.addEventListener('click', () => this.toggleRecord());
      $('#btnSettings')?.addEventListener('click', () => this.openSettings());
      $('#btnLeave')?.addEventListener('click', () => this.leave());
      $('#btnEndMeeting')?.addEventListener('click', () => this.endMeeting());
      $('#btnLock')?.addEventListener('click', () => this.toggleLock());
      $('#btnCopyLink')?.addEventListener('click', () => this.copyLink());

      const onChatSubmit = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.sendChat();
        return false;
      };
      $('#chatForm')?.addEventListener('submit', onChatSubmit);
      $('#chatSendBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.sendChat();
      });
      // Enter in chat input
      $('#chatInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendChat();
        }
      });

      $all('[data-reaction]').forEach((btn) => {
        btn.addEventListener('click', () => this.sendReaction(btn.getAttribute('data-reaction')));
      });
      $('#closeChat')?.addEventListener('click', () => this.togglePanel('chat', false));
      $('#closePeople')?.addEventListener('click', () => this.togglePanel('people', false));
      $('#closeInfo')?.addEventListener('click', () => this.togglePanel('info', false));
      $('#settingsForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        this.applySettings();
      });
      $('#closeSettings')?.addEventListener('click', () => {
        $('#settingsModal').hidden = true;
      });
      $('#btnSpeakerTest')?.addEventListener('click', async () => {
        try {
          await ConnectMeetSettings.speakerTest($('#settingsOutput')?.value || '');
        } catch (err) {
          toast(err.message, 'warning');
        }
      });

      document.addEventListener('keydown', (e) => {
        if (e.target.matches('input, textarea, select')) return;
        if (e.key === 'm' || e.key === 'M') this.toggleMic();
        if (e.key === 'v' || e.key === 'V') this.toggleCam();
        if (e.key === 'c' || e.key === 'C') this.togglePanel('chat');
        if (e.key === 'p' || e.key === 'P') this.togglePanel('people');
        if (e.key === 'Escape') this.leave();
      });

      window.addEventListener('beforeunload', () => {
        if (!this.left) {
          try {
            navigator.sendBeacon?.(
              this._baseUrl() + '/api/participants.php?action=leave',
              new Blob([JSON.stringify({
                csrf_token: this.signaling.csrfToken,
                participant_token: this.self?.token,
              })], { type: 'application/json' })
            );
          } catch (_) { /* ignore */ }
        }
      });
    },

    _onRemoteStream(peerId, stream) {
      this.remoteStreams.set(peerId, stream);
      this._renderGrid();
      const prefs = ConnectMeetSettings.load();
      const video = $(`#video-${peerId}`);
      if (video && prefs.outputDeviceId) {
        ConnectMeetSettings.applyOutput(video, prefs.outputDeviceId);
      }
    },

    _onPeerState(peerId, state) {
      const tile = $(`#tile-${peerId}`);
      if (tile) {
        tile.dataset.conn = state;
        tile.classList.toggle('conn-bad', state === 'failed' || state === 'disconnected');
      }
      if (state === 'connected') this._setStatus('Connected', 'ok');
      if (state === 'connecting' || state === 'checking') this._setStatus('Connecting peers…', 'warn');
      if (state === 'failed') this._setStatus('Peer connection failed — check network/TURN', 'error');
    },

    _renderGrid() {
      const grid = $('#videoGrid');
      if (!grid || !this.self) return;
      const count = Math.max(1, this.participants.length);
      grid.dataset.count = String(count);

      const existing = new Set($all('.video-tile', grid).map((el) => el.dataset.pid));
      const wanted = new Set(this.participants.map((p) => String(p.id)));

      // Remove stale tiles
      $all('.video-tile', grid).forEach((el) => {
        if (!wanted.has(el.dataset.pid)) el.remove();
      });

      this.participants.forEach((p) => {
        let tile = $(`#tile-${p.id}`);
        if (!tile) {
          tile = document.createElement('div');
          tile.className = 'video-tile';
          tile.id = `tile-${p.id}`;
          tile.dataset.pid = String(p.id);
          tile.innerHTML = `
            <video id="video-${p.id}" autoplay playsinline ${p.id === this.self.id ? 'muted' : ''}></video>
            <div class="tile-avatar" id="avatar-${p.id}">${escapeHtml(initials(p.display_name))}</div>
            <div class="tile-share-banner" id="sharePlaceholder-${p.id}" hidden></div>
            <div class="tile-meta">
              <span class="tile-name">${escapeHtml(p.display_name)}${p.id === this.self.id ? ' (You)' : ''}${p.role === 'host' ? ' · Host' : ''}</span>
              <span class="tile-flags">
                <i class="fa-solid fa-microphone-slash muted-icon" title="Muted"></i>
                <i class="fa-solid fa-hand hand-icon" title="Hand raised"></i>
                <i class="fa-solid fa-desktop share-icon" title="Sharing screen"></i>
              </span>
            </div>`;
          grid.appendChild(tile);
        }

        tile.classList.toggle('muted', !p.audio_enabled);
        tile.classList.toggle('cam-off', !p.video_enabled && !p.screen_sharing);
        tile.classList.toggle('hand-up', !!p.hand_raised);
        tile.classList.toggle('sharing', !!p.screen_sharing);
        tile.classList.toggle('local', p.id === this.self.id);

        const video = $(`#video-${p.id}`);
        const avatar = $(`#avatar-${p.id}`);
        let sharePh = $(`#sharePlaceholder-${p.id}`);
        const isSelf = p.id === this.self.id;
        const selfSharing = isSelf && this.webrtc?.isSharing();

        // Local: camera or screen-share preview. Remote: peer stream.
        // Screen-share preview is shown so you can verify what others see.
        // Tip: share a Window/Tab other than this meeting to avoid mirror loop.
        const stream = isSelf
          ? this.webrtc?.getLocalStream()
          : this.remoteStreams.get(p.id);

        if (video && stream && video.srcObject !== stream) {
          video.srcObject = stream;
          video.play().catch(() => {});
        }

        const showVideo = !!(
          stream
          && stream.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled)
          && (p.video_enabled || p.screen_sharing || selfSharing)
        );
        if (video) {
          video.hidden = !showVideo;
          // Don't mirror screen share (only mirror camera)
          video.classList.toggle('mirror', isSelf && !selfSharing);
        }
        if (avatar) {
          avatar.hidden = showVideo;
          avatar.textContent = initials(p.display_name);
        }
        if (sharePh) {
          // Only show banner overlay while sharing (does not replace the video)
          if (selfSharing) {
            if (!sharePh.isConnected) {
              sharePh = document.createElement('div');
              sharePh.className = 'tile-share-banner';
              sharePh.id = `sharePlaceholder-${p.id}`;
              sharePh.innerHTML = `<i class="fa-solid fa-desktop"></i> Sharing — if you see a mirror, share another window instead of this meeting.`;
              tile.appendChild(sharePh);
            } else {
              sharePh.className = 'tile-share-banner';
              sharePh.hidden = false;
              sharePh.innerHTML = `<i class="fa-solid fa-desktop"></i> Sharing — if you see a mirror, share another window instead of this meeting.`;
            }
          } else {
            sharePh.hidden = true;
          }
        } else if (selfSharing) {
          sharePh = document.createElement('div');
          sharePh.className = 'tile-share-banner';
          sharePh.id = `sharePlaceholder-${p.id}`;
          sharePh.innerHTML = `<i class="fa-solid fa-desktop"></i> Sharing — if you see a mirror, share another window instead of this meeting.`;
          tile.appendChild(sharePh);
        }
        tile.classList.toggle('self-sharing', !!selfSharing);
        const nameEl = tile.querySelector('.tile-name');
        if (nameEl) {
          const you = isSelf ? ' (You)' : '';
          const host = p.role === 'host' ? ' · Host' : '';
          const sharing = selfSharing ? ' · Sharing' : '';
          nameEl.textContent = `${p.display_name}${you}${host}${sharing}`;
        }
      });

      $('#participantCount').textContent = String(this.participants.length);
      this._updateLocalCamDock();
    },

    /**
     * Whenever the camera is on, always show a preview docked at the bottom.
     * While screen sharing: main tile = screen, bottom dock = camera.
     */
    _updateLocalCamDock() {
      const dock = $('#localCamDock');
      const dockVideo = $('#localCamDockVideo');
      if (!dock || !dockVideo || !this.webrtc) return;

      const camTrack = this.webrtc.localStream
        ?.getVideoTracks()
        .find((t) => t.readyState === 'live' && t.enabled);

      const show = !!(this.media.video && camTrack);
      dock.hidden = !show;
      if (!show) {
        dockVideo.srcObject = null;
        this._dockCamStream = null;
        return;
      }

      const current = dockVideo.srcObject?.getVideoTracks?.()[0];
      if (current !== camTrack) {
        this._dockCamStream = new MediaStream([camTrack]);
        dockVideo.srcObject = this._dockCamStream;
        dockVideo.play().catch(() => {});
      }
    },

    _renderParticipants() {
      const list = $('#peopleList');
      if (!list) return;
      list.innerHTML = this.participants.map((p) => `
        <li class="people-item">
          <div class="people-avatar">${escapeHtml(initials(p.display_name))}</div>
          <div class="people-info">
            <div class="people-name">${escapeHtml(p.display_name)}${p.id === this.self?.id ? ' (You)' : ''}</div>
            <div class="people-role">${p.role === 'host' ? 'Host' : 'Participant'}</div>
          </div>
          <div class="people-flags">
            ${p.hand_raised ? '<i class="fa-solid fa-hand"></i>' : ''}
            <i class="fa-solid ${p.audio_enabled ? 'fa-microphone' : 'fa-microphone-slash'}"></i>
            <i class="fa-solid ${p.video_enabled ? 'fa-video' : 'fa-video-slash'}"></i>
            ${this.self?.role === 'host' && p.role !== 'host' && p.id !== this.self?.id
              ? `<button type="button" class="btn-text danger" data-remove="${p.id}">Remove</button>`
              : ''}
          </div>
        </li>`).join('');

      $all('[data-remove]', list).forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await this.signaling.removeParticipant(Number(btn.getAttribute('data-remove')));
            toast('Participant removed.', 'info');
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      });
    },

    _syncSelfMedia(partial) {
      const me = this.participants.find((p) => p.id === this.self?.id);
      if (me) Object.assign(me, partial);
      this._renderGrid();
      this._renderParticipants();
    },

    _syncMediaInBackground(state) {
      this.signaling.updateMedia(state).catch((err) => {
        toast(err.message || 'Could not sync media state.', 'error');
      });
    },

    async toggleMic() {
      const btn = $('#btnMic');
      const turningOn = !this.media.audio;
      try {
        if (turningOn) {
          const prefs = ConnectMeetSettings.load();
          if (!this.webrtc?.hasLiveAudioTrack()) {
            await this.webrtc.ensureMicOn({ audioDeviceId: prefs.audioDeviceId || undefined });
          } else {
            this.webrtc.setAudioEnabled(true);
          }
          this.media.audio = true;
        } else {
          this.webrtc?.setAudioEnabled(false);
          this.media.audio = false;
        }
        btn?.classList.toggle('off', !this.media.audio);
        btn?.setAttribute('aria-pressed', String(this.media.audio));
        this._syncSelfMedia({ audio_enabled: this.media.audio });
        this._syncMediaInBackground({ audio_enabled: this.media.audio });
      } catch (err) {
        this.media.audio = false;
        btn?.classList.add('off');
        btn?.setAttribute('aria-pressed', 'false');
        toast(this._mediaErrorMessage(err), 'error');
      }
    },

    async toggleCam() {
      const btn = $('#btnCam');
      const turningOn = !this.media.video;
      if (btn) btn.disabled = true;
      try {
        if (turningOn) {
          const prefs = ConnectMeetSettings.load();
          await this.webrtc.ensureCameraOn({ videoDeviceId: prefs.videoDeviceId || undefined });
          this.media.video = true;
        } else {
          this.webrtc?.setVideoEnabled(false);
          this.media.video = false;
        }
        btn?.classList.toggle('off', !this.media.video);
        btn?.setAttribute('aria-pressed', String(this.media.video));
        this._syncSelfMedia({ video_enabled: this.media.video });
        this._syncMediaInBackground({ video_enabled: this.media.video });
        this._updateLocalCamDock();
      } catch (err) {
        this.media.video = false;
        btn?.classList.add('off');
        btn?.setAttribute('aria-pressed', 'false');
        this._updateLocalCamDock();
        toast(this._mediaErrorMessage(err), 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    },

    async toggleShare() {
      const btn = $('#btnShare');
      if (btn) btn.disabled = true;
      try {
        if (this.webrtc?.isSharing()) {
          await this.webrtc.stopScreenShare();
          btn?.classList.remove('active');
          this._syncSelfMedia({ screen_sharing: false });
          this._syncMediaInBackground({ screen_sharing: false });
          toast('Screen sharing stopped.', 'info');
        } else {
          toast('Tip: share a Window or another Tab — not this meeting screen (avoids the mirror effect).', 'info');
          await this.webrtc.startScreenShare();
          btn?.classList.add('active');
          this._syncSelfMedia({ screen_sharing: true, video_enabled: true });
          this._syncMediaInBackground({ screen_sharing: true });
          this._renderGrid();
          toast('Sharing started. You should see a preview of what you shared.', 'ok');
        }
      } catch (err) {
        toast(err.message || 'Screen share failed.', 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    },

    toggleHand() {
      this.handRaised = !this.handRaised;
      $('#btnHand')?.classList.toggle('active', this.handRaised);
      const me = this.participants.find((p) => p.id === this.self?.id);
      if (me) me.hand_raised = this.handRaised;
      this._renderGrid();
      this._renderParticipants();
      this.signaling.setHand(this.handRaised).catch((err) => {
        this.handRaised = !this.handRaised;
        $('#btnHand')?.classList.toggle('active', this.handRaised);
        if (me) me.hand_raised = this.handRaised;
        this._renderGrid();
        this._renderParticipants();
        toast(err.message, 'error');
      });
    },

    togglePanel(name, force) {
      const next = typeof force === 'boolean' ? force : !this.panels[name];
      Object.keys(this.panels).forEach((k) => {
        this.panels[k] = k === name ? next : false;
        const panel = $(`#panel-${k}`);
        if (panel) panel.hidden = !this.panels[k];
      });
      if (name === 'info' && next) {
        $('#infoCode').textContent = this.meetingCode;
        $('#infoLink').value = `${location.origin}${this._baseUrl()}/room.php?meeting=${encodeURIComponent(this.meetingCode)}`;
      }
    },

    async sendChat() {
      const input = $('#chatInput');
      const sendBtn = $('#chatSendBtn');
      const message = (input?.value || '').trim();
      if (!message) {
        toast('Type a message first.', 'warning');
        input?.focus();
        return;
      }

      const tempId = 'tmp-' + Date.now();
      this._appendChat({
        message_id: tempId,
        display_name: this.self?.display_name || 'You',
        message,
        created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
        pending: true,
      });
      if (input) input.value = '';
      if (sendBtn) sendBtn.disabled = true;

      try {
        const res = await this.signaling.sendChat(message);
        const box = $('#chatMessages');
        box?.querySelector(`[data-mid="${tempId}"]`)?.remove();
        this._appendChat(res.data);
      } catch (err) {
        const box = $('#chatMessages');
        const pending = box?.querySelector(`[data-mid="${tempId}"]`);
        if (pending) {
          pending.classList.add('chat-failed');
          pending.querySelector('.chat-body')?.insertAdjacentHTML(
            'beforeend',
            '<div class="chat-error">Failed to send</div>'
          );
        }
        toast(err.message || 'Could not send message.', 'error');
      } finally {
        if (sendBtn) sendBtn.disabled = false;
        input?.focus();
      }
    },

    _appendChat(msg) {
      const box = $('#chatMessages');
      if (!box || !msg) return;
      const id = msg.message_id;
      if (id != null && box.querySelector('[data-mid="' + String(id).replace(/"/g, '') + '"]')) return;
      const el = document.createElement('div');
      el.className = 'chat-item' + (msg.pending ? ' chat-pending' : '');
      if (id != null) el.dataset.mid = String(id);
      let time = '';
      try {
        time = msg.created_at
          ? new Date(String(msg.created_at).replace(' ', 'T')).toLocaleTimeString()
          : '';
      } catch (_) { /* ignore */ }
      el.innerHTML = `
        <div class="chat-head"><strong>${escapeHtml(msg.display_name || 'User')}</strong><span>${escapeHtml(time)}</span></div>
        <div class="chat-body">${escapeHtml(msg.message || '')}</div>`;
      box.appendChild(el);
      box.scrollTop = box.scrollHeight;
    },

    async sendReaction(emoji) {
      try {
        const res = await this.signaling.sendReaction(emoji);
        this._showReaction(res.data);
      } catch (err) {
        toast(err.message, 'error');
      }
    },

    _showReaction(payload) {
      const stage = $('#reactionStage');
      if (!stage || !payload?.emoji) return;
      const el = document.createElement('div');
      el.className = 'floating-reaction';
      el.textContent = `${payload.emoji}`;
      el.style.left = `${20 + Math.random() * 60}%`;
      stage.appendChild(el);
      setTimeout(() => el.remove(), 2200);
    },

    async copyLink() {
      const link = `${location.origin}${this._baseUrl()}/room.php?meeting=${encodeURIComponent(this.meetingCode)}`;
      try {
        await navigator.clipboard.writeText(link);
        toast('Meeting link copied.', 'ok');
      } catch (_) {
        $('#infoLink').select();
        document.execCommand('copy');
        toast('Meeting link copied.', 'ok');
      }
    },

    async toggleLock() {
      const locked = !$('#lockBadge') || $('#lockBadge').hidden;
      try {
        await this.signaling.lockMeeting(locked);
        $('#lockBadge').hidden = !locked;
        toast(locked ? 'Meeting locked.' : 'Meeting unlocked.', 'info');
      } catch (err) {
        toast(err.message, 'error');
      }
    },

    async endMeeting() {
      if (!confirm('End the meeting for everyone?')) return;
      try {
        await this.signaling.endMeeting();
        await this.leave({ silent: true, ended: true });
      } catch (err) {
        toast(err.message, 'error');
      }
    },

    toggleCaptions() {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      const panel = $('#panel-captions');
      if (!SpeechRecognition) {
        toast('Live captions require Chrome/Edge with Web Speech API. Remote speech is not captioned in this mesh prototype.', 'warning');
        return;
      }
      if (this.recognition) {
        try { this.recognition.stop(); } catch (_) {}
        this.recognition = null;
        if (panel) panel.hidden = true;
        $('#btnCaptions')?.classList.remove('active');
        ConnectMeetSettings.save({ captionsEnabled: false });
        return;
      }

      const prefs = ConnectMeetSettings.load();
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = prefs.captionsLang || 'en-US';
      recognition.onresult = (event) => {
        let interim = '';
        let finalText = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const t = event.results[i][0].transcript;
          if (event.results[i].isFinal) finalText += t;
          else interim += t;
        }
        const out = $('#captionText');
        if (out) {
          out.innerHTML = `<strong>${escapeHtml(this.self?.display_name || 'You')}:</strong> ${escapeHtml(finalText || interim)}`;
        }
      };
      recognition.onerror = (e) => {
        // no-speech / network are common and noisy — don't spam toasts
        if (e.error === 'aborted' || e.error === 'no-speech') return;
        if (e.error === 'not-allowed') {
          toast('Microphone permission needed for captions.', 'warning');
          return;
        }
        toast('Captions error: ' + e.error, 'warning');
      };
      recognition.onend = () => {
        // Keep running while enabled
        if (this.recognition === recognition) {
          try { recognition.start(); } catch (_) {}
        }
      };
      try {
        recognition.start();
        this.recognition = recognition;
        if (panel) panel.hidden = false;
        $('#btnCaptions')?.classList.add('active');
        ConnectMeetSettings.save({ captionsEnabled: true });
        toast('Captions enabled for your microphone only (browser speech recognition).', 'info');
      } catch (err) {
        toast(err.message || 'Unable to start captions.', 'error');
      }
    },

    _stopRecordingResources() {
      this._recordDrawing = false;
      if (this._recordRaf) {
        cancelAnimationFrame(this._recordRaf);
        this._recordRaf = null;
      }
      if (this._recordAudioCtx) {
        this._recordAudioCtx.close().catch(() => {});
        this._recordAudioCtx = null;
      }
      if (this._recordCanvas?.parentNode) {
        this._recordCanvas.parentNode.removeChild(this._recordCanvas);
      }
      this._recordCanvas = null;
      this._recordStream?.getTracks().forEach((t) => {
        try { t.stop(); } catch (_) { /* ignore */ }
      });
      this._recordStream = null;
    },

    async _mixRecordingAudio(intoStream) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        this._attachRawAudioTracks(intoStream);
        return;
      }

      try {
        const audioCtx = new AudioCtx();
        this._recordAudioCtx = audioCtx;
        if (audioCtx.state === 'suspended') {
          await audioCtx.resume();
        }

        const dest = audioCtx.createMediaStreamDestination();
        const gain = audioCtx.createGain();
        gain.gain.value = 1;
        gain.connect(dest);

        let linked = 0;
        const seen = new Set();

        const linkStream = (mediaStream, label) => {
          if (!mediaStream) return;
          const liveAudio = mediaStream.getAudioTracks().filter((t) => t.readyState === 'live');
          if (!liveAudio.length) return;
          // One MediaStreamSource per unique stream (do not clone — clones are often silent)
          const key = liveAudio.map((t) => t.id).join('|');
          if (seen.has(key)) return;
          seen.add(key);
          try {
            const onlyAudio = new MediaStream(liveAudio);
            const src = audioCtx.createMediaStreamSource(onlyAudio);
            src.connect(gain);
            linked += 1;
            console.debug('[record] linked audio', label, liveAudio.length);
          } catch (err) {
            console.warn('[record] audio link failed', label, err);
          }
        };

        // Local mic (works even when camera is off)
        linkStream(this.webrtc?.localStream || this.webrtc?.getLocalStream(), 'local');

        // Remote peers
        this.remoteStreams.forEach((rs, id) => linkStream(rs, 'remote-' + id));

        // Also pick up audio from <video> srcObjects in the grid
        $all('#videoGrid video').forEach((video, i) => {
          if (video.srcObject) linkStream(video.srcObject, 'video-el-' + i);
        });

        if (linked > 0) {
          dest.stream.getAudioTracks().forEach((t) => {
            t.enabled = true;
            intoStream.addTrack(t);
          });
        } else {
          // Fallback: attach raw tracks (Chrome usually records the first)
          this._attachRawAudioTracks(intoStream);
        }
      } catch (err) {
        console.warn('[record] mix failed, raw fallback', err);
        this._attachRawAudioTracks(intoStream);
      }
    },

    _attachRawAudioTracks(intoStream) {
      const add = (mediaStream) => {
        if (!mediaStream) return;
        mediaStream.getAudioTracks().forEach((t) => {
          if (t.readyState !== 'live') return;
          try {
            // Prefer original track; clone if already present on another recorder stream
            intoStream.addTrack(t.clone());
          } catch (_) { /* ignore */ }
        });
      };
      add(this.webrtc?.localStream || this.webrtc?.getLocalStream());
      this.remoteStreams.forEach((rs) => add(rs));
      $all('#videoGrid video').forEach((v) => add(v.srcObject));
    },

    _drawAvatarTile(ctx, x, y, w, h, name) {
      const grad = ctx.createLinearGradient(x, y, x + w, y + h);
      grad.addColorStop(0, '#134e4a');
      grad.addColorStop(1, '#0b2428');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, h);
      const label = initials(name || '?');
      ctx.fillStyle = '#e8f7f4';
      ctx.font = `600 ${Math.max(28, Math.floor(h * 0.22))}px Fraunces, Georgia, serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + w / 2, y + h / 2 - 12);
      ctx.font = `500 ${Math.max(14, Math.floor(h * 0.06))}px Outfit, sans-serif`;
      ctx.fillStyle = '#9bb8b4';
      ctx.fillText(String(name || 'Guest').slice(0, 24), x + w / 2, y + h - 28);
    },

    /**
     * Always record via canvas grid — works with camera off (avatars),
     * remote videos only, screen share, or mixed.
     */
    _createRecordingStream() {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      canvas.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d', { alpha: false });
      this._recordCanvas = canvas;
      this._recordDrawing = true;

      const draw = () => {
        if (!this._recordDrawing) return;
        ctx.fillStyle = '#050e10';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Header strip
        ctx.fillStyle = 'rgba(7,26,28,0.95)';
        ctx.fillRect(0, 0, canvas.width, 48);
        ctx.fillStyle = '#e8f7f4';
        ctx.font = '600 18px Outfit, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          `ConnectMeet  ${this.meetingCode || ''}  ·  ${this.participants.length || 1} people`,
          20,
          24
        );

        const people = (this.participants && this.participants.length)
          ? this.participants
          : [{ id: this.self?.id, display_name: this.self?.display_name || 'You', video_enabled: false }];

        const n = Math.max(1, people.length);
        const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
        const rows = Math.ceil(n / cols);
        const pad = 12;
        const top = 56;
        const areaW = canvas.width - pad * 2;
        const areaH = canvas.height - top - pad;
        const cellW = areaW / cols;
        const cellH = areaH / rows;

        people.forEach((p, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          const x = pad + col * cellW + 4;
          const y = top + row * cellH + 4;
          const w = cellW - 8;
          const h = cellH - 8;

          const video = $(`#video-${p.id}`);
          const hasVideo = !!(
            video
            && !video.hidden
            && video.srcObject
            && video.videoWidth > 0
            && (p.video_enabled || p.screen_sharing || (p.id === this.self?.id && this.webrtc?.isSharing()))
          );

          ctx.save();
          // rounded clip
          const r = 16;
          ctx.beginPath();
          ctx.moveTo(x + r, y);
          ctx.arcTo(x + w, y, x + w, y + h, r);
          ctx.arcTo(x + w, y + h, x, y + h, r);
          ctx.arcTo(x, y + h, x, y, r);
          ctx.arcTo(x, y, x + w, y, r);
          ctx.closePath();
          ctx.clip();

          if (hasVideo) {
            try {
              const vw = video.videoWidth;
              const vh = video.videoHeight;
              const scale = Math.max(w / vw, h / vh);
              const dw = vw * scale;
              const dh = vh * scale;
              const dx = x + (w - dw) / 2;
              const dy = y + (h - dh) / 2;
              const isLocal = p.id === this.self?.id;
              if (isLocal && !this.webrtc?.isSharing()) {
                ctx.translate(x + w, y);
                ctx.scale(-1, 1);
                ctx.drawImage(video, -(w - dw) / 2, (h - dh) / 2, dw, dh);
              } else {
                ctx.drawImage(video, dx, dy, dw, dh);
              }
            } catch (_) {
              this._drawAvatarTile(ctx, x, y, w, h, p.display_name);
            }
          } else {
            this._drawAvatarTile(ctx, x, y, w, h, p.display_name);
          }

          // Name bar
          ctx.fillStyle = 'rgba(0,0,0,0.55)';
          ctx.fillRect(x, y + h - 36, w, 36);
          ctx.fillStyle = '#fff';
          ctx.font = '500 14px Outfit, sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const tag = p.id === this.self?.id ? ' (You)' : (p.role === 'host' ? ' · Host' : '');
          ctx.fillText(`${p.display_name || 'Guest'}${tag}`, x + 12, y + h - 18);

          ctx.restore();
        });

        this._recordRaf = requestAnimationFrame(draw);
      };
      draw();

      const canvasStream = canvas.captureStream(20);
      const mixed = new MediaStream(canvasStream.getVideoTracks());
      this._recordStream = mixed;
      return mixed;
    },

    async toggleRecord() {
      if (this.recording) {
        try {
          if (this.recorder && this.recorder.state === 'recording') {
            this.recorder.requestData();
            this.recorder.stop();
          }
        } catch (_) { /* ignore */ }
        return;
      }
      if (!window.MediaRecorder) {
        toast('Local recording is not supported in this browser.', 'warning');
        return;
      }

      let stream;
      try {
        stream = this._createRecordingStream();
        await this._mixRecordingAudio(stream);
      } catch (err) {
        toast(err.message || 'Unable to prepare recording.', 'error');
        this._stopRecordingResources();
        return;
      }

      if (!stream.getVideoTracks().length) {
        this._stopRecordingResources();
        toast('Unable to create a recording stream.', 'warning');
        return;
      }

      const hasAudio = stream.getAudioTracks().some((t) => t.readyState === 'live');
      if (!hasAudio) {
        toast('No microphone/remote audio found — video will record without sound. Unmute mic if needed.', 'warning');
      }

      const mimeCandidates = [
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8',
        'video/webm',
      ];
      const mime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
      try {
        this.recordedChunks = [];
        const recOpts = mime
          ? { mimeType: mime, videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 }
          : { videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 };
        this.recorder = new MediaRecorder(stream, recOpts);
        this.recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
        };
        this.recorder.onerror = (e) => {
          toast('Recording error: ' + (e.error?.message || 'unknown'), 'error');
        };
        this.recorder.onstop = () => {
          this.recording = false;
          $('#recordBadge').hidden = true;
          $('#btnRecord')?.classList.remove('active');
          this._stopRecordingResources();
          const total = this.recordedChunks.reduce((n, b) => n + (b?.size || 0), 0);
          if (!this.recordedChunks.length || total < 1000) {
            toast('Recording was empty. Record for a few seconds, then stop.', 'warning');
            this.recorder = null;
            return;
          }
          const blob = new Blob(this.recordedChunks, { type: mime || 'video/webm' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `connectmeet-${this.meetingCode}-${Date.now()}.webm`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          toast('Recording saved (' + Math.round(total / 1024) + ' KB).', 'ok');
          this.recorder = null;
        };
        this.recording = true;
        // Brief delay so AudioContext graph is running before encoder starts
        await new Promise((r) => setTimeout(r, 150));
        this.recorder.start(250);
        $('#recordBadge').hidden = false;
        $('#btnRecord')?.classList.add('active');
        toast(
          hasAudio
            ? 'Recording started (with audio). Press Record again to stop.'
            : 'Recording started (no audio track). Press Record again to stop.',
          'info'
        );
        this.signaling.sendChat('🔴 started a local browser recording').catch(() => {});
      } catch (err) {
        this.recording = false;
        this._stopRecordingResources();
        toast(err.message || 'Unable to start recording.', 'error');
      }
    },

    openSettings() {
      this._refreshDeviceSelects();
      const prefs = ConnectMeetSettings.load();
      if ($('#settingsName')) $('#settingsName').value = prefs.displayName || this.self?.display_name || '';
      $('#settingsModal').hidden = false;
    },

    async applySettings() {
      const name = ($('#settingsName')?.value || '').trim();
      const audioDeviceId = $('#settingsMic')?.value || '';
      const videoDeviceId = $('#settingsCam')?.value || '';
      const outputDeviceId = $('#settingsOutput')?.value || '';
      ConnectMeetSettings.save({ displayName: name, audioDeviceId, videoDeviceId, outputDeviceId });

      try {
        if (this.webrtc) {
          await this.webrtc.switchDevice({
            audioDeviceId: audioDeviceId || undefined,
            videoDeviceId: videoDeviceId || undefined,
          });
          this.webrtc.setAudioEnabled(this.media.audio);
          this.webrtc.setVideoEnabled(this.media.video);
          this._renderGrid();
        }
        $all('video').forEach((v) => {
          if (outputDeviceId) ConnectMeetSettings.applyOutput(v, outputDeviceId);
        });
        toast('Settings applied.', 'ok');
        $('#settingsModal').hidden = true;
      } catch (err) {
        toast(this._mediaErrorMessage(err), 'error');
      }
    },

    _setStatus(text, level) {
      const el = $('#connStatus');
      if (!el) return;
      el.textContent = text;
      el.dataset.level = level || 'ok';
    },

    async leave({ silent = false, ended = false } = {}) {
      if (this.left) return;
      this.left = true;
      this.signaling?.stop();
      if (this.recognition) {
        try { this.recognition.stop(); } catch (_) {}
        this.recognition = null;
      }
      if (this.recording) {
        try { this.recorder?.stop(); } catch (_) {}
      }
      if (!silent && !ended) {
        try { await this.signaling.leaveMeeting(); } catch (_) {}
      }
      this.webrtc?.closeAll();
      this._clearSession();
      document.body.classList.remove('in-meeting');
      location.href = this._baseUrl() + '/index.php' + (ended ? '?ended=1' : '');
    },
  };

  global.ConnectMeetMeeting = MeetingApp;
})(window);
