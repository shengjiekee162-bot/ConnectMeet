/**
 * ConnectMeet signaling client — short polling over PHP REST APIs.
 */
(function (global) {
  'use strict';

  class SignalingClient {
    constructor(options = {}) {
      this.baseUrl = (options.baseUrl || '').replace(/\/$/, '');
      this.csrfToken = options.csrfToken || (typeof window !== 'undefined' ? (window.CM_CSRF || '') : '');
      this.participantToken = options.participantToken || '';
      this.hostToken = options.hostToken || '';
      this.intervalMs = options.intervalMs || 1500;
      this.errorBackoffMs = options.errorBackoffMs || 4000;
      this.requestTimeoutMs = options.requestTimeoutMs || 8000;

      this._eventAfterId = 0;
      this._chatAfterId = 0;
      this._pollTimer = null;
      this._signalTimer = null;
      this._heartbeatTimer = null;
      this._stopped = true;
      this._inflight = { events: false, signals: false, heartbeat: false };
      this._handlers = {};
      this._seenEventIds = new Set();
      this._authFailStreak = 0;
    }

    on(event, handler) {
      if (!this._handlers[event]) this._handlers[event] = [];
      this._handlers[event].push(handler);
    }

    emit(event, payload) {
      (this._handlers[event] || []).forEach((fn) => {
        try { fn(payload); } catch (err) { console.error(err); }
      });
    }

    setTokens({ csrfToken, participantToken, hostToken }) {
      if (csrfToken) this.csrfToken = csrfToken;
      if (participantToken) this.participantToken = participantToken;
      if (hostToken) this.hostToken = hostToken;
    }

    async request(path, { method = 'GET', body = null, auth = true } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      const headers = {
        'Accept': 'application/json',
        'X-CSRF-Token': this.csrfToken,
      };
      if (auth && this.participantToken) {
        headers['X-Participant-Token'] = this.participantToken;
      }
      if (this.hostToken) {
        headers['X-Host-Token'] = this.hostToken;
      }

      const opts = { method, headers, credentials: 'same-origin', signal: controller.signal };
      if (body !== null) {
        headers['Content-Type'] = 'application/json';
        const payload = {
          ...body,
          csrf_token: this.csrfToken,
        };
        // Also put tokens in body in case custom headers are stripped
        if (auth && this.participantToken) {
          payload.participant_token = this.participantToken;
        }
        if (this.hostToken) {
          payload.host_token = this.hostToken;
        }
        opts.body = JSON.stringify(payload);
      }

      try {
        const res = await fetch(this.baseUrl + path, opts);
        const data = await res.json().catch(() => ({
          success: false,
          message: 'Invalid server response',
          data: null,
        }));
        if (!res.ok || !data.success) {
          const err = new Error(data.message || `Request failed (${res.status})`);
          err.status = res.status;
          err.payload = data;
          throw err;
        }
        return data;
      } finally {
        clearTimeout(timer);
      }
    }

    async bootstrap() {
      const data = await this.request('/api/meetings.php?action=bootstrap', { auth: false });
      if (data.data?.csrf_token) this.csrfToken = data.data.csrf_token;
      if (data.data?.polling?.interval_ms) this.intervalMs = data.data.polling.interval_ms;
      if (data.data?.polling?.error_backoff_ms) this.errorBackoffMs = data.data.polling.error_backoff_ms;
      return data.data;
    }

    async createMeeting(payload) {
      return this.request('/api/meetings.php?action=create', { method: 'POST', body: payload, auth: false });
    }

    async validateMeeting(code) {
      return this.request(
        '/api/meetings.php?action=validate&meeting=' + encodeURIComponent(code),
        { auth: false }
      );
    }

    async joinMeeting(payload) {
      return this.request('/api/participants.php?action=join', { method: 'POST', body: payload, auth: false });
    }

    async leaveMeeting() {
      return this.request('/api/participants.php?action=leave', { method: 'POST', body: {} });
    }

    async endMeeting() {
      return this.request('/api/meetings.php?action=end', { method: 'POST', body: {} });
    }

    async lockMeeting(locked) {
      return this.request('/api/meetings.php?action=' + (locked ? 'lock' : 'unlock'), {
        method: 'POST',
        body: {},
      });
    }

    async updateMedia(state) {
      return this.request('/api/participants.php?action=update_media', { method: 'POST', body: state });
    }

    async setHand(raised) {
      return this.request('/api/participants.php?action=hand', { method: 'POST', body: { raised: !!raised } });
    }

    async removeParticipant(participantId) {
      return this.request('/api/participants.php?action=remove', {
        method: 'POST',
        body: { participant_id: participantId },
      });
    }

    async sendChat(message) {
      return this.request('/api/chat.php?action=send', { method: 'POST', body: { message } });
    }

    async sendReaction(emoji) {
      return this.request('/api/events.php?action=reaction', { method: 'POST', body: { emoji } });
    }

    async sendSignal(toParticipantId, signalType, payload) {
      return this.request('/api/signaling.php?action=send', {
        method: 'POST',
        body: {
          to_participant_id: toParticipantId,
          signal_type: signalType,
          payload,
        },
      });
    }

    start() {
      if (!this._stopped) return;
      this._stopped = false;
      this._pollEvents();
      this._pollSignals();
      this._heartbeat();
    }

    stop() {
      this._stopped = true;
      clearTimeout(this._pollTimer);
      clearTimeout(this._signalTimer);
      clearTimeout(this._heartbeatTimer);
      this._pollTimer = this._signalTimer = this._heartbeatTimer = null;
    }

    async _pollEvents() {
      if (this._stopped || this._inflight.events) return;
      this._inflight.events = true;
      let delay = this.intervalMs;
      try {
        const data = await this.request('/api/events.php?action=poll', {
          method: 'POST',
          body: { after_id: this._eventAfterId },
        });
        const payload = data.data || {};
        if (Array.isArray(payload.participants)) {
          this.emit('participants', payload.participants);
        }
        if (payload.meeting_status) {
          this.emit('meeting_status', {
            status: payload.meeting_status,
            is_locked: payload.is_locked,
          });
        }
        (payload.events || []).forEach((ev) => {
          if (this._seenEventIds.has(ev.id)) return;
          this._seenEventIds.add(ev.id);
          if (ev.id > this._eventAfterId) this._eventAfterId = ev.id;
          this.emit('event', ev);
          this.emit(ev.event_type, ev);
        });
      } catch (err) {
        delay = this.errorBackoffMs;
        this.emit('error', err);
      } finally {
        this._inflight.events = false;
        if (!this._stopped) {
          this._pollTimer = setTimeout(() => this._pollEvents(), delay);
        }
      }
    }

    async _pollSignals() {
      if (this._stopped || this._inflight.signals) return;
      this._inflight.signals = true;
      let delay = Math.max(800, Math.floor(this.intervalMs * 0.75));
      try {
        const data = await this.request('/api/signaling.php?action=poll', {
          method: 'POST',
          body: {},
        });
        (data.data?.signals || []).forEach((signal) => {
          this.emit('signal', signal);
        });
      } catch (err) {
        delay = this.errorBackoffMs;
        this.emit('error', err);
      } finally {
        this._inflight.signals = false;
        if (!this._stopped) {
          this._signalTimer = setTimeout(() => this._pollSignals(), delay);
        }
      }
    }

    async _heartbeat() {
      if (this._stopped || this._inflight.heartbeat) return;
      this._inflight.heartbeat = true;
      let delay = Math.max(5000, this.intervalMs * 3);
      try {
        const data = await this.request('/api/participants.php?action=heartbeat', {
          method: 'POST',
          body: { connection_state: 'connected' },
        });
        this._authFailStreak = 0;
        if (data.data?.participants) {
          this.emit('participants', data.data.participants);
        }
        if (data.data?.meeting_status === 'ended' || data.data?.meeting_status === 'expired') {
          this.emit('meeting_status', { status: data.data.meeting_status });
        }
      } catch (err) {
        delay = this.errorBackoffMs;
        // Shared hosts sometimes drop the first auth header — retry before ejecting.
        if (err.status === 401 || err.status === 410) {
          this._authFailStreak += 1;
          this.emit('error', err);
          if (this._authFailStreak >= 3) {
            this.emit('kicked', err);
            this.stop();
            return;
          }
        } else {
          this.emit('error', err);
        }
      } finally {
        this._inflight.heartbeat = false;
        if (!this._stopped) {
          this._heartbeatTimer = setTimeout(() => this._heartbeat(), delay);
        }
      }
    }
  }

  global.ConnectMeetSignaling = SignalingClient;
})(window);
