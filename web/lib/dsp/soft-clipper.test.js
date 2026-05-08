import { describe, expect, it, beforeAll } from 'vitest';
import { applyMasteringSoftClip } from './soft-clipper.js';

class TestAudioBuffer {
  constructor({ numberOfChannels, length, sampleRate }) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length)
    );
  }

  getChannelData(channel) {
    return this.channels[channel];
  }

  copyToChannel(source, channel, startInChannel = 0) {
    this.channels[channel].set(source, startInChannel);
  }
}

function createBuffer(samples, sampleRate = 48000) {
  const buffer = new TestAudioBuffer({
    numberOfChannels: 1,
    length: samples.length,
    sampleRate
  });
  buffer.copyToChannel(Float32Array.from(samples), 0);
  return buffer;
}

describe('mastering soft clipper', () => {
  beforeAll(() => {
    globalThis.AudioBuffer = TestAudioBuffer;
  });

  it('starts shaving peaks below the final ceiling', () => {
    const buffer = createBuffer(new Array(256).fill(0.8));
    const clipped = applyMasteringSoftClip(buffer, {
      ceiling: -1,
      lookaheadMs: 0,
      releaseMs: 10,
      drive: 1.5
    });

    expect(clipped.getChannelData(0)[128]).toBeLessThan(0.8);
  });

  it('does not darken samples that are below the clip threshold', () => {
    const samples = Array.from({ length: 256 }, (_, i) => i / 1024);
    const buffer = createBuffer(samples);
    const clipped = applyMasteringSoftClip(buffer, {
      ceiling: -1,
      lookaheadMs: 0,
      releaseMs: 10,
      drive: 1.5
    });

    expect(clipped.getChannelData(0)[128]).toBeCloseTo(samples[128], 6);
  });
});
