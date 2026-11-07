/**
 * Decimate device audio → 16 kHz Int16 for /ws/voice uplink (spec 173 §D).
 * Loaded as an AudioWorklet — keep this file in `public/` so the URL is stable.
 */
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.phase = 0;
    this.lastRms = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input?.[0]?.length) return true;
    const ch = input[0];
    let sum = 0;
    for (let i = 0; i < ch.length; i += 1) {
      const v = ch[i];
      sum += v * v;
    }
    this.lastRms = Math.sqrt(sum / ch.length);

    const out = [];
    for (let i = 0; i < ch.length; i += 1) {
      this.phase += 1;
      if (this.phase < this.ratio) continue;
      this.phase -= this.ratio;
      const sample = Math.max(-1, Math.min(1, ch[i]));
      out.push((sample * 32767) | 0);
    }

    if (out.length) {
      const pcm = new Int16Array(out);
      this.port.postMessage({ pcm: pcm.buffer, rms: this.lastRms }, [pcm.buffer]);
    } else {
      this.port.postMessage({ rms: this.lastRms });
    }
    return true;
  }
}

registerProcessor("voice-capture-processor", VoiceCaptureProcessor);
