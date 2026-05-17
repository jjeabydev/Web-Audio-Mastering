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
import { adjustStereoWidth } from './stereo.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundToStep(value, step) {
  return Math.round(value / step) * step;
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
    tone: { bass: -0.25, mud: -0.55, presence: 0.1, harsh: -0.5, air: 0.15 },
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
    stereoWidthScale: 1.08,
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

function getActiveRanges(mono, sampleRate) {
  const windowSize = Math.max(1024, Math.floor(sampleRate * 0.4));
  const hopSize = Math.max(512, Math.floor(windowSize / 2));
  const windows = [];

  for (let start = 0; start < mono.length; start += hopSize) {
    const end = Math.min(start + windowSize, mono.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += mono[i] * mono[i];
    windows.push({ start, end, rms: Math.sqrt(sum / Math.max(1, end - start)) });
    if (end >= mono.length) break;
  }

  if (!windows.length) return [{ start: 0, end: mono.length }];

  const sorted = windows.map(window => window.rms).sort((a, b) => a - b);
  const p80 = percentile(sorted, 0.8);
  const threshold = Math.max(p80 * 0.35, sorted[sorted.length - 1] * 0.18, 1e-5);
  const ranges = windows
    .filter(window => window.rms >= threshold)
    .map(window => ({ start: window.start, end: window.end }));

  return ranges.length ? mergeRanges(ranges) : [{ start: 0, end: mono.length }];
}

function mergeRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const previous = merged[merged.length - 1];
    if (current.start <= previous.end) {
      previous.end = Math.max(previous.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

function rangesDuration(ranges) {
  return ranges.reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0);
}

function overlapsRanges(start, end, ranges) {
  return ranges.some(range => start < range.end && end > range.start);
}

function getLoudestRanges(mono, sampleRate, activeRanges) {
  const windowSize = Math.max(1024, Math.floor(sampleRate * 0.45));
  const hopSize = Math.max(512, Math.floor(windowSize / 3));
  const windows = [];

  for (let start = 0; start < mono.length; start += hopSize) {
    const end = Math.min(start + windowSize, mono.length);
    if (!overlapsRanges(start, end, activeRanges)) {
      if (end >= mono.length) break;
      continue;
    }

    let sum = 0;
    for (let i = start; i < end; i++) sum += mono[i] * mono[i];
    windows.push({ start, end, rms: Math.sqrt(sum / Math.max(1, end - start)) });
    if (end >= mono.length) break;
  }

  if (!windows.length) return activeRanges;

  const activeDuration = Math.max(1, rangesDuration(activeRanges));
  const targetDuration = clamp(activeDuration * 0.28, sampleRate * 1.2, sampleRate * 18);
  const loudestWindows = windows
    .sort((a, b) => b.rms - a.rms);

  const selected = [];
  let selectedDuration = 0;
  for (const window of loudestWindows) {
    selected.push({ start: window.start, end: window.end });
    selectedDuration = rangesDuration(mergeRanges(selected));
    if (selectedDuration >= targetDuration) break;
  }

  return selected.length ? mergeRanges(selected) : activeRanges;
}

function rangedRms(samples, ranges) {
  let sum = 0;
  let count = 0;

  for (const range of ranges) {
    const end = Math.min(range.end, samples.length);
    for (let i = range.start; i < end; i++) {
      sum += samples[i] * samples[i];
      count++;
    }
  }

  return Math.sqrt(sum / Math.max(1, count));
}

function getStereoImageRisk(stereo) {
  if (!stereo) return 0;
  return Math.max(
    clamp((stereo.sideToMidDB + 5) / 8, 0, 1),
    clamp(((stereo.lowSideToMidDB ?? -60) + 10) / 10, 0, 1),
    clamp(((stereo.highSideToMidDB ?? -60) + 8) / 12, 0, 1),
    clamp((0.12 - stereo.correlation) / 0.5, 0, 1)
  );
}

function bandRmsActive(mono, sampleRate, frequency, Q, activeRanges) {
  const coeffs = calcBiquadCoeffs('bandpass', sampleRate, frequency, 0, Q);
  return rangedRms(applyBiquadFilter(mono, coeffs), activeRanges);
}

function bandRmsFocused(mono, sampleRate, frequency, Q, activeRanges, loudestRanges) {
  const coeffs = calcBiquadCoeffs('bandpass', sampleRate, frequency, 0, Q);
  const filtered = applyBiquadFilter(mono, coeffs);
  const active = rangedRms(filtered, activeRanges);
  const loudest = rangedRms(filtered, loudestRanges);
  return active * 0.35 + loudest * 0.65;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const index = clamp((sortedValues.length - 1) * p, 0, sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function analyzePeakBehavior(buffer, mono, fullRms, peak, activeRanges = [{ start: 0, end: mono.length }]) {
  const nearPeakThreshold = dbToLinear(-1);
  const clipThreshold = 0.999;
  let nearPeakCount = 0;
  let clippedCount = 0;
  let spikeCount = 0;
  let residualSum = 0;
  let totalActiveSamples = 0;

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (const range of activeRanges) {
      const end = Math.min(range.end, data.length);
      totalActiveSamples += Math.max(0, end - range.start);
      for (let i = range.start; i < end; i++) {
        const abs = Math.abs(data[i]);
        if (abs >= nearPeakThreshold) nearPeakCount++;
        if (abs >= clipThreshold) clippedCount++;
        if (i >= range.start + 2 && i < end - 2) {
          const predicted = (data[i - 2] + data[i - 1] * 2 + data[i + 1] * 2 + data[i + 2]) / 6;
          const residual = Math.abs(data[i] - predicted);
          const localAvg = (
            Math.abs(data[i - 2]) +
            Math.abs(data[i - 1]) +
            Math.abs(data[i + 1]) +
            Math.abs(data[i + 2])
          ) / 4;
          residualSum += residual;
          if (residual > Math.max(0.018, localAvg * 1.8)) {
            spikeCount++;
          }
        }
      }
    }
  }

  const windowSize = Math.max(1024, Math.floor(buffer.sampleRate * 0.4));
  const hopSize = Math.max(512, Math.floor(windowSize / 2));
  const windowStats = [];
  const isActiveWindow = (start, end) => {
    const midpoint = Math.floor((start + end) / 2);
    return activeRanges.some(range => midpoint >= range.start && midpoint < range.end);
  };

  for (let start = 0; start < mono.length; start += hopSize) {
    const end = Math.min(start + windowSize, mono.length);
    let sum = 0;
    let localPeak = 0;

    for (let i = start; i < end; i++) {
      const sample = mono[i];
      sum += sample * sample;
      localPeak = Math.max(localPeak, Math.abs(sample));
    }

    const rms = Math.sqrt(sum / Math.max(1, end - start));
    if (isActiveWindow(start, end)) {
      windowStats.push({
        rms,
        peak: localPeak,
        crestDB: rms > 0 ? linearToDb((localPeak + 1e-9) / (rms + 1e-9)) : 0
      });
    }

    if (end >= mono.length) break;
  }

  const activeWindowStats = windowStats.length ? windowStats : [{ rms: fullRms, peak, crestDB: fullRms > 0 ? linearToDb((peak + 1e-9) / (fullRms + 1e-9)) : 0 }];
  const rmsValues = activeWindowStats.map(stat => stat.rms).sort((a, b) => a - b);
  const loudest = activeWindowStats.reduce((best, stat) => stat.rms > best.rms ? stat : best, { rms: 0, peak: 0, crestDB: 0 });
  const p20 = percentile(rmsValues, 0.2);
  const p95 = percentile(rmsValues, 0.95);
  const dynamicSpreadDB = linearToDb((p95 + 1e-9) / (p20 + 1e-9));

  return {
    peakDensity: totalActiveSamples > 0 ? nearPeakCount / totalActiveSamples : 0,
    clipDensity: totalActiveSamples > 0 ? clippedCount / totalActiveSamples : 0,
    spikeDensity: totalActiveSamples > 0 ? spikeCount / totalActiveSamples : 0,
    avgSpikeResidual: totalActiveSamples > 0 ? residualSum / totalActiveSamples : 0,
    loudestRmsDB: linearToDb(loudest.rms + 1e-9),
    loudestCrestDB: loudest.crestDB,
    dynamicSpreadDB,
    truePeakHeadroomDB: -linearToDb(peak + 1e-9),
    overallCrestDB: fullRms > 0 ? linearToDb((peak + 1e-9) / (fullRms + 1e-9)) : 0
  };
}

function analyzeStereoImage(buffer) {
  if (buffer.numberOfChannels < 2) {
    return {
      correlation: 1,
      sideToMidDB: -60,
      lowSideToMidDB: -60,
      highSideToMidDB: -60,
      sideEnergy: 0,
      midEnergy: 0
    };
  }

  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const midData = new Float32Array(buffer.length);
  const sideData = new Float32Array(buffer.length);
  let sumLR = 0;
  let sumL2 = 0;
  let sumR2 = 0;
  let sumMid2 = 0;
  let sumSide2 = 0;

  for (let i = 0; i < left.length; i += 17) {
    const l = left[i];
    const r = right[i];
    const mid = (l + r) * 0.5;
    const side = (l - r) * 0.5;
    sumLR += l * r;
    sumL2 += l * l;
    sumR2 += r * r;
    sumMid2 += mid * mid;
    sumSide2 += side * side;
  }

  for (let i = 0; i < left.length; i++) {
    midData[i] = (left[i] + right[i]) * 0.5;
    sideData[i] = (left[i] - right[i]) * 0.5;
  }

  const correlationDenominator = Math.sqrt(sumL2 * sumR2);
  const correlation = correlationDenominator > 0 ? sumLR / correlationDenominator : 1;
  const midEnergy = Math.sqrt(sumMid2);
  const sideEnergy = Math.sqrt(sumSide2);
  const lowMid = bandRms(midData, buffer.sampleRate, 120, 0.9);
  const lowSide = bandRms(sideData, buffer.sampleRate, 120, 0.9);
  const highMid = bandRms(midData, buffer.sampleRate, 8500, 1.4);
  const highSide = bandRms(sideData, buffer.sampleRate, 8500, 1.4);

  return {
    correlation: clamp(correlation, -1, 1),
    sideToMidDB: linearToDb((sideEnergy + 1e-9) / (midEnergy + 1e-9)),
    lowSideToMidDB: linearToDb((lowSide + 1e-9) / (lowMid + 1e-9)),
    highSideToMidDB: linearToDb((highSide + 1e-9) / (highMid + 1e-9)),
    sideEnergy,
    midEnergy
  };
}

export function analyzeAIGeneratedMastering(buffer) {
  const mono = downmixMono(buffer);
  const fullRms = calculateRMS(mono);
  const activeRanges = getActiveRanges(mono, buffer.sampleRate);
  const loudestRanges = getLoudestRanges(mono, buffer.sampleRate, activeRanges);
  const activeRms = rangedRms(mono, activeRanges);
  const loudestRms = rangedRms(mono, loudestRanges);
  const samplePeak = Math.max(...Array.from({ length: buffer.numberOfChannels }, (_, ch) => {
    const data = buffer.getChannelData(ch);
    let channelPeak = 0;
    for (let i = 0; i < data.length; i++) channelPeak = Math.max(channelPeak, Math.abs(data[i]));
    return channelPeak;
  }));
  const truePeakDB = findTruePeak(buffer);
  const truePeak = Number.isFinite(truePeakDB) ? dbToLinear(truePeakDB) : samplePeak;
  const peak = Math.max(samplePeak, truePeak);
  const crestDB = fullRms > 0 ? linearToDb(peak / fullRms) : 0;

  const bands = {
    sub: bandRmsFocused(mono, buffer.sampleRate, 45, 0.9, activeRanges, loudestRanges),
    bass: bandRmsFocused(mono, buffer.sampleRate, 110, 0.9, activeRanges, loudestRanges),
    mud: bandRmsFocused(mono, buffer.sampleRate, 280, 1.1, activeRanges, loudestRanges),
    body: bandRmsFocused(mono, buffer.sampleRate, 900, 0.9, activeRanges, loudestRanges),
    presence: bandRmsFocused(mono, buffer.sampleRate, 3800, 1.0, activeRanges, loudestRanges),
    harsh: bandRmsFocused(mono, buffer.sampleRate, 7800, 1.4, activeRanges, loudestRanges),
    metallic: bandRmsFocused(mono, buffer.sampleRate, 10800, 2.8, activeRanges, loudestRanges),
    air: bandRmsFocused(mono, buffer.sampleRate, 13500, 0.8, activeRanges, loudestRanges)
  };

  const focusedRms = activeRms * 0.35 + loudestRms * 0.65;
  const analysisRms = Math.max(focusedRms, activeRms, fullRms, 1e-9);
  const toFullDB = value => linearToDb((value + 1e-9) / (analysisRms + 1e-9));
  const mudDB = toFullDB(bands.mud);
  const harshDB = toFullDB(bands.harsh);
  const metallicDB = toFullDB(bands.metallic);
  const airDB = toFullDB(bands.air);
  const subToBassDB = linearToDb((bands.sub + 1e-9) / (bands.bass + 1e-9));
  const bassToBodyDB = linearToDb((bands.bass + 1e-9) / (bands.body + 1e-9));
  const presenceToBodyDB = linearToDb((bands.presence + 1e-9) / (bands.body + 1e-9));
  const stereo = analyzeStereoImage(buffer);
  const peaks = analyzePeakBehavior(buffer, mono, fullRms, peak, activeRanges);
  const codecStress = clamp(
    (metallicDB + 16) * 0.055 +
    (harshDB + 14) * 0.045 +
    Math.max(0, peaks.peakDensity - 0.002) * 34 +
    Math.max(0, peaks.spikeDensity - 0.0008) * 95 +
    Math.max(0, peaks.avgSpikeResidual - 0.0015) * 22 +
    Math.max(0, 8 - peaks.loudestCrestDB) * 0.08 +
    Math.max(0, -0.05 - stereo.correlation) * 0.6,
    0,
    1
  );
  const limiterRisk = clamp(
    Math.max(0, peaks.peakDensity - 0.001) * 45 +
    Math.max(0, peaks.clipDensity) * 120 +
    Math.max(0, peaks.spikeDensity - 0.0008) * 75 +
    Math.max(0, 7.5 - peaks.loudestCrestDB) * 0.11 +
    Math.max(0, subToBassDB + 2) * 0.08,
    0,
    1
  );

  return {
    fullRms,
    activeRms,
    loudestRms,
    activeRatio: activeRanges.reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0) / Math.max(1, mono.length),
    loudestRatio: loudestRanges.reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0) / Math.max(1, mono.length),
    peak,
    crestDB,
    bands,
    stereo,
    peaks,
    codecStress,
    limiterRisk,
    profile: {
      mudDB,
      harshDB,
      metallicDB,
      airDB,
      subToBassDB,
      bassToBodyDB,
      presenceToBodyDB
    }
  };
}

export function chooseAIMasteringProfile(analysis, requestedProfile = 'auto') {
  if (requestedProfile && requestedProfile !== 'auto' && AI_MASTERING_PROFILES[requestedProfile]) {
    return { name: requestedProfile, ...AI_MASTERING_PROFILES[requestedProfile] };
  }

  const { mudDB, harshDB, metallicDB = -18, airDB, subToBassDB, presenceToBodyDB } = analysis.profile;
  const { peakDensity = 0, clipDensity = 0, loudestCrestDB = analysis.crestDB, dynamicSpreadDB = 0 } = analysis.peaks || {};
  const stereoRisk = getStereoImageRisk(analysis.stereo);

  if (
    analysis.codecStress > 0.55 ||
    analysis.limiterRisk > 0.55 ||
    clipDensity > 0.0001 ||
    peakDensity > 0.015 ||
    loudestCrestDB < 6.5 ||
    harshDB > -10 ||
    metallicDB > -12 ||
    presenceToBodyDB > 2.8
  ) {
    return { name: 'clean', ...AI_MASTERING_PROFILES.clean };
  }

  if (stereoRisk > 0.9) {
    return { name: 'clean', ...AI_MASTERING_PROFILES.clean };
  }

  if ((mudDB > -7.5 || (airDB < -23 && presenceToBodyDB < -10)) && harshDB < -12 && metallicDB < -14) {
    return { name: 'clarity', ...AI_MASTERING_PROFILES.clarity };
  }

  if (stereoRisk < 0.18 && analysis.stereo?.sideToMidDB < -14 && harshDB < -12 && metallicDB < -14 && airDB < -21) {
    return { name: 'spatial', ...AI_MASTERING_PROFILES.spatial };
  }

  if (dynamicSpreadDB > 12 && analysis.crestDB > 13.5) {
    return { name: 'cinematic', ...AI_MASTERING_PROFILES.cinematic };
  }

  if (analysis.crestDB > 13 && subToBassDB < -5 && harshDB < -13 && analysis.limiterRisk < 0.4) {
    return { name: 'punchy', ...AI_MASTERING_PROFILES.punchy };
  }

  if (airDB < -24 && harshDB < -14 && metallicDB < -16 && analysis.crestDB > 10 && analysis.limiterRisk < 0.35) {
    return { name: 'loud', ...AI_MASTERING_PROFILES.loud };
  }

  return { name: 'universal', ...AI_MASTERING_PROFILES.universal };
}

export function getAIGeneratedMasteringMoves(analysis, strength = 1, profile = AI_MASTERING_PROFILES.universal, options = {}) {
  const { mudDB, harshDB, metallicDB = -18, airDB, subToBassDB, bassToBodyDB = 0, presenceToBodyDB } = analysis.profile;
  const tone = profile.tone || {};
  const sibilanceAmount = clamp(options.sibilanceProtection ?? 0.6, 0, 1);
  const artifactAmount = clamp(options.artifactProtection ?? 0.7, 0, 1);
  const lossyProtected = Boolean(options.isLossySource) || artifactAmount >= 0.78 || sibilanceAmount >= 0.75;
  const lowCutFreq = clamp(30 + Math.max(0, subToBassDB + 1) * 4, 30, 42);
  const fragileHighs = lossyProtected || (analysis.codecStress ?? 0) > 0.45 || harshDB > -11.5 || metallicDB > -13.5;
  const muffleRisk = clamp(
    Math.max(0, -23 - airDB) * 0.12 +
    Math.max(0, -2.5 - presenceToBodyDB) * 0.18 +
    Math.max(0, mudDB + 7.5) * 0.08,
    0,
    1
  );
  const mudCut = clamp((-clamp((mudDB + 10) * 0.35, 0, 2.8) + (tone.mud || 0)) * strength, -3.2, 0.6);
  const presenceLift = fragileHighs ? 0 : muffleRisk * 0.55;
  const presenceTone = lossyProtected ? Math.min(0, tone.presence || 0) : (tone.presence || 0);
  const presenceCut = clamp((-clamp((presenceToBodyDB + 1.5) * 0.4, 0, 2.2) + presenceTone + presenceLift) * strength, -3.2, lossyProtected ? 0 : 1.2);
  const sibilanceRisk = clamp((harshDB + 15) * 0.28 + Math.max(0, metallicDB + 17) * 0.08 + (lossyProtected ? 0.18 : 0), 0, 3.3);
  const sibilanceCut = -clamp(sibilanceRisk * (0.45 + sibilanceAmount * 0.75) * strength, 0, 3.4);
  const harshRisk = clamp((harshDB + 13) * 0.55 + (lossyProtected ? 0.12 : 0), 0, 3.7);
  const harshCut = Math.min(0, clamp((-(harshRisk) + (tone.harsh || 0) + sibilanceCut * 0.35) * strength, -4.8, 0));
  const metallicExcess = clamp((metallicDB + 17) * 0.18 + Math.max(0, harshDB + 13) * 0.05 + (analysis.codecStress ?? 0) * 0.75 + (lossyProtected ? 0.35 : 0), 0, 2.9);
  const metallicBase = clamp(
    metallicExcess * (0.45 + artifactAmount * 0.95),
    0,
    lossyProtected ? 3.8 : 3.2
  );
  const metallicCut = -clamp(metallicBase * strength, 0, lossyProtected ? 5.0 : 4.2);
  const opennessLift = fragileHighs ? 0 : muffleRisk * 0.75;
  const airTone = lossyProtected ? Math.min(0, tone.air || 0) : (tone.air || 0);
  const airShelf = clamp((clamp((-18 - airDB) * 0.16, -1.2, 1.2) + airTone + metallicCut * 0.08 + opennessLift) * strength, lossyProtected ? -2.4 : -1.8, lossyProtected ? 0 : 1.7);
  const bassDeficit = clamp((-3 - bassToBodyDB) * 0.18, 0, 1.1);
  const lowHeadroomRisk = clamp((analysis.limiterRisk ?? 0) + Math.max(0, subToBassDB + 1) * 0.1, 0, 1);
  const bassLift = clamp((bassDeficit * (1 - lowHeadroomRisk * 0.55) + (tone.bass || 0)) * strength, -0.8, 1.8);

  return {
    lowCutFreq,
    bassLift,
    mudCut,
    presenceCut,
    harshCut,
    sibilanceCut,
    metallicCut,
    airShelf
  };
}

export function applyAIGeneratedMasteringRepair(buffer, options = {}) {
  const analysis = analyzeAIGeneratedMastering(buffer);
  const profile = chooseAIMasteringProfile(analysis, options.profile || 'auto');
  const intensity = clamp(options.intensity ?? 1, 0.25, 1.75);
  const strength = clamp((options.strength ?? profile.repairStrength) * intensity, 0, 1.75);
  const transparentSafeMode = Boolean(options.isLossySource) ||
    (options.artifactProtection ?? 0.7) >= 0.78 ||
    (options.sibilanceProtection ?? 0.6) >= 0.75;

  if (strength <= 0) {
    return { buffer, analysis, moves: null, profile };
  }

  const moves = getAIGeneratedMasteringMoves(analysis, strength, profile, {
    sibilanceProtection: options.sibilanceProtection,
    artifactProtection: options.artifactProtection,
    isLossySource: options.isLossySource
  });
  let output = buffer;

  if (options.cleanLowEnd !== false) {
    output = applyFilterToBuffer(output, 'highpass', moves.lowCutFreq, 0, 0.707);
  }
  output = applyFilterToBuffer(output, 'lowshelf', 95, moves.bassLift, 0.7);
  output = applyFilterToBuffer(output, 'peaking', 280, moves.mudCut, 1.15);
  if (transparentSafeMode) {
    const highShelf = clamp(moves.airShelf + moves.sibilanceCut * 0.18 + moves.metallicCut * 0.16, -2.2, 0);
    output = applyFilterToBuffer(output, 'highshelf', 9500, highShelf, 0.55);
  } else {
    output = applyFilterToBuffer(output, 'peaking', 3900, moves.presenceCut, 1.1);
    output = applyFilterToBuffer(output, 'peaking', 6200, moves.sibilanceCut, 2.3);
    output = applyFilterToBuffer(output, 'peaking', 9200, moves.sibilanceCut * 0.55, 2.0);
    output = applyFilterToBuffer(output, 'peaking', 7800, moves.harshCut, 1.6);
    output = applyFilterToBuffer(output, 'peaking', 10800, moves.metallicCut, 3.2);
    output = applyFilterToBuffer(output, 'peaking', 11800, moves.metallicCut * 0.45, 2.4);
    output = applyFilterToBuffer(output, 'highshelf', 12500, moves.airShelf, 0.75);
  }

  return { buffer: output, analysis, moves, profile };
}

export function applyMetallicRescueTone(buffer, options = {}) {
  const amount = clamp(options.amount ?? 1, 0, 1);
  if (!buffer || amount <= 0) {
    return { buffer, analysis: null, moves: null };
  }

  const analysis = analyzeAIGeneratedMastering(buffer);
  const profile = chooseAIMasteringProfile(analysis, options.profile || 'auto');
  const moves = getAIGeneratedMasteringMoves(analysis, amount, profile, {
    sibilanceProtection: options.sibilanceProtection ?? 0.8,
    artifactProtection: options.artifactProtection ?? 0.9,
    isLossySource: options.isLossySource
  });

  let output = buffer;
  const metallicCut = clamp(moves.metallicCut * (0.42 + amount * 0.28), -2.8, 0);
  const sibilanceCut = clamp((moves.sibilanceCut + moves.harshCut * 0.45) * (0.28 + amount * 0.2), -1.9, 0);
  const airShelf = clamp(moves.airShelf + metallicCut * 0.08 + sibilanceCut * 0.04, -1.1, 0.2);

  output = applyFilterToBuffer(output, 'peaking', 7800, sibilanceCut, 1.25);
  output = applyFilterToBuffer(output, 'peaking', 10800, metallicCut, 2.4);
  output = applyFilterToBuffer(output, 'peaking', 11800, metallicCut * 0.35, 1.8);
  output = applyFilterToBuffer(output, 'highshelf', 12500, airShelf, 0.55);

  return {
    buffer: output,
    analysis,
    moves: {
      metallicCut,
      sibilanceCut,
      airShelf
    }
  };
}

export function applyArtifactSafeAirRecovery(buffer, options = {}) {
  const amount = clamp(options.amount ?? 1, 0, 1);
  if (!buffer || amount <= 0) {
    return { buffer, analysis: null, moves: null };
  }

  const analysis = analyzeAIGeneratedMastering(buffer);
  const profile = analysis.profile || {};
  const airDB = profile.airDB ?? -18;
  const harshDB = profile.harshDB ?? -18;
  const metallicDB = profile.metallicDB ?? -18;
  const spikeDensity = analysis.peaks?.spikeDensity ?? 0;
  const safeToOpen = airDB < -16.4 &&
    harshDB < -14 &&
    metallicDB < -18 &&
    spikeDensity < 0.009;

  if (!safeToOpen) {
    return { buffer, analysis, moves: { airShelf: 0, presenceLift: 0, skipped: true } };
  }

  const airShelf = clamp((-15.8 - airDB) * 0.34 * amount, 0.18, 1.15);
  const presenceLift = clamp((-14.4 - harshDB) * 0.08 * amount, 0, 0.25);
  let output = applyFilterToBuffer(buffer, 'highshelf', 12500, airShelf, 0.65);
  if (presenceLift > 0.02) {
    output = applyFilterToBuffer(output, 'peaking', 4200, presenceLift, 0.9);
  }

  return {
    buffer: output,
    analysis,
    moves: {
      airShelf,
      presenceLift,
      skipped: false
    }
  };
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
  const fragileHighs = (analysis.codecStress ?? 0) > 0.36 || source.harshDB > -12 || source.metallicDB > -14;
  const limiterRisk = analysis.limiterRisk ?? 0;
  const positiveMatchScale = fragileHighs ? 0.45 : 1;
  const limiterMatchScale = limiterRisk > 0.45 ? 0.65 : 1;
  const sourceStereoRisk = getStereoImageRisk(analysis.stereo);
  const referenceStereoRisk = getStereoImageRisk(referenceAnalysis.stereo);

  const bassShelf = clamp((target.subToBassDB - source.subToBassDB) * -0.18 * amount, -1.2, 1.2);
  const mudMatch = clamp((target.mudDB - source.mudDB) * 0.32 * amount, -2.2, 1.4);
  const rawPresenceMatch = clamp((target.presenceToBodyDB - source.presenceToBodyDB) * 0.28 * amount, -1.8, 1.5);
  const rawHarshMatch = clamp((target.harshDB - source.harshDB) * 0.24 * amount, -2.4, 0.7);
  const rawAirMatch = clamp((target.airDB - source.airDB) * 0.22 * amount, -1.6, 1.6);
  const presenceMatch = rawPresenceMatch > 0 ? rawPresenceMatch * positiveMatchScale * limiterMatchScale : rawPresenceMatch;
  const harshMatch = rawHarshMatch > 0 ? rawHarshMatch * positiveMatchScale * limiterMatchScale : rawHarshMatch;
  const airMatch = rawAirMatch > 0 ? rawAirMatch * positiveMatchScale * limiterMatchScale : rawAirMatch;
  const rawStereoMatch = analysis.stereo && referenceAnalysis.stereo
    ? (referenceAnalysis.stereo.sideToMidDB - analysis.stereo.sideToMidDB) * 0.018 * amount
    : 0;
  const stereoWidenScale = (fragileHighs || sourceStereoRisk > 0.55 || referenceStereoRisk > 0.55) ? 0.35 : 1;
  const stereoWidthScale = clamp(1 + (rawStereoMatch > 0 ? rawStereoMatch * stereoWidenScale : rawStereoMatch), 0.92, 1.08);

  let output = buffer;
  output = applyFilterToBuffer(output, 'lowshelf', 95, bassShelf, 0.7);
  output = applyFilterToBuffer(output, 'peaking', 280, mudMatch, 1.1);
  output = applyFilterToBuffer(output, 'peaking', 3900, presenceMatch, 1.0);
  output = applyFilterToBuffer(output, 'peaking', 7800, harshMatch, 1.5);
  output = applyFilterToBuffer(output, 'highshelf', 12500, airMatch, 0.75);
  if (output.numberOfChannels === 2 && Math.abs(stereoWidthScale - 1) > 0.01) {
    output = adjustStereoWidth(output, stereoWidthScale, true, 200);
  }

  return {
    buffer: output,
    analysis,
    moves: {
      bassShelf,
      mudMatch,
      presenceMatch,
      harshMatch,
      airMatch,
      stereoWidthScale
    }
  };
}

export function applyLimiterStressGuard(buffer, options = {}) {
  const amount = clamp(options.amount ?? 1, 0, 1.5);
  if (amount <= 0) {
    return { buffer, analysis: analyzeAIGeneratedMastering(buffer), moves: null };
  }

  const analysis = analyzeAIGeneratedMastering(buffer);
  const { mudDB, harshDB, metallicDB = -18, airDB, subToBassDB, presenceToBodyDB } = analysis.profile;
  const targetLufs = options.targetLufs ?? -12;
  const peakPressure = clamp(
    (analysis.limiterRisk ?? 0) * 0.55 +
    (analysis.codecStress ?? 0) * 0.25 +
    Math.max(0, 7.5 - (analysis.peaks?.loudestCrestDB ?? 12)) * 0.06,
    0,
    0.55
  );
  const loudnessPressure = clamp((-12 - targetLufs) * 0.16 + (options.intensity ?? 1) * 0.18 + peakPressure, 0.08, 0.75);
  const fragileHighs = (analysis.codecStress ?? 0) > 0.45 || harshDB > -11.5 || metallicDB > -13.5;
  const veiledSource = airDB < -23 && presenceToBodyDB < -8 && !fragileHighs;
  const opennessGuard = veiledSource ? 0.35 : 1;

  const lowStress = clamp((subToBassDB + 2.5) * 0.18 + loudnessPressure, 0, 1.2) * amount;
  const mudStress = clamp((mudDB + 9.5) * 0.22 + loudnessPressure * 0.55, 0, 1.4) * amount;
  const presenceStress = clamp((presenceToBodyDB + 1.0) * 0.28 + loudnessPressure * 0.72 * opennessGuard, 0, 1.75) * amount;
  const harshStress = clamp((harshDB + 13.5) * 0.26 + loudnessPressure * 0.82, 0, 1.95) * amount;
  const metallicStress = clamp((metallicDB + 17.5) * 0.18 + loudnessPressure * 0.92, 0, 1.85) * amount;
  const airStress = clamp((airDB + 14.5) * 0.14 + loudnessPressure * 0.35 * opennessGuard, 0, 1.0) * amount;

  const moves = {
    lowShelf: -clamp(lowStress, 0, 1.2),
    mudCut: -clamp(mudStress, 0, 1.4),
    presenceCut: -clamp(presenceStress, 0, 1.6),
    harshCut: -clamp(harshStress, 0, 1.8),
    metallicCut: -clamp(metallicStress, 0, 1.7),
    airShelf: -clamp(airStress, 0, 1.0)
  };

  let output = buffer;
  output = applyFilterToBuffer(output, 'lowshelf', 90, moves.lowShelf, 0.7);
  output = applyFilterToBuffer(output, 'peaking', 260, moves.mudCut, 1.0);
  output = applyFilterToBuffer(output, 'peaking', 3600, moves.presenceCut, 1.15);
  output = applyFilterToBuffer(output, 'peaking', 7600, moves.harshCut, 1.8);
  output = applyFilterToBuffer(output, 'peaking', 10800, moves.metallicCut, 3.0);
  output = applyFilterToBuffer(output, 'highshelf', 14000, moves.airShelf, 0.75);

  return { buffer: output, analysis, moves };
}

export function applyStereoStabilityGuard(buffer, options = {}) {
  if (buffer.numberOfChannels < 2) {
    return { buffer, analysis: analyzeAIGeneratedMastering(buffer), moves: null };
  }

  const amount = clamp(options.amount ?? 1, 0, 1.5);
  if (amount <= 0) {
    return { buffer, analysis: analyzeAIGeneratedMastering(buffer), moves: null };
  }

  const analysis = analyzeAIGeneratedMastering(buffer);
  const { correlation, sideToMidDB, lowSideToMidDB = -60, highSideToMidDB = -60 } = analysis.stereo;
  const widthExcess = clamp((sideToMidDB + 5) / 8, 0, 1);
  const lowWidthExcess = clamp((lowSideToMidDB + 10) / 10, 0, 1);
  const highWidthExcess = clamp((highSideToMidDB + 8) / 12, 0, 1);
  const phaseRisk = clamp((0.12 - correlation) / 0.5, 0, 1);
  const risk = clamp(widthExcess * 0.45 + lowWidthExcess * 0.35 + highWidthExcess * 0.2 + phaseRisk * 0.75, 0, 1);

  if (risk < 0.08) {
    return { buffer, analysis, moves: { sideScale: 1, bassMonoFreq: 0, risk } };
  }

  const sideScale = clamp(1 - risk * 0.2 * amount, 0.76, 1);
  const bassMonoFreq = clamp(170 + Math.max(risk, lowWidthExcess) * 95, 170, 270);
  const sideHighpass = calcBiquadCoeffs('highpass', buffer.sampleRate, bassMonoFreq, 0, 0.707);

  const output = createBufferLike(buffer);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const mid = new Float32Array(buffer.length);
  const side = new Float32Array(buffer.length);

  for (let i = 0; i < buffer.length; i++) {
    mid[i] = (left[i] + right[i]) * 0.5;
    side[i] = (left[i] - right[i]) * 0.5;
  }

  const stableSide = applyBiquadFilter(side, sideHighpass);
  const outLeft = output.getChannelData(0);
  const outRight = output.getChannelData(1);

  for (let i = 0; i < buffer.length; i++) {
    const s = stableSide[i] * sideScale;
    outLeft[i] = mid[i] + s;
    outRight[i] = mid[i] - s;
  }

  return {
    buffer: output,
    analysis,
    moves: {
      sideScale,
      bassMonoFreq,
      risk
    }
  };
}

export function applyPianoHighArtifactSuppressor(buffer, options = {}) {
  const amount = clamp(options.amount ?? 0.65, 0, 1);
  const sensitivity = clamp(options.sensitivity ?? 0.75, 0, 1);
  if (!buffer || amount <= 0) return buffer;

  const length = buffer.length;
  const sampleRate = buffer.sampleRate;
  const output = new AudioBuffer({
    numberOfChannels: buffer.numberOfChannels,
    length,
    sampleRate
  });
  const window = Math.max(12, Math.round(sampleRate * 0.00045));
  const halfWindow = Math.floor(window / 2);
  const absFloor = 0.006;

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const input = buffer.getChannelData(ch);
    const out = output.getChannelData(ch);
    out.set(input);

    let localSum = 0;
    for (let i = 0; i < Math.min(length, window); i++) {
      localSum += Math.abs(input[i]);
    }

    for (let i = 3; i < length - 3; i++) {
      const removeIdx = i - halfWindow - 1;
      const addIdx = i + halfWindow;
      if (removeIdx >= 0) localSum -= Math.abs(input[removeIdx]);
      if (addIdx < length) localSum += Math.abs(input[addIdx]);

      const localAvg = localSum / window;
      const predicted = (
        input[i - 3] +
        input[i - 2] * 2 +
        input[i - 1] * 3 +
        input[i + 1] * 3 +
        input[i + 2] * 2 +
        input[i + 3]
      ) / 12;
      const residual = input[i] - predicted;
      const curvature = Math.abs(input[i - 1] - input[i] * 2 + input[i + 1]);
      const edgeJump = Math.min(
        Math.abs(input[i] - input[i - 1]),
        Math.abs(input[i] - input[i + 1])
      );
      const threshold = Math.max(absFloor, localAvg * (1.35 - sensitivity * 0.45));
      const edgeGate = threshold * (0.95 - sensitivity * 0.28);
      const curvatureGate = threshold * (1.45 - sensitivity * 0.42);
      const burstGate = threshold * (2.05 - sensitivity * 0.5);
      const residualGate = threshold * (1.25 - sensitivity * 0.35);
      const isolated = (
        edgeJump > edgeGate &&
        curvature > curvatureGate
      ) || (
        curvature > burstGate &&
        Math.abs(residual) > residualGate
      );

      if (isolated && Math.abs(residual) > residualGate) {
        const limitedResidual = Math.sign(residual) * threshold;
        const repaired = predicted + limitedResidual;
        out[i] = input[i] * (1 - amount) + repaired * amount;
      }
    }
  }

  return output;
}

