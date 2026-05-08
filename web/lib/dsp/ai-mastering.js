/**
 * AI-generated / lossy-source mastering repair.
 *
 * AI-generated MP3 exports often arrive with hyped upper mids, smeared air,
 * loose sub energy, and a stereo image that feels wide but collapses poorly.
 * This module adds a conservative, analysis-driven correction pass before the
 * color/loudness stages so the rest of the chain has a cleaner source to lift.
 */

import { applyBiquadFilter, calculateRMS, dbToLinear, linearToDb } from './utils.js';
import { findTruePeak } from './true-peak.js';
import { measureLUFS } from './lufs.js';
import { applyGain } from './normalizer.js';
import { applyLookaheadLimiter } from './limiter.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export const AI_MASTERING_PROFILES = {
  universal: {
    repairStrength: 0.95,
    maxLimiterPushDB: 1.25,
    softClipDrive: 1.4,
    stereoWidthScale: 1.0,
    bassMonoFreq: 200,
    tone: { bass: 0, mud: 0, presence: 0, harsh: 0, air: 0 },
    description: 'Broad translation across earbuds, cars, phones, and speakers'
  },
  fire: {
    repairStrength: 0.95,
    maxLimiterPushDB: 1.75,
    softClipDrive: 1.65,
    stereoWidthScale: 1.03,
    bassMonoFreq: 210,
    tone: { bass: 0.65, mud: -0.35, presence: 0.15, harsh: -0.25, air: 0.1 },
    description: 'Forward, loud, and low-end pushed without burying vocals'
  },
  clarity: {
    repairStrength: 1.05,
    maxLimiterPushDB: 1.1,
    softClipDrive: 1.3,
    stereoWidthScale: 1.05,
    bassMonoFreq: 190,
    tone: { bass: -0.25, mud: -0.55, presence: 0.25, harsh: -0.45, air: 0.45 },
    description: 'Cleaner high detail with mud and sibilance controlled'
  },
  tape: {
    repairStrength: 0.85,
    maxLimiterPushDB: 1.0,
    softClipDrive: 1.32,
    stereoWidthScale: 0.96,
    bassMonoFreq: 220,
    tone: { bass: 0.55, mud: -0.15, presence: -0.35, harsh: -0.65, air: -0.45 },
    description: 'Warmer, smoother tone inspired by tape-style masters'
  },
  clean: {
    repairStrength: 1.15,
    maxLimiterPushDB: 0.9,
    softClipDrive: 1.25,
    stereoWidthScale: 0.95,
    bassMonoFreq: 220,
    tone: { bass: -0.1, mud: -0.3, presence: -0.2, harsh: -0.5, air: -0.2 },
    description: 'Artifact-first repair for harsh or already dense AI/MP3 sources'
  },
  balanced: {
    repairStrength: 0.95,
    maxLimiterPushDB: 1.25,
    softClipDrive: 1.4,
    stereoWidthScale: 1.0,
    bassMonoFreq: 200,
    tone: { bass: 0, mud: 0, presence: 0, harsh: 0, air: 0 },
    description: 'Commercial balanced contour for general AI music mastering'
  },
  natural: {
    repairStrength: 0.9,
    maxLimiterPushDB: 1.2,
    softClipDrive: 1.35,
    stereoWidthScale: 0.98,
    bassMonoFreq: 200,
    tone: { bass: 0, mud: 0, presence: -0.1, harsh: -0.1, air: 0 },
    description: 'Balanced correction with moderate loudness pressure'
  },
  warm: {
    repairStrength: 0.9,
    maxLimiterPushDB: 1.1,
    softClipDrive: 1.35,
    stereoWidthScale: 0.97,
    bassMonoFreq: 220,
    tone: { bass: 0.7, mud: -0.2, presence: -0.4, harsh: -0.5, air: -0.5 },
    description: 'Smoother top end with fuller low-mid weight'
  },
  vocal: {
    repairStrength: 1.05,
    maxLimiterPushDB: 1.2,
    softClipDrive: 1.35,
    stereoWidthScale: 0.96,
    bassMonoFreq: 210,
    tone: { bass: -0.2, mud: -0.5, presence: 0.45, harsh: -0.4, air: 0.25 },
    description: 'Forward vocal presence while controlling sibilance'
  },
  punchy: {
    repairStrength: 0.85,
    maxLimiterPushDB: 1.6,
    softClipDrive: 1.55,
    stereoWidthScale: 1.02,
    bassMonoFreq: 200,
    tone: { bass: 0.35, mud: -0.1, presence: 0.15, harsh: -0.15, air: 0.1 },
    description: 'Slightly louder contour for transient-forward material'
  },
  bass: {
    repairStrength: 0.85,
    maxLimiterPushDB: 1.45,
    softClipDrive: 1.5,
    stereoWidthScale: 0.98,
    bassMonoFreq: 240,
    tone: { bass: 1.0, mud: -0.4, presence: -0.2, harsh: -0.25, air: -0.15 },
    description: 'Tighter low-end weight for hip-hop, dance, and club playback'
  },
  loud: {
    repairStrength: 1.0,
    maxLimiterPushDB: 2.0,
    softClipDrive: 1.7,
    stereoWidthScale: 1.0,
    bassMonoFreq: 220,
    tone: { bass: 0.15, mud: -0.2, presence: 0.2, harsh: -0.25, air: 0.2 },
    description: 'Commercial loudness push with limiter pressure capped'
  },
  spatial: {
    repairStrength: 0.9,
    maxLimiterPushDB: 1.15,
    softClipDrive: 1.35,
    stereoWidthScale: 1.18,
    bassMonoFreq: 240,
    tone: { bass: -0.1, mud: -0.25, presence: 0.05, harsh: -0.25, air: 0.35 },
    description: 'Open top end and cleaner mids for wider-feeling masters'
  },
  cinematic: {
    repairStrength: 0.8,
    maxLimiterPushDB: 0.85,
    softClipDrive: 1.25,
    stereoWidthScale: 1.08,
    bassMonoFreq: 180,
    tone: { bass: 0.75, mud: -0.25, presence: -0.15, harsh: -0.35, air: 0.05 },
    description: 'Preserves dynamics with weight and less limiter pressure'
  }
};

