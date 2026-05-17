import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  analyzeAIGeneratedMastering,
  getAIMasteringRecommendation,
  measureLUFS,
  findTruePeak
} from '../web/lib/dsp/index.js';

class NodeAudioBuffer {
  constructor({ numberOfChannels, length, sampleRate }) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel) {
    return this.channels[channel];
  }

  copyToChannel(source, channel, startInChannel = 0) {
    this.channels[channel].set(source, startInChannel);
  }
}

globalThis.AudioBuffer = NodeAudioBuffer;

function readString(buffer, offset, length) {
  return buffer.toString('ascii', offset, offset + length);
}

function readWav(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (readString(bytes, 0, 4) !== 'RIFF' || readString(bytes, 8, 4) !== 'WAVE') {
    throw new Error(`${filePath} is not a RIFF/WAVE file`);
  }

  let offset = 12;
  let fmt = null;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset + 8 <= bytes.length) {
    const id = readString(bytes, offset, 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ') {
      fmt = {
        audioFormat: bytes.readUInt16LE(body),
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bitsPerSample: bytes.readUInt16LE(body + 14)
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = size;
    }

    offset = body + size + (size % 2);
  }

  if (!fmt || !dataOffset) throw new Error(`${filePath} is missing fmt/data chunks`);
  if (fmt.audioFormat !== 1) throw new Error(`${filePath} is not PCM wav`);
  if (![16, 24, 32].includes(fmt.bitsPerSample)) {
    throw new Error(`${filePath} uses unsupported ${fmt.bitsPerSample}-bit PCM`);
  }

  const bytesPerSample = fmt.bitsPerSample / 8;
  const frameCount = Math.floor(dataSize / (bytesPerSample * fmt.channels));
  const audioBuffer = new NodeAudioBuffer({
    numberOfChannels: fmt.channels,
    length: frameCount,
    sampleRate: fmt.sampleRate
  });

  for (let i = 0; i < frameCount; i++) {
    for (let ch = 0; ch < fmt.channels; ch++) {
      const sampleOffset = dataOffset + (i * fmt.channels + ch) * bytesPerSample;
      let sample;
      if (fmt.bitsPerSample === 16) {
        sample = bytes.readInt16LE(sampleOffset) / 32768;
      } else if (fmt.bitsPerSample === 24) {
        sample = bytes.readIntLE(sampleOffset, 3) / 8388608;
      } else {
        sample = bytes.readInt32LE(sampleOffset) / 2147483648;
      }
      audioBuffer.getChannelData(ch)[i] = Math.max(-1, Math.min(1, sample));
    }
  }

  return { buffer: audioBuffer, format: fmt };
}

function downmix(buffer) {
  const mono = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < buffer.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}