export function getAIMasteringRecommendation(analysis, source = {}) {
  const profile = chooseAIMasteringProfile(analysis, 'auto');
  const { harshDB, metallicDB = -18, airDB, mudDB, subToBassDB, presenceToBodyDB = 0 } = analysis.profile;
  const peaks = analysis.peaks || {};
  const bitrateKbps = Number(source.bitrateKbps) || 0;
  const isLossy = source.isLossy ?? (bitrateKbps > 0 && bitrateKbps < 500);
  const lowBitrate = isLossy && bitrateKbps > 0 && bitrateKbps < 192;
  const stereoRisk = analysis.stereo
    ? getStereoImageRisk(analysis.stereo)
    : 0;
  const clippedOrPinned = (peaks.clipDensity ?? 0) > 0.0001 || (peaks.peakDensity ?? 0) > 0.015;
  const fragileHighs = analysis.codecStress > 0.45 || metallicDB > -13 || harshDB > -11 || lowBitrate || (isLossy && analysis.codecStress > 0.28);
  const limiterRisk = analysis.limiterRisk ?? 0;

  const percussiveArtifactRisk = isLossy || fragileHighs || metallicDB > -14.5 || analysis.codecStress > 0.32;
  const artifactRescueRisk = (
    isLossy &&
    (
      metallicDB > -15.5 ||
      harshDB > -12.5 ||
      analysis.codecStress > 0.34 ||
      (peaks.peakDensity ?? 0) > 0.006 ||
      (peaks.spikeDensity ?? 0) > 0.00005 ||
      (peaks.loudestCrestDB ?? analysis.crestDB) < 8
    )
  ) || metallicDB > -12.5 || analysis.codecStress > 0.58 || (peaks.spikeDensity ?? 0) > 0.00005;

  let targetLufs = -12;
  if (artifactRescueRisk) {
    targetLufs = -14;
  } else if (percussiveArtifactRisk) {
    targetLufs = -14.5;
  } else if (clippedOrPinned || limiterRisk > 0.58 || lowBitrate || peaks.loudestCrestDB < 6.5) {
    targetLufs = -14;
  } else if ((isLossy && analysis.codecStress > 0.25) || analysis.codecStress > 0.45 || limiterRisk > 0.38) {
    targetLufs = -13;
  } else if (profile.name === 'punchy' && limiterRisk < 0.25 && analysis.codecStress < 0.25) {
    targetLufs = -11.5;
  }

  let inputGain = -3.5;
  const truePeakHeadroom = peaks.truePeakHeadroomDB ?? 0;
  if (clippedOrPinned || truePeakHeadroom < 0.3) {
    inputGain = -6;
  } else if (truePeakHeadroom < 1 || limiterRisk > 0.45) {
    inputGain = -5;
  } else if (truePeakHeadroom > 6 && (peaks.loudestRmsDB ?? -30) < -22) {
    inputGain = -2.5;
  }

  let truePeakCeiling = -1;
  if (isLossy || lowBitrate || clippedOrPinned || limiterRisk > 0.55) {
    truePeakCeiling = -1.5;
  }

  const aiIntensity = clamp(
    (profile.name === 'clean' ? 0.92 : 1.05) -
    Math.max(0, limiterRisk - 0.35) * 0.22 -
    (lowBitrate ? 0.08 : isLossy ? 0.04 : 0),
    0.85,
    1.12
  );

  let sibilanceProtection = clamp(
    0.62 +
    Math.max(0, harshDB + 14) * 0.035 +
    Math.max(0, metallicDB + 16) * 0.018 +
    (lowBitrate ? 0.08 : isLossy ? 0.04 : 0),
    0.55,
    0.9
  );
  if (artifactRescueRisk) {
    sibilanceProtection = Math.max(sibilanceProtection, 0.8);
  }

  let artifactProtection = clamp(
    0.7 +
    analysis.codecStress * 0.2 +
    Math.max(0, metallicDB + 15) * 0.025 +
    (lowBitrate ? 0.1 : isLossy ? 0.06 : 0),
    0.65,
    0.92
  );
  if (artifactRescueRisk) {
    artifactProtection = Math.max(artifactProtection, 0.9);
  }
  artifactProtection = Math.min(artifactProtection, artifactRescueRisk ? 0.9 : 0.85);

  const limiterCharacter = (lowBitrate || artifactRescueRisk || clippedOrPinned || fragileHighs || limiterRisk > 0.5)
    ? 'transparent'
    : (profile.name === 'punchy' && (peaks.loudestCrestDB ?? 0) > 9.5 ? 'punch' : 'balanced');

  const stereoWidth = stereoRisk > 0.75 ? 95 : (stereoRisk < 0.15 && profile.name === 'spatial' ? 110 : 100);
  const darkButSafe = airDB < -24 && presenceToBodyDB < -10 && !fragileHighs && limiterRisk < 0.35 && analysis.codecStress < 0.28;
  const muddyOrVeiled = mudDB > -7.5 || (airDB < -23 && presenceToBodyDB < -8 && harshDB < -12);
  const addAir = darkButSafe && !isLossy && !lowBitrate;
  const addPunch = !percussiveArtifactRisk &&
    !clippedOrPinned &&
    limiterRisk < 0.45 &&
    (peaks.loudestCrestDB ?? analysis.crestDB) > 8.5;
  const tapeWarmth = !percussiveArtifactRisk && limiterRisk < 0.45;
  const autoLevel = (peaks.dynamicSpreadDB ?? 0) > 7.5 && !clippedOrPinned;

  return {
    profile: profile.name,
    inputGain: roundToStep(inputGain, 0.5),
    targetLufs: roundToStep(targetLufs, 0.5),
    truePeakCeiling: roundToStep(truePeakCeiling, 0.5),
    limiterCharacter,
    aiIntensity: roundToStep(aiIntensity * 100, 5),
    sibilanceProtection: roundToStep(sibilanceProtection * 100, 5),
    artifactProtection: roundToStep(artifactProtection * 100, 5),
    referenceAmount: 65,
    stereoWidth,
    centerBass: true,
    cleanLowEnd: true,
    glueCompression: !percussiveArtifactRisk,
    deharsh: true,
    autoLevel,
    addPunch,
    addAir,
    cutMud: muddyOrVeiled,
    tapeWarmth,
    reasons: {
      codecStress: analysis.codecStress,
      limiterRisk,
      clippedOrPinned,
      lowBitrate,
      stereoRisk,
      fragileHighs,
      subToBassDB,
      percussiveArtifactRisk,
      artifactRescueRisk,
      pianoHighArtifactRisk: artifactRescueRisk
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