function createBufferLike(source) {
  const output = new AudioBuffer({
    numberOfChannels: source.numberOfChannels,
    length: source.length,
    sampleRate: source.sampleRate
  });

  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    output.copyToChannel(source.getChannelData(ch), ch);
  }

  return output;
}

function calcBiquadCoeffs(type, sampleRate, frequency, gainDB = 0, Q = 0.707) {
  const nyquistSafeFreq = clamp(frequency, 10, sampleRate * 0.45);
  const w0 = 2 * Math.PI * nyquistSafeFreq / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const A = Math.pow(10, gainDB / 40);
  const alpha = sin / (2 * Q);

  let b0, b1, b2, a0, a1, a2;

  if (type === 'peaking') {
    b0 = 1 + alpha * A;
    b1 = -2 * cos;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cos;
    a2 = 1 - alpha / A;
  } else if (type === 'lowshelf') {
    const sqrtA = Math.sqrt(A);
    b0 = A * ((A + 1) - (A - 1) * cos + 2 * sqrtA * alpha);
    b1 = 2 * A * ((A - 1) - (A + 1) * cos);
    b2 = A * ((A + 1) - (A - 1) * cos - 2 * sqrtA * alpha);
    a0 = (A + 1) + (A - 1) * cos + 2 * sqrtA * alpha;
    a1 = -2 * ((A - 1) + (A + 1) * cos);
    a2 = (A + 1) + (A - 1) * cos - 2 * sqrtA * alpha;
  } else if (type === 'highshelf') {
    const sqrtA = Math.sqrt(A);
    b0 = A * ((A + 1) + (A - 1) * cos + 2 * sqrtA * alpha);
    b1 = -2 * A * ((A - 1) + (A + 1) * cos);
    b2 = A * ((A + 1) + (A - 1) * cos - 2 * sqrtA * alpha);
    a0 = (A + 1) - (A - 1) * cos + 2 * sqrtA * alpha;
    a1 = 2 * ((A - 1) - (A + 1) * cos);
    a2 = (A + 1) - (A - 1) * cos - 2 * sqrtA * alpha;
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  }

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0
  };
}

function applyFilterToBuffer(buffer, type, frequency, gainDB = 0, Q = 0.707) {
  if (Math.abs(gainDB) < 0.05 && type !== 'highpass') return buffer;

  const output = createBufferLike(buffer);
  const coeffs = calcBiquadCoeffs(type, buffer.sampleRate, frequency, gainDB, Q);

  for (let ch = 0; ch < output.numberOfChannels; ch++) {
    const filtered = applyBiquadFilter(output.getChannelData(ch), coeffs);
    output.copyToChannel(filtered, ch);
  }

  return output;
}

function downmixMono(buffer) {
  const mono = new Float32Array(buffer.length);
  const channelWeight = 1 / buffer.numberOfChannels;

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < buffer.length; i++) {
      mono[i] += data[i] * channelWeight;
    }
  }

  return mono;
}

function bandRms(mono, sampleRate, frequency, Q) {
  const coeffs = calcBiquadCoeffs('bandpass', sampleRate, frequency, 0, Q);
  return calculateRMS(applyBiquadFilter(mono, coeffs));
}

