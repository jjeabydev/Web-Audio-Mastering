import { describe, expect, it, beforeAll } from 'vitest';
import {
  analyzeAIGeneratedMastering,
  applyAIGeneratedMasteringRepair,
  applyReferenceMatch,
  chooseAIMasteringProfile,
  finalizeMasteringTarget
} from './ai-mastering.js';
import { findTruePeak } from './true-peak.js';

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

function makeToneBuffer({ sampleRate = 48000, seconds = 1, frequencies }) {
  const length = sampleRate * seconds;
  const buffer = new TestAudioBuffer({ numberOfChannels: 2, length, sampleRate });

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      let sample = 0;
      for (const [freq, amp] of frequencies) {
        sample += Math.sin(2 * Math.PI * freq * t) * amp;
      }
      data[i] = sample;
    }
  }

  return buffer;
}

describe('AI-generated mastering repair', () => {
  beforeAll(() => {
    globalThis.AudioBuffer = TestAudioBuffer;
  });

  it('detects and reduces harsh upper-band energy', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [120, 0.12],
        [900, 0.08],
        [7800, 0.28]
      ]
    });

    const before = analyzeAIGeneratedMastering(buffer);
    const repaired = applyAIGeneratedMasteringRepair(buffer);
    const after = analyzeAIGeneratedMastering(repaired.buffer);

    expect(repaired.profile.name).toBe('clean');
    expect(repaired.moves.harshCut).toBeLessThan(-0.5);
    expect(after.bands.harsh).toBeLessThan(before.bands.harsh);
  });

  it('selects a less aggressive profile for open, non-harsh material', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [90, 0.14],
        [800, 0.08],
        [2200, 0.04]
      ]
    });

    const profile = chooseAIMasteringProfile(analyzeAIGeneratedMastering(buffer));

    expect(['universal', 'balanced', 'natural', 'punchy', 'loud']).toContain(profile.name);
    expect(profile.maxLimiterPushDB).toBeGreaterThan(0.9);
  });

  it('applies profile tone and intensity to mastering moves', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [80, 0.18],
        [700, 0.08],
        [7800, 0.12]
      ]
    });

    const balanced = applyAIGeneratedMasteringRepair(buffer, {
      profile: 'universal',
      intensity: 1
    });
    const bass = applyAIGeneratedMasteringRepair(buffer, {
      profile: 'bass',
      intensity: 1.2
    });

    expect(bass.profile.name).toBe('bass');
    expect(bass.moves.bassLift).toBeGreaterThan(balanced.moves.bassLift);
    expect(Math.abs(bass.moves.harshCut)).toBeGreaterThanOrEqual(Math.abs(balanced.moves.harshCut));
  });

  it('increases targeted de-essing when sibilance protection is raised', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [900, 0.08],
        [6200, 0.05],
        [9200, 0.04]
      ]
    });

    const light = applyAIGeneratedMasteringRepair(buffer, {
      profile: 'clarity',
      sibilanceProtection: 0
    });
    const heavy = applyAIGeneratedMasteringRepair(buffer, {
      profile: 'clarity',
      sibilanceProtection: 0.7
    });

    expect(heavy.moves.sibilanceCut).toBeLessThan(light.moves.sibilanceCut);
  });

  it('moves tonal balance toward a reference without fully copying it', () => {
    const source = makeToneBuffer({
      frequencies: [
        [120, 0.06],
        [900, 0.12],
        [12500, 0.03]
      ]
    });
    const reference = makeToneBuffer({
      frequencies: [
        [120, 0.16],
        [900, 0.08],
        [12500, 0.1]
      ]
    });

    const matched = applyReferenceMatch(source, analyzeAIGeneratedMastering(reference), {
      amount: 0.65
    });

    expect(matched.moves).not.toBeNull();
    expect(Math.abs(matched.moves.bassShelf)).toBeGreaterThan(0);
    expect(Math.abs(matched.moves.airMatch)).toBeGreaterThan(0);
  });

  it('keeps final calibration under the requested ceiling', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [80, 0.45],
        [1000, 0.35]
      ]
    });

    const calibrated = finalizeMasteringTarget(buffer, {
      targetLufs: -12,
      ceilingDB: -1,
      toleranceDB: 0.1
    });

    expect(findTruePeak(calibrated.buffer)).toBeLessThanOrEqual(-0.95);
  });
});
