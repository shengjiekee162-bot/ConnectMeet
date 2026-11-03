/**
 * ConnectMeet device settings and preferences.
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'connectmeet_prefs_v1';

  const Settings = {
    prefs: {
      displayName: '',
      audioDeviceId: '',
      videoDeviceId: '',
      outputDeviceId: '',
      captionsEnabled: false,
      captionsLang: 'en-US',
    },

    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          this.prefs = { ...this.prefs, ...parsed };
        }
      } catch (_) { /* ignore */ }
      return this.prefs;
    },

    save(partial = {}) {
      this.prefs = { ...this.prefs, ...partial };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.prefs));
      } catch (_) { /* ignore */ }
      return this.prefs;
    },

    async enumerate() {
      if (!navigator.mediaDevices?.enumerateDevices) {
        return { audioInputs: [], videoInputs: [], audioOutputs: [] };
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        audioInputs: devices.filter((d) => d.kind === 'audioinput'),
        videoInputs: devices.filter((d) => d.kind === 'videoinput'),
        audioOutputs: devices.filter((d) => d.kind === 'audiooutput'),
      };
    },

    async applyOutput(element, deviceId) {
      if (!element || !deviceId) return false;
      if (typeof element.setSinkId !== 'function') return false;
      try {
        await element.setSinkId(deviceId);
        return true;
      } catch (_) {
        return false;
      }
    },

    fillSelect(selectEl, devices, selectedId) {
      if (!selectEl) return;
      selectEl.innerHTML = '';
      if (!devices.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No devices found';
        selectEl.appendChild(opt);
        return;
      }
      devices.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `${d.kind} ${i + 1}`;
        if (selectedId && selectedId === d.deviceId) opt.selected = true;
        selectEl.appendChild(opt);
      });
    },

    createMeter(stream, canvas) {
      if (!stream || !canvas || typeof AudioContext === 'undefined') {
        return { stop() {} };
      }
      const track = stream.getAudioTracks()[0];
      if (!track) return { stop() {} };

      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const c = canvas.getContext('2d');
      let raf = null;
      let stopped = false;

      const draw = () => {
        if (stopped) return;
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const level = Math.min(1, (sum / data.length) / 80);
        const w = canvas.width;
        const h = canvas.height;
        c.clearRect(0, 0, w, h);
        c.fillStyle = '#1a3a3a';
        c.fillRect(0, 0, w, h);
        c.fillStyle = level > 0.7 ? '#e85d4c' : '#2dd4bf';
        c.fillRect(0, 0, Math.max(2, w * level), h);
        raf = requestAnimationFrame(draw);
      };
      draw();

      return {
        stop() {
          stopped = true;
          if (raf) cancelAnimationFrame(raf);
          ctx.close().catch(() => {});
        },
      };
    },

    async speakerTest(outputDeviceId) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) throw new Error('AudioContext not supported');
      const ctx = new AudioCtx();
      if (outputDeviceId && typeof ctx.setSinkId === 'function') {
        try { await ctx.setSinkId(outputDeviceId); } catch (_) { /* ignore */ }
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.05;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      setTimeout(() => {
        osc.stop();
        ctx.close().catch(() => {});
      }, 400);
    },
  };

  global.ConnectMeetSettings = Settings;
})(window);
