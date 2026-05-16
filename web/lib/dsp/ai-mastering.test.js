import { describe, expect, it, beforeAll } from 'vitest';
import {
  analyzeAIGeneratedMastering,
  applyAIGeneratedMasteringRepair,
  applyLimiterStressGuard,
  applyReferenceMatch,
  applyStereoStabilityGuard,
  applyPianoHighArtifactSuppressor,
  chooseAIMasteringProfile,
  getAIMasteringRecommendation,
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

function rmsDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum / a.length);
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

function makeStableWideBuffer({ sampleRate = 48000, seconds = 1 }) {
  const length = sampleRate * seconds;
  const buffer = new TestAudioBuffer({ numberOfChannels: 2, length, sampleRate });
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const mid = Math.sin(2 * Math.PI * 900 * t) * 0.12;
    const side = Math.sin(2 * Math.PI * 3400 * t) * 0.045;
    left[i] = mid + side;
    right[i] = mid - side;
  }

  return buffer;
}

function makeQuietIntroHarshChorusBuffer({ sampleRate = 48000 }) {
  const seconds = 5;
  const length = sampleRate * seconds;
  const buffer = new TestAudioBuffer({ numberOfChannels: 2, length, sampleRate });

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const isChorus = t >= 3.2;
      const level = isChorus ? 1 : 0.08;
      const harsh = isChorus ? Math.sin(2 * Math.PI * 7800 * t) * 0.22 : 0;
      data[i] =
        Math.sin(2 * Math.PI * 120 * t) * 0.08 * level +
        Math.sin(2 * Math.PI * 900 * t) * 0.08 * level +
        harsh;
    }
  }

  return buffer;
}

