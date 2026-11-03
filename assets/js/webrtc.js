/**
 * ConnectMeet WebRTC mesh engine.
 * Peer-to-peer mesh suitable for small rooms. Requires signaling transport.
 */
(function (global) {
  'use strict';

  class WebRTCEngine {
    /**
     * @param {object} options
     * @param {Array} options.iceServers
     * @param {function} options.sendSignal (toId, type, payload) => Promise
     * @param {function} options.onRemoteStream (peerId, stream)
     * @param {function} options.onPeerState (peerId, state)
     * @param {function} options.onError (error)
     * @param {number} options.selfId
     */
    constructor(options = {}) {
      this.iceServers = options.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
      this.sendSignal = options.sendSignal;
      this.onRemoteStream = options.onRemoteStream || (() => {});
      this.onPeerState = options.onPeerState || (() => {});
      this.onError = options.onError || (() => {});
      this.selfId = options.selfId || 0;

      this.localStream = null;
      this.screenStream = null;
      this.peers = new Map(); // peerId -> { pc, makingOffer, ignoreOffer, polite, pendingCandidates }
      this._audioContext = null;
      this._analyser = null;
      this._speaking = false;
      this._speakingTimer = null;
      this._onSpeakingChange = null;
      this._isSharing = false;
    }

    setSelfId(id) {
      this.selfId = Number(id) || 0;
    }

    setIceServers(servers) {
      if (Array.isArray(servers) && servers.length) {
        this.iceServers = servers;
      }
    }

    async getLocalMedia({ audio = true, video = true, audioDeviceId, videoDeviceId } = {}) {
      const constraints = {};
      if (audio) {
        constraints.audio = audioDeviceId
          ? { deviceId: { exact: audioDeviceId }, echoCancellation: true, noiseSuppression: true }
          : { echoCancellation: true, noiseSuppression: true };
      } else {
        constraints.audio = false;
      }
      if (video) {
        constraints.video = videoDeviceId
          ? { deviceId: { exact: videoDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' };
      } else {
        constraints.video = false;
      }

      if (!constraints.audio && !constraints.video) {
        this.localStream = new MediaStream();
        return this.localStream;
      }

      try {
        this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
        this._setupSpeakingDetector();
        return this.localStream;
      } catch (err) {
        // Fallback: try audio-only if video failed
        if (constraints.video && constraints.audio) {
          try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
              audio: constraints.audio,
              video: false,
            });
            this._setupSpeakingDetector();
            err.partial = 'audio-only';
            this.onError(err);
            return this.localStream;
          } catch (audioErr) {
            this.localStream = new MediaStream();
            this.onError(audioErr);
            throw audioErr;
          }
        }
        this.localStream = new MediaStream();
        this.onError(err);
        throw err;
      }
    }

    stopLocalMedia() {
      this._teardownSpeakingDetector();
      if (this.localStream) {
        this.localStream.getTracks().forEach((t) => t.stop());
        this.localStream = null;
      }
      if (this.screenStream) {
        this.screenStream.getTracks().forEach((t) => t.stop());
        this.screenStream = null;
      }
      this._isSharing = false;
    }

    setAudioEnabled(enabled) {
      if (!this.localStream) return;
      this.localStream.getAudioTracks().forEach((t) => {
        t.enabled = !!enabled;
      });
    }

    setVideoEnabled(enabled) {
      if (!this.localStream) return;
      // Camera track can stay on locally while screen-sharing (for bottom preview).
      // Outbound peer video still uses the screen track via replaceTrack.
      this.localStream.getVideoTracks().forEach((t) => {
        t.enabled = !!enabled;
      });
    }

    hasLiveVideoTrack() {
      return !!(this.localStream
        && this.localStream.getVideoTracks().some((t) => t.readyState === 'live'));
    }

    hasLiveAudioTrack() {
      return !!(this.localStream
        && this.localStream.getAudioTracks().some((t) => t.readyState === 'live'));
    }

    /**
     * Turn camera on even if no video track was acquired at join time.
     */
    async ensureCameraOn({ videoDeviceId } = {}) {
      if (!this.localStream) {
        this.localStream = new MediaStream();
      }

      let track = this.localStream.getVideoTracks().find((t) => t.readyState === 'live');
      if (track) {
        track.enabled = true;
        // While screen sharing, keep sending screen to peers; only refresh local camera.
        if (!this._isSharing) {
          await this._replaceVideoTrackOnPeers(track);
        }
        return this.localStream;
      }

      // Remove dead tracks first
      this.localStream.getVideoTracks().forEach((t) => {
        this.localStream.removeTrack(t);
        try { t.stop(); } catch (_) { /* ignore */ }
      });

      const constraints = {
        video: videoDeviceId
          ? { deviceId: { exact: videoDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      };
      const fresh = await navigator.mediaDevices.getUserMedia(constraints);
      track = fresh.getVideoTracks()[0];
      if (!track) {
        throw new Error('No camera track available.');
      }
      this.localStream.addTrack(track);
      if (!this._isSharing) {
        await this._replaceVideoTrackOnPeers(track);
      }
      return this.localStream;
    }

    async ensureMicOn({ audioDeviceId } = {}) {
      if (!this.localStream) {
        this.localStream = new MediaStream();
      }
      let track = this.localStream.getAudioTracks().find((t) => t.readyState === 'live');
      if (track) {
        track.enabled = true;
        return this.localStream;
      }
      this.localStream.getAudioTracks().forEach((t) => {
        this.localStream.removeTrack(t);
        try { t.stop(); } catch (_) { /* ignore */ }
      });
      const fresh = await navigator.mediaDevices.getUserMedia({
        audio: audioDeviceId
          ? { deviceId: { exact: audioDeviceId }, echoCancellation: true, noiseSuppression: true }
          : { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      track = fresh.getAudioTracks()[0];
      if (!track) throw new Error('No microphone track available.');
      this.localStream.addTrack(track);
      for (const [, peer] of this.peers) {
        const sender = peer.pc.getSenders().find((s) => s.track?.kind === 'audio')
          || peer.pc.getSenders().find((s) => !s.track);
        if (sender && sender.track?.kind === 'audio') {
          await sender.replaceTrack(track);
        } else if (sender && !sender.track) {
          await sender.replaceTrack(track);
        } else {
          peer.pc.addTrack(track, this.localStream);
        }
      }
      this._setupSpeakingDetector();
      return this.localStream;
    }

    async _replaceVideoTrackOnPeers(track) {
      for (const [, peer] of this.peers) {
        const videoSender = peer.pc.getSenders().find((s) => s.track?.kind === 'video');
        if (videoSender) {
          await videoSender.replaceTrack(track);
        } else {
          peer.pc.addTrack(track, this.localStream);
          // Renegotiate so the remote peer receives the new track
          for (const [id, p] of this.peers) {
            if (p === peer) {
              await this._makeOffer(id);
              break;
            }
          }
        }
      }
    }

    async switchDevice({ audioDeviceId, videoDeviceId } = {}) {
      const hadAudio = this.localStream ? this.localStream.getAudioTracks().some((t) => t.enabled) : true;
      const hadVideo = this.localStream ? this.localStream.getVideoTracks().length > 0 : true;
      const audioEnabled = this.localStream
        ? this.localStream.getAudioTracks().every((t) => t.enabled)
        : true;
      const videoEnabled = this.localStream
        ? this.localStream.getVideoTracks().every((t) => t.enabled)
        : true;

      const old = this.localStream;
      const next = await navigator.mediaDevices.getUserMedia({
        audio: audioDeviceId
          ? { deviceId: { exact: audioDeviceId }, echoCancellation: true, noiseSuppression: true }
          : hadAudio,
        video: (!this._isSharing && hadVideo)
          ? (videoDeviceId
            ? { deviceId: { exact: videoDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
            : { width: { ideal: 1280 }, height: { ideal: 720 } })
          : false,
      });

      if (old) {
        old.getTracks().forEach((t) => t.stop());
      }
      this.localStream = next;
      this.setAudioEnabled(audioEnabled);
      if (!this._isSharing) this.setVideoEnabled(videoEnabled);
      this._setupSpeakingDetector();

      // Replace tracks on existing peer connections
      for (const [, peer] of this.peers) {
        await this._syncTracksToPeer(peer.pc);
      }
      return this.localStream;
    }

    async ensurePeer(peerId) {
      peerId = Number(peerId);
      if (!peerId || peerId === this.selfId) return null;
      if (this.peers.has(peerId)) return this.peers.get(peerId);

      const polite = this.selfId < peerId;
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      const peer = {
        pc,
        makingOffer: false,
        ignoreOffer: false,
        polite,
        pendingCandidates: [],
      };
      this.peers.set(peerId, peer);

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          this.sendSignal(peerId, 'ice-candidate', ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate);
        }
      };

      pc.ontrack = (ev) => {
        const stream = ev.streams[0] || new MediaStream([ev.track]);
        this.onRemoteStream(peerId, stream);
      };

      pc.onconnectionstatechange = () => {
        this.onPeerState(peerId, pc.connectionState);
        if (pc.connectionState === 'failed') {
          this._recoverPeer(peerId).catch((err) => this.onError(err));
        }
      };

      // Add local tracks
      if (this.localStream) {
        this.localStream.getTracks().forEach((track) => {
          pc.addTrack(track, this.localStream);
        });
      }

      // Perfect negotiation: impolite peer creates the initial offer when discovering remote
      if (!polite) {
        this._makeOffer(peerId).catch((err) => this.onError(err));
      }

      return peer;
    }

    async _makeOffer(peerId) {
      const peer = this.peers.get(peerId);
      if (!peer) return;
      try {
        peer.makingOffer = true;
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        await this.sendSignal(peerId, 'offer', peer.pc.localDescription);
      } catch (err) {
        this.onError(err);
      } finally {
        peer.makingOffer = false;
      }
    }

    async handleSignal(signal) {
      const fromId = Number(signal.from_participant_id);
      const type = signal.signal_type;
      const payload = signal.payload;
      if (!fromId || fromId === this.selfId) return;

      const peer = await this.ensurePeer(fromId);
      if (!peer) return;
      const pc = peer.pc;

      try {
        if (type === 'offer') {
          const offerCollision = peer.makingOffer || pc.signalingState !== 'stable';
          peer.ignoreOffer = !peer.polite && offerCollision;
          if (peer.ignoreOffer) return;

          await pc.setRemoteDescription(payload);
          await this._flushPendingCandidates(peer);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await this.sendSignal(fromId, 'answer', pc.localDescription);
        } else if (type === 'answer') {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(payload);
            await this._flushPendingCandidates(peer);
          }
        } else if (type === 'ice-candidate') {
          if (!payload) return;
          if (!pc.remoteDescription) {
            peer.pendingCandidates.push(payload);
          } else {
            try {
              await pc.addIceCandidate(payload);
            } catch (err) {
              if (!peer.ignoreOffer) this.onError(err);
            }
          }
        } else if (type === 'renegotiate') {
          await this._makeOffer(fromId);
        }
      } catch (err) {
        this.onError(err);
      }
    }

    async _flushPendingCandidates(peer) {
      while (peer.pendingCandidates.length) {
        const c = peer.pendingCandidates.shift();
        try {
          await peer.pc.addIceCandidate(c);
        } catch (err) {
          this.onError(err);
        }
      }
    }

    async _syncTracksToPeer(pc) {
      const senders = pc.getSenders();
      const stream = this._isSharing && this.screenStream
        ? this._mergedShareStream()
        : this.localStream;

      if (!stream) return;

      const audioTrack = stream.getAudioTracks()[0] || null;
      const videoTrack = stream.getVideoTracks()[0] || null;

      const audioSender = senders.find((s) => s.track && s.track.kind === 'audio')
        || senders.find((s) => !s.track && s.track === null && false)
        || senders.find((s) => (s.track == null) && (!s._kind || s._kind === 'audio'));
      const videoSender = senders.find((s) => s.track && s.track.kind === 'video');

      // Prefer replaceTrack on existing senders
      let hasAudioSender = false;
      let hasVideoSender = false;
      for (const sender of senders) {
        if (sender.track?.kind === 'audio' || (!sender.track && sender._wantedKind === 'audio')) {
          hasAudioSender = true;
          await sender.replaceTrack(audioTrack);
        }
        if (sender.track?.kind === 'video' || (!sender.track && sender._wantedKind === 'video')) {
          hasVideoSender = true;
          await sender.replaceTrack(videoTrack);
        }
      }

      // Fallback: find senders by previous kind via transceiver
      for (const transceiver of pc.getTransceivers()) {
        if (transceiver.sender) {
          if (transceiver.receiver.track?.kind === 'audio' || transceiver.mid != null) {
            // handled below more carefully
          }
        }
      }

      if (!hasAudioSender && audioTrack) {
        const s = pc.addTrack(audioTrack, stream);
        s._wantedKind = 'audio';
      }
      if (!hasVideoSender && videoTrack) {
        const s = pc.addTrack(videoTrack, stream);
        s._wantedKind = 'video';
      }

      // Trigger renegotiation for polite/impolite as needed
      // Rely on negotiationneeded
      pc.onnegotiationneeded = async () => {
        // Find peer id
        for (const [id, p] of this.peers) {
          if (p.pc === pc) {
            await this._makeOffer(id);
            break;
          }
        }
      };
    }

    _mergedShareStream() {
      if (this._sharePreviewStream && this._isSharing) {
        return this._sharePreviewStream;
      }
      const stream = new MediaStream();
      if (this.localStream) {
        this.localStream.getAudioTracks().forEach((t) => stream.addTrack(t));
      }
      if (this.screenStream) {
        this.screenStream.getVideoTracks().forEach((t) => stream.addTrack(t));
      }
      this._sharePreviewStream = stream;
      return stream;
    }

    async startScreenShare() {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('Screen sharing is not supported in this browser.');
      }
      // Prefer a window/tab — sharing the full screen that shows this meeting causes a mirror loop.
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'window',
        },
        audio: false,
        preferCurrentTab: false,
      });
      this.screenStream = display;
      this._sharePreviewStream = null;
      this._isSharing = true;

      const screenTrack = display.getVideoTracks()[0];
      screenTrack.onended = () => {
        this.stopScreenShare().catch((err) => this.onError(err));
      };

      for (const [, peer] of this.peers) {
        const videoSender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (videoSender) {
          await videoSender.replaceTrack(screenTrack);
        } else {
          peer.pc.addTrack(screenTrack, display);
          await this._makeOffer([...this.peers.entries()].find(([, p]) => p === peer)[0]);
        }
      }
      return display;
    }

    async stopScreenShare() {
      if (!this._isSharing) return;
      this._isSharing = false;
      this._sharePreviewStream = null;
      const cameraTrack = this.localStream?.getVideoTracks()[0] || null;

      for (const [, peer] of this.peers) {
        const videoSender = peer.pc.getSenders().find((s) =>
          s.track && (s.track.kind === 'video' || s.track.readyState === 'ended')
        ) || peer.pc.getSenders().find((s) => !s.track);
        // Prefer existing video sender
        const sender = peer.pc.getSenders().find((s) => s.track?.kind === 'video')
          || peer.pc.getSenders().find((s) => s.track == null);
        if (sender) {
          await sender.replaceTrack(cameraTrack);
        } else if (cameraTrack) {
          peer.pc.addTrack(cameraTrack, this.localStream);
        }
      }

      if (this.screenStream) {
        this.screenStream.getTracks().forEach((t) => t.stop());
        this.screenStream = null;
      }
    }

    isSharing() {
      return this._isSharing;
    }

    async syncPeers(participantIds) {
      const ids = new Set((participantIds || []).map(Number).filter((id) => id && id !== this.selfId));
      // Remove departed peers
      for (const id of [...this.peers.keys()]) {
        if (!ids.has(id)) {
          this.closePeer(id);
        }
      }
      // Ensure peers for current participants
      for (const id of ids) {
        await this.ensurePeer(id);
      }
    }

    async _recoverPeer(peerId) {
      this.closePeer(peerId);
      await this.ensurePeer(peerId);
    }

    closePeer(peerId) {
      const peer = this.peers.get(peerId);
      if (!peer) return;
      try {
        peer.pc.onicecandidate = null;
        peer.pc.ontrack = null;
        peer.pc.onconnectionstatechange = null;
        peer.pc.close();
      } catch (_) { /* ignore */ }
      this.peers.delete(peerId);
      this.onPeerState(peerId, 'closed');
    }

    closeAll() {
      for (const id of [...this.peers.keys()]) {
        this.closePeer(id);
      }
      this.stopLocalMedia();
    }

    onSpeakingChange(cb) {
      this._onSpeakingChange = cb;
    }

    _setupSpeakingDetector() {
      this._teardownSpeakingDetector();
      const track = this.localStream?.getAudioTracks()[0];
      if (!track || typeof AudioContext === 'undefined') return;

      try {
        this._audioContext = new AudioContext();
        const source = this._audioContext.createMediaStreamSource(new MediaStream([track]));
        this._analyser = this._audioContext.createAnalyser();
        this._analyser.fftSize = 512;
        source.connect(this._analyser);
        const data = new Uint8Array(this._analyser.frequencyBinCount);

        const tick = () => {
          if (!this._analyser) return;
          this._analyser.getByteFrequencyData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i];
          const avg = sum / data.length;
          const speaking = avg > 18;
          if (speaking !== this._speaking) {
            this._speaking = speaking;
            if (typeof this._onSpeakingChange === 'function') {
              this._onSpeakingChange(speaking);
            }
          }
          this._speakingTimer = requestAnimationFrame(tick);
        };
        this._speakingTimer = requestAnimationFrame(tick);
      } catch (_) {
        // Audio analysis is best-effort
      }
    }

    _teardownSpeakingDetector() {
      if (this._speakingTimer) {
        cancelAnimationFrame(this._speakingTimer);
        this._speakingTimer = null;
      }
      if (this._audioContext) {
        this._audioContext.close().catch(() => {});
        this._audioContext = null;
      }
      this._analyser = null;
      this._speaking = false;
    }

    getLocalStream() {
      return this._isSharing && this.screenStream
        ? this._mergedShareStream()
        : this.localStream;
    }
  }

  global.ConnectMeetWebRTC = WebRTCEngine;
})(window);
