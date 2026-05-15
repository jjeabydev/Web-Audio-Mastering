import { describe, expect, it, beforeAll } from 'vitest';
import { applyFinalFilters, getAdaptiveFinalFilterOptions } from './final-filters.js';
import { calculateRMS } from './utils.js';

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

function makeSineBuffer(frequency, sampleRate = 48000, seconds = 1) {
  const length = sampleRate * seconds;
  const buffer = new TestAudioBuffer({ numberOfChannels: 1, length, sampleRate });
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.sin(2 * Math.PI * frequency * (i / sampleRate)) * 0.2;
  }
  return buffer;
}

describe('adaptive final filters', () => {
  beforeAll(() => {
    globalThis.AudioBuffer = TestAudioBuffer;
  });

  it('opens the final lowpass on already dark clean sources', () => {
    const options = getAdaptiveFinalFilterOptions({
      codecStress: 0.1,
      limiterRisk: 0.1,
      profile: {
        harshDB: -16,
        metallicDB: -18,
        airDB: -25
      }
    });

    expect(options.lowpass).toBe(false);
  });

  it('uses stronger cleanup on metallic high-frequency sources', () => {
    const options = getAdaptiveFinalFilterOptions({
      codecStress: 0.5,
      limiterRisk: 0.2,
      profile: {
        harshDB: -10,
        metallicDB: -12,
        airDB: -18
      }
    });

    expect(options.lowpass).toBe(true);
    expect(options.lowpassFreq).toBe(16500);
  });

  it('keeps 18k cleanup on moderately fragile clean sources', () => {
    const options = getAdaptiveFinalFilterOptions({
      codecStress: 0.38,
      limiterRisk: 0.2,
      profile: {
        harshDB: -13,
        metallicDB: -15,
        airDB: -18
      }
    });

    expect(options.lowpass).toBe(true);
    expect(options.lowpassFreq).toBe(18000);
  });

  it('preserves more high-frequency air with the open setting', () => {
    const buffer = makeSineBuffer(14000);
    const fixed = applyFinalFilters(buffer, {
      highpass: false,
      lowpass: true,
      lowpassFreq: 18000
    });
    const open = applyFinalFilters(buffer, {
      highpass: false,
      lowpass: false
    });

    expect(calculateRMS(open.getChannelData(0))).toBeGreaterThan(calculateRMS(fixed.getChannelData(0)));
  });
});
