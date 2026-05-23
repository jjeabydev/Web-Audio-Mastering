import { describe, expect, it, beforeAll } from 'vitest';
import {
  analyzeAIGeneratedMastering,
  applyAIGeneratedMasteringRepair,
  applyLimiterStressGuard,
  applyReferenceMatch,
  applyStereoStabilityGuard,
  applyPianoHighArtifactSuppressor,
  applyVocalMidCrackleSuppressor,
  applyDynamicSibilanceSuppressor,
  applyAddedSibilanceGuard,
  applySourceDifferentialToneGuard,
  applySourceConstrainedSibilanceRepair,
  applySourceConstrainedVocalBuzzRepair,
  applyMetallicRescueTone,
  applyArtifactSafeAirRecovery,
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

function windowRms(data, start, end) {
  let sum = 0;
  let count = 0;
  for (let i = start; i < end; i++) {
    sum += data[i] * data[i];
    count++;
  }
  return Math.sqrt(sum / Math.max(1, count));
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

  it('detects click-style artifact risk outside the high bands', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [180, 0.1],
        [900, 0.08]
      ]
    });
    const channel = buffer.getChannelData(0);
    for (const idx of [2200, 4800, 7600, 11200]) {
      channel[idx] += 0.16;
      channel[idx + 1] -= 0.14;
    }

    const analysis = analyzeAIGeneratedMastering(buffer);
    const recommendation = getAIMasteringRecommendation(analysis, { isLossy: false });

    expect(analysis.peaks.spikeDensity).toBeGreaterThan(0);
    expect(recommendation.reasons.artifactRescueRisk).toBe(true);
    expect(recommendation.reasons.pianoHighArtifactRisk).toBe(true);
    expect(recommendation.artifactProtection).toBeGreaterThanOrEqual(85);
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

    expect(recommendation.artifactProtection).toBe(90);
    expect(recommendation.sibilanceProtection).toBeGreaterThanOrEqual(80);
    expect(recommendation.truePeakCeiling).toBeLessThanOrEqual(-1.5);
    expect(recommendation.targetLufs).toBe(-14);
    expect(recommendation.limiterCharacter).toBe('transparent');
    expect(recommendation.addAir).toBe(false);
    expect(recommendation.reasons.artifactRescueRisk).toBe(true);
    expect(recommendation.reasons.pianoHighArtifactRisk).toBe(true);
  });

  it('allows lossy rescue sources to reach metallic rescue strength', () => {
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

    expect(recommendation.artifactProtection).toBeLessThanOrEqual(90);
    expect(recommendation.addAir).toBe(false);
  });

  it('can raise protection for wav sources when analysis shows high artifact rescue risk', () => {
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

    expect(recommendation.artifactProtection).toBe(90);
    expect(recommendation.sibilanceProtection).toBeGreaterThanOrEqual(80);
    expect(recommendation.reasons.artifactRescueRisk).toBe(true);
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

  it('keeps harmonic tape warmth off for normal AI auto vocal masters', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [160, 0.06],
        [780, 0.055],
        [1800, 0.04],
        [3300, 0.025],
        [7200, 0.012]
      ]
    });
    const recommendation = getAIMasteringRecommendation(
      analyzeAIGeneratedMastering(buffer),
      { isLossy: false }
    );

    expect(recommendation.tapeWarmth).toBe(false);
    expect(recommendation.addAir).toBe(false);
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

  it('can cap transparent final calibration to one gentle boost pass', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [220, 0.02],
        [1200, 0.012],
        [6400, 0.006]
      ]
    });
    const before = windowRms(buffer.getChannelData(0), 0, buffer.length);

    const calibrated = finalizeMasteringTarget(buffer, {
      targetLufs: -8,
      ceilingDB: -1.5,
      toleranceDB: 0.1,
      maxLimiterPushDB: 0.45,
      maxPasses: 1
    });
    const after = windowRms(calibrated.buffer.getChannelData(0), 0, calibrated.buffer.length);

    expect(after / before).toBeLessThanOrEqual(Math.pow(10, 0.46 / 20));
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

  it('restores metallic rescue tone reduction at 90 without heavy broad dulling', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [1046.5, 0.05],
        [4186, 0.025],
        [7800, 0.08],
        [10800, 0.16]
      ]
    });
    const before = analyzeAIGeneratedMastering(buffer);
    const rescued = applyMetallicRescueTone(buffer, {
      amount: 1,
      artifactProtection: 0.9,
      sibilanceProtection: 0.8,
      isLossySource: false
    });
    const after = analyzeAIGeneratedMastering(rescued.buffer);

    expect(rescued.moves.metallicCut).toBeLessThan(-0.3);
    expect(after.bands.metallic).toBeLessThan(before.bands.metallic);
    expect(after.bands.body).toBeGreaterThan(before.bands.body * 0.85);
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

  it('suppresses vocal mid-high crackle bursts without muting the vocal band', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [220, 0.05],
        [880, 0.055],
        [2600, 0.035],
        [5200, 0.018]
      ]
    });
    const channel = buffer.getChannelData(0);
    const before = [9120, 9121, 9122, 9123].map((idx, n) => {
      channel[idx] += n % 2 === 0 ? 0.052 : -0.049;
      return channel[idx];
    });

    const repaired = applyVocalMidCrackleSuppressor(buffer, {
      amount: 0.8,
      sensitivity: 0.9
    });
    const out = repaired.getChannelData(0);

    expect(Math.abs(out[9120] - before[0])).toBeGreaterThan(0.006);
    expect(Math.abs(out[9121] - before[1])).toBeGreaterThan(0.006);
    expect(Math.abs(out[9122] - before[2])).toBeGreaterThan(0.006);
    expect(Math.abs(out[3000] - channel[3000])).toBeLessThan(0.004);
  });

  it('leaves clean vocal mid-high tone mostly unchanged', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [240, 0.05],
        [1200, 0.045],
        [3200, 0.026],
        [5600, 0.012]
      ]
    });
    const before = buffer.getChannelData(0).slice();
    const repaired = applyVocalMidCrackleSuppressor(buffer, {
      amount: 0.7,
      sensitivity: 0.82
    });
    const after = repaired.getChannelData(0);

    expect(rmsDiff(before, after)).toBeLessThan(0.0025);
  });

  it('reduces a short vocal tail crackle cluster', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [180, 0.045],
        [620, 0.052],
        [1450, 0.04],
        [3100, 0.028],
        [5400, 0.012]
      ]
    });
    const channel = buffer.getChannelData(0);
    const center = 14400;
    const injected = [];
    for (let n = -4; n <= 4; n++) {
      const idx = center + n;
      const burst = (n % 2 === 0 ? 1 : -1) * (0.022 + Math.max(0, 4 - Math.abs(n)) * 0.003);
      channel[idx] += burst;
      injected.push([idx, channel[idx]]);
    }

    const repaired = applyVocalMidCrackleSuppressor(buffer, {
      amount: 0.9,
      sensitivity: 0.96,
      clusterAmount: 0.48
    });
    const out = repaired.getChannelData(0);
    const changed = injected.reduce((sum, [idx, before]) => sum + Math.abs(out[idx] - before), 0);

    expect(changed).toBeGreaterThan(0.035);
    expect(Math.abs(out[center + 80] - channel[center + 80])).toBeLessThan(0.004);
  });

  it('dynamically reduces added sibilance bursts after final polish', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [190, 0.05],
        [760, 0.055],
        [1800, 0.04],
        [3300, 0.028]
      ]
    });
    const channel = buffer.getChannelData(0);
    const start = 16000;
    const end = start + 360;
    for (let i = start; i < end; i++) {
      const t = (i - start) / buffer.sampleRate;
      const envelope = Math.sin(Math.PI * (i - start) / (end - start));
      channel[i] += Math.sin(2 * Math.PI * 7600 * t) * 0.11 * envelope;
    }

    const before = windowRms(channel, start, end);
    const repaired = applyDynamicSibilanceSuppressor(buffer, {
      amount: 0.9,
      threshold: 0.28,
      maxCutDB: 4.5,
      airCutDB: 2.4,
      detectorFreq: 3900
    });
    const after = repaired.buffer.getChannelData(0);
    let changed = 0;
    for (let i = start; i < end; i++) {
      changed += Math.abs(after[i] - channel[i]);
    }

    expect(repaired.moves.activeRatio).toBeGreaterThan(0);
    expect(windowRms(after, start, end)).toBeLessThan(before * 0.9);
    expect(changed / (end - start)).toBeGreaterThan(0.0015);
  });

  it('leaves clean non-sibilant vocal tone mostly unchanged', () => {
    const buffer = makeToneBuffer({
      frequencies: [
        [220, 0.055],
        [880, 0.052],
        [1700, 0.04],
        [3200, 0.018]
      ]
    });
    const before = buffer.getChannelData(0).slice();
    const repaired = applyDynamicSibilanceSuppressor(buffer, {
      amount: 0.8,
      threshold: 0.34,
      detectorFreq: 3900
    });
    const after = repaired.buffer.getChannelData(0);

    expect(rmsDiff(before, after)).toBeLessThan(0.0015);
  });

  it('reduces sibilance that was added by processing but is not in the source', () => {
    const source = makeToneBuffer({
      frequencies: [
        [180, 0.06],
        [720, 0.05],
        [1600, 0.038],
        [3100, 0.022]
      ]
    });
    const processed = makeToneBuffer({
      frequencies: [
        [180, 0.06],
        [720, 0.05],
        [1600, 0.038],
        [3100, 0.022]
      ]
    });
    const channel = processed.getChannelData(0);
    const start = 18000;
    const end = start + 420;
    for (let i = start; i < end; i++) {
      const t = (i - start) / processed.sampleRate;
      const envelope = Math.sin(Math.PI * (i - start) / (end - start));
      channel[i] += Math.sin(2 * Math.PI * 7200 * t) * 0.095 * envelope;
    }

    const before = windowRms(channel, start, end);
    const guarded = applyAddedSibilanceGuard(processed, source, {
      amount: 0.95,
      threshold: 0.015,
      allowedIncrease: 0.02,
      maxCutDB: 5.5,
      airCutDB: 2.8
    });
    const after = guarded.buffer.getChannelData(0);

    expect(guarded.moves.activeRatio).toBeGreaterThan(0);
    expect(windowRms(after, start, end)).toBeLessThan(before * 0.88);
    expect(Math.abs(after[4000] - processed.getChannelData(0)[4000])).toBeLessThan(0.001);
  });

  it('does not remove sibilance that already exists in the source', () => {
    const source = makeToneBuffer({
      frequencies: [
        [220, 0.052],
        [900, 0.048],
        [2600, 0.026]
      ]
    });
    const processed = makeToneBuffer({
      frequencies: [
        [220, 0.052],
        [900, 0.048],
        [2600, 0.026]
      ]
    });
    for (const buffer of [source, processed]) {
      const channel = buffer.getChannelData(0);
      const start = 12000;
      const end = start + 300;
      for (let i = start; i < end; i++) {
        const t = (i - start) / buffer.sampleRate;
        const envelope = Math.sin(Math.PI * (i - start) / (end - start));
        channel[i] += Math.sin(2 * Math.PI * 7400 * t) * 0.07 * envelope;
      }
    }

    const before = processed.getChannelData(0).slice();
    const guarded = applyAddedSibilanceGuard(processed, source, {
      amount: 0.95,
      threshold: 0.015,
      allowedIncrease: 0.02
    });
    const after = guarded.buffer.getChannelData(0);

    expect(rmsDiff(before, after)).toBeLessThan(0.0015);
  });

  it('constrains processing-added sibilance toward the clean source band', () => {
    const source = makeToneBuffer({
      frequencies: [
        [170, 0.055],
        [740, 0.05],
        [1550, 0.038],
        [2900, 0.024]
      ]
    });
    const processed = makeToneBuffer({
      frequencies: [
        [170, 0.055],
        [740, 0.05],
        [1550, 0.038],
        [2900, 0.024]
      ]
    });
    const sourceChannel = source.getChannelData(0);
    const processedChannel = processed.getChannelData(0);
    const start = 15000;
    const end = start + 520;
    for (let i = start; i < end; i++) {
      const t = (i - start) / processed.sampleRate;
      const envelope = Math.sin(Math.PI * (i - start) / (end - start));
      processedChannel[i] += (
        Math.sin(2 * Math.PI * 6200 * t) * 0.07 +
        Math.sin(2 * Math.PI * 8500 * t) * 0.05
      ) * envelope;
    }

    const beforeDistance = windowRms(processedChannel, start, end) - windowRms(sourceChannel, start, end);
    const repaired = applySourceConstrainedSibilanceRepair(processed, source, {
      amount: 1,
      allowedIncrease: 0.01,
      threshold: 0.01,
      ratio: 0.22,
      maxMix: 0.82
    });
    const after = repaired.buffer.getChannelData(0);
    const afterDistance = windowRms(after, start, end) - windowRms(sourceChannel, start, end);

    expect(repaired.moves.activeRatio).toBeGreaterThan(0);
    expect(afterDistance).toBeLessThan(beforeDistance * 0.55);
    expect(Math.abs(after[4000] - processedChannel[4000])).toBeLessThan(0.0015);
  });

  it('leaves source-matched sibilance mostly unchanged in source-constrained repair', () => {
    const source = makeToneBuffer({
      frequencies: [
        [220, 0.05],
        [820, 0.046],
        [2500, 0.026]
      ]
    });
    const processed = makeToneBuffer({
      frequencies: [
        [220, 0.05],
        [820, 0.046],
        [2500, 0.026]
      ]
    });
    for (const buffer of [source, processed]) {
      const channel = buffer.getChannelData(0);
      const start = 9000;
      const end = start + 420;
      for (let i = start; i < end; i++) {
        const t = (i - start) / buffer.sampleRate;
        const envelope = Math.sin(Math.PI * (i - start) / (end - start));
        channel[i] += Math.sin(2 * Math.PI * 6900 * t) * 0.06 * envelope;
      }
    }

    const before = processed.getChannelData(0).slice();
    const repaired = applySourceConstrainedSibilanceRepair(processed, source, {
      amount: 1,
      allowedIncrease: 0.01,
      threshold: 0.01,
      maxMix: 0.82
    });
    const after = repaired.buffer.getChannelData(0);

    expect(rmsDiff(before, after)).toBeLessThan(0.0015);
  });

  it('reduces short vocal-band buzz added by processing but absent from the source', () => {
    const source = makeToneBuffer({
      frequencies: [
        [180, 0.06],
        [760, 0.05],
        [1450, 0.036],
        [2600, 0.022]
      ]
    });
    const processed = makeToneBuffer({
      frequencies: [
        [180, 0.06],
        [760, 0.05],
        [1450, 0.036],
        [2600, 0.022]
      ]
    });
    const sourceChannel = source.getChannelData(0);
    const processedChannel = processed.getChannelData(0);
    const start = 21000;
    const end = start + 360;
    for (let i = start; i < end; i++) {
      const t = (i - start) / processed.sampleRate;
      const envelope = Math.sin(Math.PI * (i - start) / (end - start));
      processedChannel[i] += (
        Math.sin(2 * Math.PI * 3300 * t) * 0.045 +
        (i % 2 === 0 ? 1 : -1) * 0.018
      ) * envelope;
    }

    const beforeDistance = windowRms(processedChannel, start, end) - windowRms(sourceChannel, start, end);
    const repaired = applySourceConstrainedVocalBuzzRepair(processed, source, {
      amount: 1,
      allowedIncrease: 0.01,
      threshold: 0.008,
      ratio: 0.18,
      maxMix: 0.82
    });
    const after = repaired.buffer.getChannelData(0);
    const afterDistance = windowRms(after, start, end) - windowRms(sourceChannel, start, end);

    expect(repaired.moves.activeRatio).toBeGreaterThan(0);
    expect(afterDistance).toBeLessThan(beforeDistance * 0.72);
    expect(Math.abs(after[6000] - processedChannel[6000])).toBeLessThan(0.0015);
  });

  it('leaves source-matched vocal buzz mostly unchanged', () => {
    const source = makeToneBuffer({
      frequencies: [
        [200, 0.058],
        [840, 0.048],
        [2400, 0.024]
      ]
    });
    const processed = makeToneBuffer({
      frequencies: [
        [200, 0.058],
        [840, 0.048],
        [2400, 0.024]
      ]
    });
    for (const buffer of [source, processed]) {
      const channel = buffer.getChannelData(0);
      const start = 17000;
      const end = start + 340;
      for (let i = start; i < end; i++) {
        const t = (i - start) / buffer.sampleRate;
        const envelope = Math.sin(Math.PI * (i - start) / (end - start));
        channel[i] += Math.sin(2 * Math.PI * 3400 * t) * 0.035 * envelope;
      }
    }

    const before = processed.getChannelData(0).slice();
    const repaired = applySourceConstrainedVocalBuzzRepair(processed, source, {
      amount: 1,
      allowedIncrease: 0.01,
      threshold: 0.008,
      maxMix: 0.82
    });
    const after = repaired.buffer.getChannelData(0);

    expect(rmsDiff(before, after)).toBeLessThan(0.0018);
  });

  it('reduces consonant-transition buzz across vocal phrase bands', () => {
    const source = makeToneBuffer({
      frequencies: [
        [190, 0.056],
        [720, 0.047],
        [1350, 0.035],
        [2300, 0.024],
        [3600, 0.014]
      ]
    });
    const processed = makeToneBuffer({
      frequencies: [
        [190, 0.056],
        [720, 0.047],
        [1350, 0.035],
        [2300, 0.024],
        [3600, 0.014]
      ]
    });
    const sourceChannel = source.getChannelData(0);
    const processedChannel = processed.getChannelData(0);

    for (const start of [14500, 23800, 31800]) {
      const end = start + 390;
      for (let i = start; i < end; i++) {
        const t = (i - start) / processed.sampleRate;
        const envelope = Math.sin(Math.PI * (i - start) / (end - start));
        processedChannel[i] += (
          Math.sin(2 * Math.PI * 2800 * t) * 0.026 +
          Math.sin(2 * Math.PI * 4100 * t) * 0.024 +
          (i % 3 === 0 ? 1 : -0.5) * 0.014
        ) * envelope;
      }
    }

    const beforeDistance = windowRms(processedChannel, 14000, 32500) - windowRms(sourceChannel, 14000, 32500);
    const repaired = applySourceConstrainedVocalBuzzRepair(processed, source, {
      amount: 1,
      allowedIncrease: 0.008,
      threshold: 0.006,
      ratio: 0.18,
      maxMix: 0.84
    });
    const after = repaired.buffer.getChannelData(0);
    const afterDistance = windowRms(after, 14000, 32500) - windowRms(sourceChannel, 14000, 32500);

    expect(repaired.moves.activeRatio).toBeGreaterThan(0);
    expect(afterDistance).toBeLessThan(beforeDistance * 0.76);
  });

  it('reduces metallic buzz on plucked guitar-like transients', () => {
    const source = makeToneBuffer({
      frequencies: [
        [110, 0.045],
        [220, 0.036],
        [440, 0.028],
        [880, 0.02],
        [1760, 0.014]
      ]
    });
    const processed = makeToneBuffer({
      frequencies: [
        [110, 0.045],
        [220, 0.036],
        [440, 0.028],
        [880, 0.02],
        [1760, 0.014]
      ]
    });
    const sourceChannel = source.getChannelData(0);
    const processedChannel = processed.getChannelData(0);

    for (const start of [9000, 18400, 27600]) {
      const end = start + 520;
      for (let i = start; i < end; i++) {
        const t = (i - start) / processed.sampleRate;
        const envelope = Math.exp(-(i - start) / 160) * Math.sin(Math.PI * (i - start) / (end - start));
        processedChannel[i] += (
          Math.sin(2 * Math.PI * 3300 * t) * 0.034 +
          Math.sin(2 * Math.PI * 6200 * t) * 0.026
        ) * envelope;
      }
    }

    const beforeDistance = windowRms(processedChannel, 8500, 28200) - windowRms(sourceChannel, 8500, 28200);
    const repaired = applySourceConstrainedVocalBuzzRepair(processed, source, {
      amount: 1,
      allowedIncrease: 0.008,
      threshold: 0.006,
      ratio: 0.18,
      maxMix: 0.84
    });
    const after = repaired.buffer.getChannelData(0);
    const afterDistance = windowRms(after, 8500, 28200) - windowRms(sourceChannel, 8500, 28200);

    expect(repaired.moves.activeRatio).toBeGreaterThan(0);
    expect(afterDistance).toBeLessThan(beforeDistance * 0.78);
  });

  it('reduces low-level sibilant fizz bed added across the whole master', () => {
    const source = makeToneBuffer({
      frequencies: [
        [180, 0.06],
        [760, 0.05],
        [1600, 0.034],
        [2600, 0.02]
      ]
    });
    const processed = makeToneBuffer({
      frequencies: [
        [180, 0.06],
        [760, 0.05],
        [1600, 0.034],
        [2600, 0.02]
      ]
    });
    const sourceChannel = source.getChannelData(0);
    const processedChannel = processed.getChannelData(0);
    for (let i = 0; i < processed.length; i++) {
      const t = i / processed.sampleRate;
      processedChannel[i] += (
        Math.sin(2 * Math.PI * 6200 * t) * 0.005 +
        Math.sin(2 * Math.PI * 7800 * t) * 0.004 +
        (i % 2 === 0 ? 1 : -1) * 0.002
      );
    }

    const beforeDistance = windowRms(processedChannel, 0, processed.length) - windowRms(sourceChannel, 0, source.length);
    const repaired = applySourceConstrainedVocalBuzzRepair(processed, source, {
      amount: 1,
      allowedIncrease: 0.006,
      threshold: 0.005,
      ratio: 0.16,
      maxMix: 0.76
    });
    const after = repaired.buffer.getChannelData(0);
    const afterDistance = windowRms(after, 0, after.length) - windowRms(sourceChannel, 0, source.length);

    expect(repaired.moves.activeRatio).toBeGreaterThan(0);
    expect(afterDistance).toBeLessThan(beforeDistance * 0.82);
  });

  it('does not build up new vocal fizz when the source-constrained repair is repeated', () => {
    const source = makeToneBuffer({
      frequencies: [
        [170, 0.058],
        [690, 0.048],
        [1420, 0.034],
        [2500, 0.022],
        [3900, 0.012]
      ]
    });
    const processed = makeToneBuffer({
      frequencies: [
        [170, 0.058],
        [690, 0.048],
        [1420, 0.034],
        [2500, 0.022],
        [3900, 0.012]
      ]
    });
    const sourceChannel = source.getChannelData(0);
    const processedChannel = processed.getChannelData(0);
    for (const start of [11000, 19400, 28700, 36500]) {
      const end = start + 430;
      for (let i = start; i < end; i++) {
        const t = (i - start) / processed.sampleRate;
        const envelope = Math.sin(Math.PI * (i - start) / (end - start));
        processedChannel[i] += (
          Math.sin(2 * Math.PI * 3100 * t) * 0.018 +
          Math.sin(2 * Math.PI * 5300 * t) * 0.014 +
          (i % 2 === 0 ? 1 : -1) * 0.007
        ) * envelope;
      }
    }

    const beforeDistance = windowRms(processedChannel, 10000, 37000) - windowRms(sourceChannel, 10000, 37000);
    const first = applySourceConstrainedVocalBuzzRepair(processed, source, {
      amount: 0.78,
      allowedIncrease: 0.01,
      threshold: 0.011,
      ratio: 0.24,
      maxMix: 0.62,
      maxBandReduction: 0.58,
      phaseSafe: true,
      attackMs: 0.85,
      releaseMs: 135
    });
    const second = applySourceConstrainedVocalBuzzRepair(first.buffer, source, {
      amount: 0.76,
      allowedIncrease: 0.01,
      threshold: 0.011,
      ratio: 0.24,
      maxMix: 0.6,
      maxBandReduction: 0.56,
      phaseSafe: true,
      attackMs: 0.95,
      releaseMs: 145
    });
    const firstChannel = first.buffer.getChannelData(0);
    const secondChannel = second.buffer.getChannelData(0);
    const firstDistance = windowRms(firstChannel, 10000, 37000) - windowRms(sourceChannel, 10000, 37000);
    const secondDistance = windowRms(secondChannel, 10000, 37000) - windowRms(sourceChannel, 10000, 37000);

    expect(first.moves.activeRatio).toBeGreaterThan(0);
    expect(firstDistance).toBeLessThan(beforeDistance * 0.86);
    expect(secondDistance).toBeLessThanOrEqual(firstDistance * 1.05);
    expect(rmsDiff(firstChannel, secondChannel)).toBeLessThan(0.004);
  });

  it('reduces broad added fizz tone compared with the source', () => {
    const source = makeToneBuffer({
      frequencies: [
        [180, 0.08],
        [850, 0.06],
        [2200, 0.035],
        [4200, 0.01]
      ]
    });
    const processed = makeToneBuffer({
      frequencies: [
        [180, 0.08],
        [850, 0.06],
        [2200, 0.035],
        [3900, 0.035],
        [7600, 0.042],
        [10500, 0.032]
      ]
    });

    const before = analyzeAIGeneratedMastering(processed);
    const guarded = applySourceDifferentialToneGuard(processed, source, {
      amount: 1,
      presenceAllowanceDB: 0.05,
      harshAllowanceDB: 0.05,
      metallicAllowanceDB: 0.05,
      airAllowanceDB: 0.05
    });
    const after = analyzeAIGeneratedMastering(guarded.buffer);

    expect(guarded.moves.skipped).toBe(false);
    expect(guarded.moves.sibilanceCut).toBeLessThan(0);
    expect(after.profile.harshDB).toBeLessThan(before.profile.harshDB);
    expect(after.profile.metallicDB).toBeLessThan(before.profile.metallicDB);
  });

  it('adds gentle air recovery only when artifact-safe audio is dark and not metallic', () => {
    const darkSafe = makeToneBuffer({
      frequencies: [
        [180, 0.1],
        [900, 0.08],
        [4200, 0.015],
        [12500, 0.004]
      ]
    });
    const brightMetallic = makeToneBuffer({
      frequencies: [
        [180, 0.1],
        [900, 0.08],
        [7800, 0.08],
        [10800, 0.14]
      ]
    });

    const recovered = applyArtifactSafeAirRecovery(darkSafe, { amount: 1 });
    const skipped = applyArtifactSafeAirRecovery(brightMetallic, { amount: 1 });

    expect(recovered.moves.skipped).toBe(false);
    expect(recovered.moves.airShelf).toBeGreaterThan(0);
    expect(skipped.moves.skipped).toBe(true);
  });

  it('can use a wider commercial-safe air target without changing the default guard', () => {
    const darkSafe = makeToneBuffer({
      frequencies: [
        [180, 0.1],
        [900, 0.08],
        [4200, 0.015],
        [12500, 0.004]
      ]
    });

    const gentle = applyArtifactSafeAirRecovery(darkSafe, { amount: 1 });
    const open = applyArtifactSafeAirRecovery(darkSafe, {
      amount: 1,
      targetAirDB: -12.9,
      airScale: 0.82,
      safeAirThresholdDB: -13.6,
      safeSpikeDensity: 0.015,
      maxAirShelf: 4,
      presenceScale: 0.11,
      intelligibilityScale: 0.08,
      maxPresenceLift: 0.45,
      maxIntelligibilityLift: 0.25,
      maxSpikeIncrease: 0.0028,
      absoluteSpikeFloor: 0.0145,
      maxHarshDB: -12.9,
      maxMetallicDB: -17
    });

    expect(gentle.moves.skipped).toBe(false);
    expect(open.moves.skipped).toBe(false);
    expect(open.moves.airShelf).toBeGreaterThan(gentle.moves.airShelf);
  });

  it('honors zero lift options during artifact-safe air recovery', () => {
    const darkSafe = makeToneBuffer({
      frequencies: [
        [180, 0.1],
        [900, 0.08],
        [4200, 0.015],
        [12500, 0.004]
      ]
    });

    const recovered = applyArtifactSafeAirRecovery(darkSafe, {
      amount: 0.2,
      targetAirDB: -15,
      airScale: 0,
      minAirShelf: 0,
      maxAirShelf: 0,
      presenceScale: 0,
      maxPresenceLift: 0,
      intelligibilityScale: 0,
      maxIntelligibilityLift: 0,
      safeAirThresholdDB: -14.8,
      safeSpikeDensity: 0.02
    });

    expect(recovered.moves.skipped).toBe(false);
    expect(recovered.moves.airShelf).toBe(0);
    expect(recovered.moves.presenceLift).toBe(0);
    expect(recovered.moves.intelligibilityLift).toBe(0);
    expect(rmsDiff(darkSafe.getChannelData(0), recovered.buffer.getChannelData(0))).toBeLessThan(0.00001);
  });
});