export function analyzeAIGeneratedMastering(buffer) {
  const mono = downmixMono(buffer);
  const fullRms = calculateRMS(mono);
  const peak = Math.max(...Array.from({ length: buffer.numberOfChannels }, (_, ch) => {
    const data = buffer.getChannelData(ch);
    let channelPeak = 0;
    for (let i = 0; i < data.length; i++) channelPeak = Math.max(channelPeak, Math.abs(data[i]));
    return channelPeak;
  }));
  const crestDB = fullRms > 0 ? linearToDb(peak / fullRms) : 0;

  const bands = {
    sub: bandRms(mono, buffer.sampleRate, 45, 0.9),
    bass: bandRms(mono, buffer.sampleRate, 110, 0.9),
    mud: bandRms(mono, buffer.sampleRate, 280, 1.1),
    body: bandRms(mono, buffer.sampleRate, 900, 0.9),
    presence: bandRms(mono, buffer.sampleRate, 3800, 1.0),
    harsh: bandRms(mono, buffer.sampleRate, 7800, 1.4),
    air: bandRms(mono, buffer.sampleRate, 13500, 0.8)
  };

  const toFullDB = value => linearToDb((value + 1e-9) / (fullRms + 1e-9));
  const mudDB = toFullDB(bands.mud);
  const harshDB = toFullDB(bands.harsh);
  const airDB = toFullDB(bands.air);
  const subToBassDB = linearToDb((bands.sub + 1e-9) / (bands.bass + 1e-9));
  const presenceToBodyDB = linearToDb((bands.presence + 1e-9) / (bands.body + 1e-9));

  return {
    fullRms,
    peak,
    crestDB,
    bands,
    profile: {
      mudDB,
      harshDB,
      airDB,
      subToBassDB,
      presenceToBodyDB
    }
  };
}

export function chooseAIMasteringProfile(analysis, requestedProfile = 'auto') {
  if (requestedProfile && requestedProfile !== 'auto' && AI_MASTERING_PROFILES[requestedProfile]) {
    return { name: requestedProfile, ...AI_MASTERING_PROFILES[requestedProfile] };
  }

  const { harshDB, airDB, subToBassDB, presenceToBodyDB } = analysis.profile;

  if (analysis.crestDB < 6.5 || harshDB > -10 || presenceToBodyDB > 2.5) {
    return { name: 'clean', ...AI_MASTERING_PROFILES.clean };
  }

  if (analysis.crestDB > 13 && subToBassDB < -5 && harshDB < -13) {
    return { name: 'punchy', ...AI_MASTERING_PROFILES.punchy };
  }

  if (airDB < -24 && harshDB < -14 && analysis.crestDB > 10) {
    return { name: 'loud', ...AI_MASTERING_PROFILES.loud };
  }

  return { name: 'universal', ...AI_MASTERING_PROFILES.universal };
}

export function getAIGeneratedMasteringMoves(analysis, strength = 1, profile = AI_MASTERING_PROFILES.universal, options = {}) {
  const { mudDB, harshDB, airDB, subToBassDB, presenceToBodyDB } = analysis.profile;
  const tone = profile.tone || {};
  const sibilanceAmount = clamp(options.sibilanceProtection ?? 0.6, 0, 1);
  const lowCutFreq = clamp(30 + Math.max(0, subToBassDB + 1) * 4, 30, 42);
  const mudCut = clamp((-clamp((mudDB + 10) * 0.35, 0, 2.8) + (tone.mud || 0)) * strength, -3.2, 0.6);
  const presenceCut = clamp((-clamp((presenceToBodyDB + 1.5) * 0.4, 0, 2.2) + (tone.presence || 0)) * strength, -2.8, 0.9);
  const sibilanceCut = -clamp((harshDB + 15) * 0.28 + sibilanceAmount * 1.15, 0.4, 3.4) * strength;
  const harshCut = clamp((-clamp((harshDB + 13) * 0.55, 0.4, 3.5) + (tone.harsh || 0) + sibilanceCut * 0.35) * strength, -4.8, -0.15);
  const airShelf = clamp((clamp((-18 - airDB) * 0.16, -1.2, 1.2) + (tone.air || 0)) * strength, -1.8, 1.6);
  const bassLift = clamp((clamp((-3 - subToBassDB) * 0.18, 0, 1.2) + (tone.bass || 0)) * strength, -0.8, 1.8);

  return {
    lowCutFreq,
    bassLift,
    mudCut,
    presenceCut,
    harshCut,
    sibilanceCut,
    airShelf
  };
}