function rms(data, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

function db(value) {
  return 20 * Math.log10(Math.max(value, 1e-12));
}

function windowArtifactStats(buffer, seconds = 0.5) {
  const mono = downmix(buffer);
  const size = Math.max(64, Math.floor(buffer.sampleRate * seconds));
  const windows = [];

  for (let start = 2; start < mono.length - 2; start += size) {
    const end = Math.min(mono.length - 2, start + size);
    let spikeCount = 0;
    let residualSum = 0;
    let peak = 0;

    for (let i = start; i < end; i++) {
      const predicted = (mono[i - 2] + mono[i - 1] * 2 + mono[i + 1] * 2 + mono[i + 2]) / 6;
      const residual = Math.abs(mono[i] - predicted);
      const localAvg = (
        Math.abs(mono[i - 2]) +
        Math.abs(mono[i - 1]) +
        Math.abs(mono[i + 1]) +
        Math.abs(mono[i + 2])
      ) / 4;
      residualSum += residual;
      peak = Math.max(peak, Math.abs(mono[i]));
      if (residual > Math.max(0.018, localAvg * 1.8)) spikeCount++;
    }

    const density = spikeCount / Math.max(1, end - start);
    windows.push({
      startSec: start / buffer.sampleRate,
      endSec: end / buffer.sampleRate,
      rmsDB: db(rms(mono, start, end)),
      peakDB: db(peak),
      spikeDensity: density,
      avgResidual: residualSum / Math.max(1, end - start),
      relativeResidual: (residualSum / Math.max(1, end - start)) / Math.max(rms(mono, start, end), 1e-6),
      score: density * 1000 + residualSum / Math.max(1, end - start) * 20
    });
  }

  return windows.sort((a, b) => b.score - a.score).slice(0, 12);
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

function summarize(label, filePath) {
  const { buffer, format } = readWav(filePath);
  const analysis = analyzeAIGeneratedMastering(buffer);
  const recommendation = getAIMasteringRecommendation(analysis, { isLossy: false });
  const lufs = measureLUFS(buffer);
  const truePeak = findTruePeak(buffer);
  return {
    label,
    file: filePath,
    format,
    duration: buffer.duration,
    lufs,
    truePeak,
    analysis,
    recommendation,
    artifactWindows: windowArtifactStats(buffer)
  };
}

function fileHash(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function printSummary(item) {
  const p = item.analysis.profile;
  const peaks = item.analysis.peaks;
  console.log(`\n## ${item.label}`);
  console.log(`file: ${path.basename(item.file)}`);
  console.log(`format: ${item.format.sampleRate} Hz, ${item.format.bitsPerSample}-bit, ${item.format.channels} ch, ${round(item.duration, 2)} sec`);
  console.log(`loudness: ${round(item.lufs, 2)} LUFS, truePeak: ${round(item.truePeak, 2)} dBTP`);
  console.log(`profile dB: mud ${round(p.mudDB)}, presence/body ${round(p.presenceToBodyDB)}, harsh ${round(p.harshDB)}, metallic ${round(p.metallicDB)}, air ${round(p.airDB)}`);
  const avgRelativeResidual = item.artifactWindows.reduce((sum, win) => sum + win.relativeResidual, 0) / Math.max(1, item.artifactWindows.length);
  console.log(`risk: codec ${round(item.analysis.codecStress, 3)}, limiter ${round(item.analysis.limiterRisk, 3)}, peakDensity ${round(peaks.peakDensity, 6)}, spikeDensity ${round(peaks.spikeDensity, 6)}, avgResidual ${round(peaks.avgSpikeResidual, 6)}, topRelativeResidual ${round(avgRelativeResidual, 4)}, loudestCrest ${round(peaks.loudestCrestDB)}`);
  console.log(`ai recommendation: target ${item.recommendation.targetLufs} LUFS, input ${item.recommendation.inputGain} dB, ceiling ${item.recommendation.truePeakCeiling} dBTP, artifact ${item.recommendation.artifactProtection}%, sibilance ${item.recommendation.sibilanceProtection}%, rescue ${Boolean(item.recommendation.reasons?.artifactRescueRisk)}`);
  console.log('top artifact windows:');
  for (const win of item.artifactWindows.slice(0, 6)) {
    console.log(`  ${round(win.startSec, 2)}-${round(win.endSec, 2)}s score ${round(win.score, 4)} spike ${round(win.spikeDensity, 6)} rel ${round(win.relativeResidual, 4)} rms ${round(win.rmsDB)} peak ${round(win.peakDB)}`);
  }
}

const sampleDir = path.resolve('sample');
const wamFiles = fs.readdirSync(sampleDir)
  .filter(file => /^BURN THE BRIDGE_wam(?: - #\d+)?\.wav$/i.test(file))
  .sort((a, b) => {
    const getTake = (name) => Number(name.match(/#(\d+)/)?.[1] || 1);
    return getTake(a) - getTake(b);
  })
  .map(file => {
    const take = file.match(/#(\d+)/)?.[1];
    return [take ? `WAM #${take}` : 'WAM', path.join(sampleDir, file)];
  });
const files = [
  ['Original', path.join(sampleDir, 'BURN THE BRIDGE.wav')],
  ['BandLab', path.join(sampleDir, 'BURN THE BRIDGE bandlab.wav')],
  ...wamFiles
];

const hashes = new Map();
for (const [label, file] of files) {
  const hash = fileHash(file);
  const duplicateOf = hashes.get(hash);
  if (duplicateOf) {
    console.log(`\n!! ${label} is byte-identical to ${duplicateOf}; reload/re-render before judging audio changes.`);
  } else {
    hashes.set(hash, label);
  }
}

const results = files.map(([label, file]) => summarize(label, file));
for (const result of results) printSummary(result);

const bandlab = results.find(item => item.label === 'BandLab');
for (const wam of results.filter(item => item.label.startsWith('WAM'))) {
  console.log(`\n## ${wam.label} vs BandLab`);
  console.log(`LUFS delta: ${round(wam.lufs - bandlab.lufs)} dB`);
  console.log(`truePeak delta: ${round(wam.truePeak - bandlab.truePeak)} dB`);
  console.log(`metallic delta: ${round(wam.analysis.profile.metallicDB - bandlab.analysis.profile.metallicDB)} dB`);
  console.log(`harsh delta: ${round(wam.analysis.profile.harshDB - bandlab.analysis.profile.harshDB)} dB`);
  console.log(`air delta: ${round(wam.analysis.profile.airDB - bandlab.analysis.profile.airDB)} dB`);
  console.log(`spikeDensity delta: ${round(wam.analysis.peaks.spikeDensity - bandlab.analysis.peaks.spikeDensity, 6)}`);
  console.log(`avgResidual delta: ${round(wam.analysis.peaks.avgSpikeResidual - bandlab.analysis.peaks.avgSpikeResidual, 6)}`);
}
