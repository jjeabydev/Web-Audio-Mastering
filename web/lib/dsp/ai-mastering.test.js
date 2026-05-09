import { describe, expect, it, beforeAll } from 'vitest';
import {
  analyzeAIGeneratedMastering,
  applyAIGeneratedMasteringRepair,
  applyLimiterStressGuard,
  applyReferenceMatch,
  applyStereoStabilityGuard,
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

function makeWidePhaseBuffer({ sampleRate = 48000, seconds = 1 }) {
  const length = sampleRate * seconds;
  const buffer = new TestAudioBuffer({ numberOfChannels: 2, length, sampleRate });
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const mid = Math.sin(2 * Math.PI * 900 * t) * 0.05;
    const wide = Math.sin(2 * Math.PI * 7500 * t) * 0.22;
    left[i] = mid + wide;
    right[i] = mid - wide;
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

  it('reduces metallic high-frequency ringing when artifact protection is raised', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [900, 0.08],
        [10800, 0.12],
        [11800, 0.08]
      ]
    });

    const before = analyzeAIGeneratedMastering(buffer);
    const light = applyAIGeneratedMasteringRepair(buffer, {
      profile: 'clean',
      artifactProtection: 0
    });
    const heavy = applyAIGeneratedMasteringRepair(buffer, {
      profile: 'clean',
      artifactProtection: 0.8
    });
    const after = analyzeAIGeneratedMastering(heavy.buffer);

    expect(heavy.moves.metallicCut).toBeLessThan(light.moves.metallicCut);
    expect(after.bands.metallic).toBeLessThan(before.bands.metallic);
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

  it('applies limiter stress guard before final peak control', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [90, 0.22],
        [280, 0.12],
        [3800, 0.16],
        [10800, 0.12]
      ]
    });

    const before = analyzeAIGeneratedMastering(buffer);
    const guarded = applyLimiterStressGuard(buffer, {
      targetLufs: -9,
      intensity: 1.2,
      amount: 1
    });
    const after = analyzeAIGeneratedMastering(guarded.buffer);

    expect(guarded.moves.presenceCut).toBeLessThan(0);
    expect(guarded.moves.metallicCut).toBeLessThan(0);
    expect(after.bands.presence).toBeLessThan(before.bands.presence);
    expect(after.bands.metallic).toBeLessThan(before.bands.metallic);
  });

  it('stabilizes excessive phasey stereo side energy', () => {
    const buffer = makeWidePhaseBuffer({});
    const before = analyzeAIGeneratedMastering(buffer);
    const guarded = applyStereoStabilityGuard(buffer, {
      amount: 1
    });
    const after = analyzeAIGeneratedMastering(guarded.buffer);

    expect(guarded.moves.risk).toBeGreaterThan(0.1);
    expect(guarded.moves.sideScale).toBeLessThan(1);
    expect(after.stereo.sideToMidDB).toBeLessThan(before.stereo.sideToMidDB);
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