function makeSteadyActiveBuffer({ sampleRate = 48000, seconds = 24 }) {
  const length = sampleRate * seconds;
  const buffer = new TestAudioBuffer({ numberOfChannels: 2, length, sampleRate });

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      data[i] =
        Math.sin(2 * Math.PI * 120 * t) * 0.1 +
        Math.sin(2 * Math.PI * 900 * t) * 0.08;
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

    expect(['universal', 'balanced', 'natural', 'punchy', 'loud', 'spatial']).toContain(profile.name);
    expect(profile.maxLimiterPushDB).toBeGreaterThan(0.9);
  });

  it('keeps clean balanced sources mostly untouched by artifact gates', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [120, 0.12],
        [900, 0.08],
        [3000, 0.03],
        [11000, 0.015]
      ]
    });

    const repaired = applyAIGeneratedMasteringRepair(buffer, {
      profile: 'universal',
      sibilanceProtection: 0.7,
      artifactProtection: 0.7
    });

    expect(Math.abs(repaired.moves.sibilanceCut)).toBeLessThan(0.2);
    expect(Math.abs(repaired.moves.metallicCut)).toBeLessThan(0.25);
  });

  it('respects the clean low end control inside AI repair', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [25, 0.22],
        [120, 0.08],
        [900, 0.05]
      ]
    });

    const bypassed = applyAIGeneratedMasteringRepair(buffer, {
      profile: 'universal',
      cleanLowEnd: false
    });
    const cleaned = applyAIGeneratedMasteringRepair(buffer, {
      profile: 'universal',
      cleanLowEnd: true
    });

    const bypassedSub = analyzeAIGeneratedMastering(bypassed.buffer).bands.sub;
    const cleanedSub = analyzeAIGeneratedMastering(cleaned.buffer).bands.sub;
    expect(cleanedSub).toBeLessThan(bypassedSub);
  });

  it('weights tonal analysis toward the loudest important section', () => {
    const buffer = makeQuietIntroHarshChorusBuffer({});
    const analysis = analyzeAIGeneratedMastering(buffer);
    const profile = chooseAIMasteringProfile(analysis);

    expect(analysis.activeRatio).toBeLessThan(1);
    expect(analysis.loudestRatio).toBeLessThan(analysis.activeRatio);
    expect(analysis.profile.harshDB).toBeGreaterThan(-13);
    expect(profile.name).toBe('clean');
  });

  it('keeps enough loudest-section duration for stable mastering decisions', () => {
    const buffer = makeSteadyActiveBuffer({});
    const analysis = analyzeAIGeneratedMastering(buffer);

    expect(analysis.activeRatio).toBeGreaterThan(0.95);
    expect(analysis.loudestRatio).toBeGreaterThan(0.25);
    expect(analysis.loudestRatio).toBeLessThan(0.35);
  });

  it('uses oversampled true peak for source headroom analysis', () => {
    const buffer = new TestAudioBuffer({ numberOfChannels: 1, length: 8, sampleRate: 48000 });
    buffer.getChannelData(0).set([0, 0.72, 0.97, 0.72, 0, 0, 0, 0]);

    const samplePeakDB = 20 * Math.log10(0.97);
    const truePeakDB = findTruePeak(buffer);
    const analysis = analyzeAIGeneratedMastering(buffer);

    expect(truePeakDB).toBeGreaterThan(samplePeakDB);
    expect(analysis.peak).toBeGreaterThan(0.97);
    expect(analysis.peaks.truePeakHeadroomDB).toBeCloseTo(-truePeakDB, 1);
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

  it('keeps dark non-fragile sources from becoming muffled', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [120, 0.08],
        [450, 0.06],
        [900, 0.08],
        [3600, 0.01],
        [12500, 0.006]
      ]
    });

    const repaired = applyAIGeneratedMasteringRepair(buffer, {
      profile: 'clarity',
      intensity: 1,
      sibilanceProtection: 0.7,
      artifactProtection: 0.7
    });

    expect(repaired.moves.presenceCut).toBeGreaterThan(0);
    expect(repaired.moves.airShelf).toBeGreaterThan(0);
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

  it('keeps reference matching gentle on fragile high-frequency sources', () => {
    const source = makeToneBuffer({
      frequencies: [
        [120, 0.08],
        [900, 0.08],
        [7800, 0.22],
        [10800, 0.2]
      ]
    });
    const reference = makeToneBuffer({
      frequencies: [
        [120, 0.08],
        [900, 0.08],
        [12500, 0.28]
      ]
    });

    const matched = applyReferenceMatch(source, analyzeAIGeneratedMastering(reference), {
      amount: 1
    });

    expect(matched.moves.airMatch).toBeLessThan(0.8);
    expect(matched.moves.harshMatch).toBeLessThan(0.5);
  });

  it('matches reference stereo width gently when the reference image is stable', () => {
    const source = makeToneBuffer({
      frequencies: [
        [120, 0.08],
        [900, 0.08],
        [3800, 0.03]
      ]
    });
    const reference = makeStableWideBuffer({});
    const before = analyzeAIGeneratedMastering(source);

    const matched = applyReferenceMatch(source, analyzeAIGeneratedMastering(reference), {
      amount: 1
    });
    const after = analyzeAIGeneratedMastering(matched.buffer);

    expect(matched.moves.stereoWidthScale).toBeGreaterThan(1);
    expect(matched.moves.stereoWidthScale).toBeLessThanOrEqual(1.08);
    expect(after.stereo.sideToMidDB).toBeGreaterThan(before.stereo.sideToMidDB);
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

  it('keeps limiter stress guard from over-darkening veiled sources', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [120, 0.08],
        [450, 0.07],
        [900, 0.08],
        [3600, 0.01],
        [12500, 0.004]
      ]
    });

    const guarded = applyLimiterStressGuard(buffer, {
      targetLufs: -10,
      intensity: 1.2,
      amount: 1
    });

    expect(Math.abs(guarded.moves.presenceCut)).toBeLessThan(0.25);
    expect(Math.abs(guarded.moves.airShelf)).toBeLessThan(0.2);
    expect(guarded.moves.metallicCut).toBeLessThanOrEqual(0);
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

  it('recommends safer auto settings for low-bitrate pinned sources', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [90, 0.5],
        [3800, 0.25],
        [10800, 0.22]
      ]
    });
    const analysis = analyzeAIGeneratedMastering(buffer);
    const recommendation = getAIMasteringRecommendation(analysis, {
      bitrateKbps: 128,
      isLossy: true
    });

    expect(recommendation.targetLufs).toBeLessThanOrEqual(-13);
    expect(recommendation.truePeakCeiling).toBeLessThanOrEqual(-1);
    expect(recommendation.limiterCharacter).toBe('transparent');
    expect(recommendation.artifactProtection).toBeGreaterThanOrEqual(75);
    expect(recommendation.addPunch).toBe(false);
    expect(recommendation.tapeWarmth).toBe(false);
    expect(recommendation.glueCompression).toBe(false);
    expect(recommendation.reasons.percussiveArtifactRisk).toBe(true);
  });

  it('raises metallic protection to piano-safe range for lossy high-note artifact risk', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [880, 0.12],
        [3520, 0.08],
        [7040, 0.08],
        [10800, 0.2]
      ]
    });
    const recommendation = getAIMasteringRecommendation(
      analyzeAIGeneratedMastering(buffer),
      { bitrateKbps: 192, isLossy: true }
    );

    expect(recommendation.artifactProtection).toBeGreaterThanOrEqual(85);
    expect(recommendation.artifactProtection).toBeLessThan(90);
    expect(recommendation.truePeakCeiling).toBeLessThanOrEqual(-1.5);
    expect(recommendation.targetLufs).toBeLessThanOrEqual(-14.5);
    expect(recommendation.limiterCharacter).toBe('transparent');
    expect(recommendation.addAir).toBe(false);
    expect(recommendation.reasons.pianoHighArtifactRisk).toBe(true);
  });

  it('keeps clean lossy sources below manual metallic rescue strength', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [120, 0.1],
        [900, 0.08],
        [3200, 0.025],
        [9500, 0.01]
      ]
    });
    const recommendation = getAIMasteringRecommendation(
      analyzeAIGeneratedMastering(buffer),
      { bitrateKbps: 256, isLossy: true }
    );

    expect(recommendation.artifactProtection).toBeGreaterThanOrEqual(75);
    expect(recommendation.artifactProtection).toBeLessThan(90);
    expect(recommendation.addAir).toBe(false);
  });

  it('can raise protection for wav sources when analysis shows piano-like high artifact risk', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [880, 0.12],
        [3520, 0.08],
        [7040, 0.08],
        [10800, 0.22]
      ]
    });
    const recommendation = getAIMasteringRecommendation(
      analyzeAIGeneratedMastering(buffer),
      { isLossy: false }
    );

    expect(recommendation.artifactProtection).toBeGreaterThanOrEqual(85);
    expect(recommendation.artifactProtection).toBeLessThan(90);
    expect(recommendation.reasons.pianoHighArtifactRisk).toBe(true);
  });

  it('returns every UI control needed to reset AI Auto from analysis', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [90, 0.18],
        [280, 0.12],
        [900, 0.1],
        [4200, 0.08],
        [10500, 0.05]
      ]
    });
    const recommendation = getAIMasteringRecommendation(
      analyzeAIGeneratedMastering(buffer),
      { bitrateKbps: 192, isLossy: true }
    );
    const requiredKeys = [
      'inputGain',
      'targetLufs',
      'truePeakCeiling',
      'limiterCharacter',
      'aiIntensity',
      'sibilanceProtection',
      'artifactProtection',
      'referenceAmount',
      'stereoWidth',
      'centerBass',
      'cleanLowEnd',
      'glueCompression',
      'deharsh',
      'autoLevel',
      'addPunch',
      'addAir',
      'cutMud',
      'tapeWarmth'
    ];

    for (const key of requiredKeys) {
      expect(recommendation).toHaveProperty(key);
    }
    expect(Number.isFinite(recommendation.inputGain)).toBe(true);
    expect(Number.isFinite(recommendation.targetLufs)).toBe(true);
    expect(Number.isFinite(recommendation.truePeakCeiling)).toBe(true);
    expect(Number.isFinite(recommendation.aiIntensity)).toBe(true);
    expect(Number.isFinite(recommendation.sibilanceProtection)).toBe(true);
    expect(Number.isFinite(recommendation.artifactProtection)).toBe(true);
  });

  it('uses clarity without forced air for dark but safe lossy sources', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [120, 0.08],
        [450, 0.08],
        [900, 0.09],
        [3600, 0.01],
        [12500, 0.004]
      ]
    });
    const analysis = analyzeAIGeneratedMastering(buffer);
    const profile = chooseAIMasteringProfile(analysis);
    const recommendation = getAIMasteringRecommendation(analysis, {
      bitrateKbps: 256,
      isLossy: true
    });

    expect(profile.name).toBe('clarity');
    expect(recommendation.addAir).toBe(false);
    expect(recommendation.cutMud).toBe(true);
    expect(recommendation.artifactProtection).toBeGreaterThanOrEqual(75);
  });

  it('opens veiled low-bitrate sources with mud cleanup instead of forced air', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [120, 0.08],
        [280, 0.18],
        [900, 0.08],
        [3600, 0.012],
        [12500, 0.003]
      ]
    });
    const analysis = analyzeAIGeneratedMastering(buffer);
    const recommendation = getAIMasteringRecommendation(analysis, {
      bitrateKbps: 128,
      isLossy: true
    });

    expect(recommendation.cutMud).toBe(true);
    expect(recommendation.addAir).toBe(false);
    expect(recommendation.truePeakCeiling).toBeLessThanOrEqual(-1.5);
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

  it('suppresses isolated high-note piano crackle without dulling the tone', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [880, 0.08],
        [1760, 0.05],
        [3520, 0.025]
      ]
    });
    const channel = buffer.getChannelData(0);
    channel[1200] += 0.24;
    channel[3600] -= 0.22;

    const repaired = applyPianoHighArtifactSuppressor(buffer, { amount: 0.8 });
    const out = repaired.getChannelData(0);

    expect(Math.abs(out[1200] - channel[1200])).toBeGreaterThan(0.05);
    expect(Math.abs(out[3600] - channel[3600])).toBeGreaterThan(0.05);
    expect(Math.abs(out[2000] - channel[2000])).toBeLessThan(0.01);
  });

  it('reduces alternating high-note crackle bursts', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [1320, 0.06],
        [2640, 0.04],
        [5280, 0.02]
      ]
    });
    const channel = buffer.getChannelData(0);
    const before = [1400, 1402, 1404].map((idx, n) => {
      channel[idx] += n % 2 === 0 ? 0.18 : -0.16;
      return channel[idx];
    });

    const repaired = applyPianoHighArtifactSuppressor(buffer, { amount: 0.85 });
    const out = repaired.getChannelData(0);

    expect(Math.abs(out[1400] - before[0])).toBeGreaterThan(0.03);
    expect(Math.abs(out[1402] - before[1])).toBeGreaterThan(0.03);
    expect(Math.abs(out[1404] - before[2])).toBeGreaterThan(0.03);
  });

  it('uses stronger piano decrackle when metallic protection is near 90', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [1320, 0.06],
        [2640, 0.04],
        [5280, 0.02]
      ]
    });
    const channel = buffer.getChannelData(0);
    channel[2200] += 0.08;
    channel[2202] -= 0.075;

    const light = applyPianoHighArtifactSuppressor(buffer, {
      amount: 0.65,
      sensitivity: 0.45
    });
    const strong = applyPianoHighArtifactSuppressor(buffer, {
      amount: 0.96,
      sensitivity: 0.99
    });

    const lightReduction = Math.abs(light.getChannelData(0)[2200] - channel[2200]);
    const strongReduction = Math.abs(strong.getChannelData(0)[2200] - channel[2200]);
    expect(strongReduction).toBeGreaterThan(lightReduction + 0.01);
  });

  it('does not dull clean sustained high piano harmonics', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [1046.5, 0.06],
        [2093, 0.04],
        [4186, 0.025],
        [8372, 0.01]
      ]
    });
    const before = buffer.getChannelData(0).slice();
    const repaired = applyPianoHighArtifactSuppressor(buffer, { amount: 0.85 });
    const after = repaired.getChannelData(0);

    expect(rmsDiff(before, after)).toBeLessThan(0.003);
  });
});
