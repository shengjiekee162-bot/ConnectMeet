/**
 * ConnectMeet landing page logic.
 */
(function () {
  'use strict';

  function $(sel) { return document.querySelector(sel); }

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

  function baseUrl() {
    const path = location.pathname.replace(/\/[^/]*$/, '');
    return path || '';
  }

  function updateClock() {
    const el = $('#localTime');
    if (!el) return;
    const now = new Date();
    el.textContent = now.toLocaleString(undefined, {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function normalizeCode(raw) {
    const digits = String(raw || '').replace(/\D+/g, '');
    if (digits.length === 9) {
      return digits.replace(/^(\d{3})(\d{3})(\d{3})$/, '$1-$2-$3');
    }
    if (digits.length === 10) {
      return digits.replace(/^(\d{3})(\d{4})(\d{3})$/, '$1-$2-$3');
    }
    return digits;
  }

  const signaling = new ConnectMeetSignaling({ baseUrl: baseUrl() });
  let config = null;

  async function init() {
    updateClock();
    setInterval(updateClock, 1000);

    const prefs = ConnectMeetSettings.load();
    if ($('#homeDisplayName') && prefs.displayName) {
      $('#homeDisplayName').value = prefs.displayName;
    }

    try {
      config = await signaling.bootstrap();
      $('#appReady').hidden = false;
    } catch (err) {
      toast('Server unavailable: ' + err.message, 'error');
      return;
    }

    if (new URLSearchParams(location.search).get('ended') === '1') {
      toast('You left the meeting.', 'info');
    }

    $('#btnInstant')?.addEventListener('click', () => createMeeting('instant'));
    $('#btnLater')?.addEventListener('click', () => createMeeting('scheduled'));
    $('#joinForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      joinMeeting();
    });
    $('#meetingCodeInput')?.addEventListener('input', (e) => {
      const digits = e.target.value.replace(/\D+/g, '').slice(0, 9);
      let formatted = digits;
      if (digits.length > 6) {
        formatted = digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
      } else if (digits.length > 3) {
        formatted = digits.slice(0, 3) + '-' + digits.slice(3);
      }
      if (formatted !== e.target.value) e.target.value = formatted;
    });
    $('#homeDisplayName')?.addEventListener('change', (e) => {
      ConnectMeetSettings.save({ displayName: e.target.value.trim() });
    });
    $('#btnHelp')?.addEventListener('click', () => {
      $('#helpModal').hidden = false;
    });
    $('#btnShortcuts')?.addEventListener('click', () => {
      $('#shortcutsModal').hidden = false;
    });
    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        btn.closest('.modal')?.setAttribute('hidden', '');
      });
    });
    $('#btnOpenSettingsHome')?.addEventListener('click', async () => {
      const devices = await ConnectMeetSettings.enumerate();
      const prefs2 = ConnectMeetSettings.load();
      ConnectMeetSettings.fillSelect($('#homeMic'), devices.audioInputs, prefs2.audioDeviceId);
      ConnectMeetSettings.fillSelect($('#homeCam'), devices.videoInputs, prefs2.videoDeviceId);
      $('#homeSettingsModal').hidden = false;
    });
    $('#homeSettingsSave')?.addEventListener('click', () => {
      ConnectMeetSettings.save({
        displayName: ($('#homeDisplayName')?.value || '').trim(),
        audioDeviceId: $('#homeMic')?.value || '',
        videoDeviceId: $('#homeCam')?.value || '',
      });
      toast('Preferences saved on this device.', 'ok');
      $('#homeSettingsModal').hidden = true;
    });

    // Request permission early so device labels appear
    $('#btnRequestMedia')?.addEventListener('click', async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        stream.getTracks().forEach((t) => t.stop());
        toast('Media permissions granted.', 'ok');
        const devices = await ConnectMeetSettings.enumerate();
        ConnectMeetSettings.fillSelect($('#homeMic'), devices.audioInputs, ConnectMeetSettings.prefs.audioDeviceId);
        ConnectMeetSettings.fillSelect($('#homeCam'), devices.videoInputs, ConnectMeetSettings.prefs.videoDeviceId);
      } catch (err) {
        toast(err.message || 'Permission denied.', 'warning');
      }
    });
  }

  async function createMeeting(mode) {
    const displayName = ($('#homeDisplayName')?.value || '').trim() || 'Guest';
    ConnectMeetSettings.save({ displayName });

    const btn = mode === 'instant' ? $('#btnInstant') : $('#btnLater');
    if (btn) btn.disabled = true;

    try {
      const res = await signaling.createMeeting({
        mode,
        display_name: displayName,
        title: 'ConnectMeet Meeting',
        scheduled_at: mode === 'scheduled'
          ? new Date(Date.now() + 3600000).toISOString()
          : null,
      });
      const data = res.data;
      const save = (key, value) => {
        try { sessionStorage.setItem(key, value); } catch (_) { /* tracking prevention */ }
        try { localStorage.setItem(key, value); } catch (_) { /* ignore */ }
      };
      save('cm_host_token', data.host_token);
      save('cm_pending_code', data.meeting_code);

      if (mode === 'instant' && data.participant?.token) {
        save('cm_session', JSON.stringify({
          meetingCode: data.meeting_code,
          token: data.participant.token,
          self: data.participant,
        }));
        // Prefer absolute path under this folder (works on cPanel subdirectories)
        location.href = baseUrl() + '/room.php?meeting=' + encodeURIComponent(data.meeting_code);
        return;
      }

      // Scheduled / for later — show share card
      $('#createdCard').hidden = false;
      $('#createdCode').textContent = data.meeting_code;
      $('#createdLink').value = data.join_url;
      toast('Meeting created. Share the link when ready.', 'ok');
    } catch (err) {
      toast(err.message || 'Could not create meeting.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function joinMeeting() {
    const raw = $('#meetingCodeInput')?.value || '';
    const code = normalizeCode(raw);
    if (!code || code.replace(/\D+/g, '').length !== 9) {
      toast('Enter a valid 9-digit meeting code (123-456-789).', 'warning');
      return;
    }

    const displayName = ($('#homeDisplayName')?.value || '').trim();
    if (displayName) ConnectMeetSettings.save({ displayName });

    try {
      const res = await signaling.validateMeeting(code);
      if (!res.data?.joinable) {
        toast(res.data?.message || 'Cannot join this meeting.', 'error');
        return;
      }
      sessionStorage.setItem('cm_pending_code', code);
      location.href = baseUrl() + '/room.php?meeting=' + encodeURIComponent(code);
    } catch (err) {
      toast(err.message || 'Meeting not found.', 'error');
    }
  }

  $('#btnCopyCreated')?.addEventListener('click', async () => {
    const link = $('#createdLink')?.value || '';
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copied.', 'ok');
    } catch (_) {
      $('#createdLink')?.select();
      document.execCommand('copy');
      toast('Link copied.', 'ok');
    }
  });

  document.addEventListener('DOMContentLoaded', init);
})();