export function applyAIGeneratedMasteringRepair(buffer, options = {}) {
  const analysis = analyzeAIGeneratedMastering(buffer);
  const profile = chooseAIMasteringProfile(analysis, options.profile || 'auto');
  const intensity = clamp(options.intensity ?? 1, 0.25, 1.75);
  const strength = clamp((options.strength ?? profile.repairStrength) * intensity, 0, 1.75);

  if (strength <= 0) {
    return { buffer, analysis, moves: null, profile };
  }

  const moves = getAIGeneratedMasteringMoves(analysis, strength, profile, {
    sibilanceProtection: options.sibilanceProtection
  });
  let output = buffer;

  output = applyFilterToBuffer(output, 'highpass', moves.lowCutFreq, 0, 0.707);
  output = applyFilterToBuffer(output, 'lowshelf', 95, moves.bassLift, 0.7);
  output = applyFilterToBuffer(output, 'peaking', 280, moves.mudCut, 1.15);
  output = applyFilterToBuffer(output, 'peaking', 3900, moves.presenceCut, 1.1);
  output = applyFilterToBuffer(output, 'peaking', 6200, moves.sibilanceCut, 2.3);
  output = applyFilterToBuffer(output, 'peaking', 9200, moves.sibilanceCut * 0.55, 2.0);
  output = applyFilterToBuffer(output, 'peaking', 7800, moves.harshCut, 1.6);
  output = applyFilterToBuffer(output, 'highshelf', 12500, moves.airShelf, 0.75);

  return { buffer: output, analysis, moves, profile };
}

export function applyReferenceMatch(buffer, referenceAnalysis, options = {}) {
  if (!referenceAnalysis || !referenceAnalysis.profile) {
    return { buffer, analysis: analyzeAIGeneratedMastering(buffer), moves: null };
  }

  const amount = clamp(options.amount ?? 0.65, 0, 1);
  if (amount <= 0) {
    return { buffer, analysis: analyzeAIGeneratedMastering(buffer), moves: null };
  }

  const analysis = analyzeAIGeneratedMastering(buffer);
  const source = analysis.profile;
  const target = referenceAnalysis.profile;

  const bassShelf = clamp((target.subToBassDB - source.subToBassDB) * -0.18 * amount, -1.2, 1.2);
  const mudMatch = clamp((target.mudDB - source.mudDB) * 0.32 * amount, -2.2, 1.4);
  const presenceMatch = clamp((target.presenceToBodyDB - source.presenceToBodyDB) * 0.28 * amount, -1.8, 1.5);
  const harshMatch = clamp((target.harshDB - source.harshDB) * 0.24 * amount, -2.4, 0.7);
  const airMatch = clamp((target.airDB - source.airDB) * 0.22 * amount, -1.6, 1.6);

  let output = buffer;
  output = applyFilterToBuffer(output, 'lowshelf', 95, bassShelf, 0.7);
  output = applyFilterToBuffer(output, 'peaking', 280, mudMatch, 1.1);
  output = applyFilterToBuffer(output, 'peaking', 3900, presenceMatch, 1.0);
  output = applyFilterToBuffer(output, 'peaking', 7800, harshMatch, 1.5);
  output = applyFilterToBuffer(output, 'highshelf', 12500, airMatch, 0.75);

  return {
    buffer: output,
    analysis,
    moves: {
      bassShelf,
      mudMatch,
      presenceMatch,
      harshMatch,
      airMatch
    }
  };
}

export function finalizeMasteringTarget(buffer, options = {}) {
  const targetLufs = options.targetLufs ?? -14;
  const ceilingDB = options.ceilingDB ?? -1;
  const toleranceDB = options.toleranceDB ?? 0.15;
  const maxLimiterPushDB = options.maxLimiterPushDB ?? 1.2;
  const maxPasses = options.maxPasses ?? 3;

  let output = buffer;
  const measuredLufs = measureLUFS(output, targetLufs);
  let previousError = Infinity;
  let limiterApplied = false;

  for (let pass = 0; pass < maxPasses; pass++) {
    const currentLufs = measureLUFS(output, targetLufs);
    if (!Number.isFinite(currentLufs)) break;

    const delta = targetLufs - currentLufs;
    const error = Math.abs(delta);
    if (error <= toleranceDB || error >= previousError - 0.02) {
      break;
    }

    previousError = error;
    const gainDB = delta > 0
      ? Math.min(delta, maxLimiterPushDB)
      : Math.max(delta, -3);

    output = applyGain(output, gainDB);

    const ceilingLinear = dbToLinear(ceilingDB);
    const truePeakDB = findTruePeak(output);
    if (Number.isFinite(truePeakDB) && truePeakDB > ceilingDB) {
      output = applyLookaheadLimiter(output, ceilingLinear, 3, 140, 3, true);
      limiterApplied = true;
    }
  }

  const ceilingLinear = dbToLinear(ceilingDB);
  const truePeakDB = findTruePeak(output);
  if (Number.isFinite(truePeakDB) && truePeakDB > ceilingDB) {
    output = applyLookaheadLimiter(output, ceilingLinear, 3, 160, 3, true);
    limiterApplied = true;
  }

  const finalLufs = measureLUFS(output, targetLufs);
  return {
    buffer: output,
    measuredLufs,
    finalLufs,
    limiterApplied
  };
}
