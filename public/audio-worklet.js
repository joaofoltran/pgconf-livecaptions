// Runs on the audio thread and keeps capturing even when the tab is in the background,
// where Chrome throttles the main-thread ScriptProcessor.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.length = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      this.chunks.push(new Float32Array(channel));
      this.length += channel.length;
      if (this.length >= 2048) {
        const merged = new Float32Array(this.length);
        let offset = 0;
        for (const chunk of this.chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        this.port.postMessage(merged, [merged.buffer]);
        this.chunks = [];
        this.length = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
