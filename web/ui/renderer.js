/**
 * Renderer Module
 * Offline audio rendering for export and cache
 */

import {
  measureLUFS,
  normalizeToLUFS,
  applyGain,
  applyExciter,
  applyTapeWarmth,
  processHybridDynamic,
  applyDynamicLeveling,
  applyMasteringSoftClip,
  applyLookaheadLimiter,
  applyFinalFilters,
  getAdaptiveFinalFilterOptions,
  adjustStereoWidth,
  analyzeAIGeneratedMastering,
  applyAIGeneratedMasteringRepair,
  applyMetallicRescueTone,
  applyArtifactSafeAirRecovery,
  applyReferenceMatch,
  applyLimiterStressGuard,
  applyStereoStabilityGuard,
  applyPianoHighArtifactSuppressor,
  finalizeMasteringTarget,
  findTruePeak
} from '../lib/dsp/index.js';
import { applyMultibandTransient } from '../lib/dsp/multiband-transient.js';
import { encodeWAVAsync, createOfflineNodes } from './encoder.js';

// ============================================================================
// Shared DSP Chain
// ============================================================================

/**
 * Create offline rendering context with connected audio nodes
 * @param {AudioBuffer} sourceBuffer - Source audio buffer
 * @param {Object} settings - Processing settings
 * @param {number} targetSampleRate - Output sample rate
 * @returns {Object} { offlineCtx, source, nodes }
 */
function createRenderContext(sourceBuffer, settings, targetSampleRate) {
  const duration = sourceBuffer.duration;
  const numSamples = Math.ceil(duration * targetSampleRate);
  const artifactSafeMode = settings.isLossySource ||
    (settings.artifactProtection ?? 0) >= 0.78 ||
    (settings.sibilanceProtection ?? 0) >= 0.75;

  const channelCount = artifactSafeMode ? sourceBuffer.numberOfChannels : 2;
  const offlineCtx = new OfflineAudioContext(channelCount, numSamples, targetSampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = sourceBuffer;

  if (artifactSafeMode) {
    source.connect(offlineCtx.destination);
    return { offlineCtx, source, nodes: null };
  }

  const nodes = createOfflineNodes(offlineCtx, settings);

  // Connect audio chain: source → inputGain → filters → compressor → stereo → limiter → destination
  source.connect(nodes.inputGain)
    .connect(nodes.highpass)
    .connect(nodes.eqLow)
    .connect(nodes.eqLowMid)
    .connect(nodes.eqMid)
    .connect(nodes.eqHighMid)
    .connect(nodes.eqHigh)
    .connect(nodes.lowshelf)
    .connect(nodes.midPeak)
    .connect(nodes.highshelf)
    .connect(nodes.compressor)
    .connect(nodes.stereoSplitter);

  nodes.stereoSplitter.connect(nodes.lToMid, 0);
  nodes.stereoSplitter.connect(nodes.lToSide, 0);
  nodes.stereoSplitter.connect(nodes.rToMid, 1);
  nodes.stereoSplitter.connect(nodes.rToSide, 1);

  nodes.lToMid.connect(nodes.stereoMerger, 0, 0);
  nodes.rToMid.connect(nodes.stereoMerger, 0, 0);
  nodes.lToSide.connect(nodes.stereoMerger, 0, 1);
  nodes.rToSide.connect(nodes.stereoMerger, 0, 1);

  nodes.stereoMerger.connect(nodes.limiter).connect(offlineCtx.destination);

  return { offlineCtx, source, nodes };
}

/**
 * Apply DSP processing chain to a buffer
 * Chain: Deharsh → Exciter → Saturation → Transient → LPF → LUFS → Normalize → Soft Clip → Limit
 * @param {AudioBuffer} buffer - Input buffer
 * @param {Object} settings - Processing settings
 * @param {Function} onProgress - Optional progress callback (receives 0-1 values)
 * @param {string} logPrefix - Log prefix for debugging
 * @returns {{ buffer: AudioBuffer, measuredLufs: number }} Processed buffer and pre-normalize LUFS
 */
function applyDSPChain(buffer, settings, onProgress = null, logPrefix = '[DSP]') {
  let renderedBuffer = buffer;
  let aiProfile = {
    softClipDrive: 1.5,
    maxLimiterPushDB: 1.2
  };
  const artifactSafeMode = settings.isLossySource ||
    (settings.artifactProtection ?? 0) >= 0.78 ||
    (settings.sibilanceProtection ?? 0) >= 0.75;
  const rescueArtifactMode = (settings.artifactProtection ?? 0) >= 0.85;
  const requestedTargetLufs = settings.targetLufs ?? -14;
  const targetLufs = artifactSafeMode
    ? Math.min(
      Math.max(requestedTargetLufs, settings.isLossySource ? -13.6 : -13.0),
      rescueArtifactMode ? -12.9 : -13.1
    )
    : settings.targetLufs;

  if (artifactSafeMode) {
    const inputGainDb = Number(settings.inputGain) || 0;
    if (inputGainDb !== 0) {
      renderedBuffer = applyGain(renderedBuffer, inputGainDb);
    }
    if (settings.cleanLowEnd) {
      renderedBuffer = applyFinalFilters(renderedBuffer, {
        highpass: true,
        lowpass: false,
        highpassFreq: 30,
        highpassQ: 0.7
      });
    }
  }

  // 1. Deharsh / Hybrid Dynamic Processor (if enabled)
  if (settings.deharsh && !artifactSafeMode) {
    console.log(`${logPrefix} Applying hybrid dynamic processor...`);
    renderedBuffer = processHybridDynamic(renderedBuffer, 'mastering', (p) => {
      if (onProgress) onProgress(p * 0.15);
    });
  }
  if (onProgress) onProgress(0.15);

  // 1.5 AI-generated / lossy-source repair
  if (settings.aiEnhance !== false && !artifactSafeMode) {
    console.log(`${logPrefix} Applying AI-source repair...`);
    const repaired = applyAIGeneratedMasteringRepair(renderedBuffer, {
      profile: settings.aiProfile || 'auto',
      intensity: settings.aiIntensity ?? 1,
      sibilanceProtection: settings.sibilanceProtection ?? 0.6,
      artifactProtection: settings.artifactProtection ?? 0.7,
      isLossySource: settings.isLossySource,
      cleanLowEnd: settings.cleanLowEnd
    });
    renderedBuffer = repaired.buffer;
    aiProfile = repaired.profile || aiProfile;
    if (repaired.moves) {
      console.log(`${logPrefix} AI profile:`, aiProfile.name, 'moves:', repaired.moves);
    }
  }
  if (onProgress) onProgress(0.22);

  if (settings.autoLevel && !artifactSafeMode) {
    console.log(`${logPrefix} Applying auto level...`);
    renderedBuffer = applyDynamicLeveling(renderedBuffer, {
      windowMs: 250,
      quietThresholdDB: -42,
      expansionRatio: 1.12,
      maxGainDB: 3,
      crestThresholdDB: 12,
      attackMs: 25,
      releaseMs: 220,
      peakLimit: 0.9
    }, (p) => {
      if (onProgress) onProgress(0.22 + p * 0.04);
    });
  }
  if (onProgress) onProgress(0.26);

  // 2. Exciter / Add Air (if enabled)
  if (settings.addAir && !artifactSafeMode) {
    console.log(`${logPrefix} Applying exciter...`);
    renderedBuffer = applyExciter(renderedBuffer, (p) => {
      if (onProgress) onProgress(0.26 + p * 0.04);
    });
  }
  if (onProgress) onProgress(0.30);

  // 3. Multiband Saturation / Tape Warmth (if enabled)
  if (settings.tapeWarmth && !artifactSafeMode) {
    console.log(`${logPrefix} Applying multiband saturation...`);
    renderedBuffer = applyTapeWarmth(renderedBuffer, (p) => {
      if (onProgress) onProgress(0.30 + p * 0.15);
    });
  }
  if (onProgress) onProgress(0.45);

  // 4. Multiband Transient / Add Punch (if enabled)
  if (settings.addPunch && !artifactSafeMode) {
    console.log(`${logPrefix} Applying multiband transient...`);
    const transientAmount = settings.isLossySource || (settings.artifactProtection ?? 0) >= 0.78
      ? 0.45
      : 1;
    renderedBuffer = applyMultibandTransient(renderedBuffer, (p) => {
      if (onProgress) onProgress(0.45 + p * 0.15);
    }, { amount: transientAmount });
  }
  if (onProgress) onProgress(0.60);

  if (artifactSafeMode) {
    console.log(`${logPrefix} Suppressing high-note piano artifacts...`);
    const artifactAmount = Math.max(0, Math.min(1, settings.artifactProtection ?? 0.7));
    const artifactPreAnalysis = analyzeAIGeneratedMastering(renderedBuffer);
    const darkArtifactSafeSource = !settings.isLossySource &&
      (artifactPreAnalysis.profile?.airDB ?? -18) < -16.2 &&
      (artifactPreAnalysis.profile?.metallicDB ?? -18) < -18 &&
      (artifactPreAnalysis.profile?.harshDB ?? -18) < -14;
    renderedBuffer = applyPianoHighArtifactSuppressor(renderedBuffer, {
      amount: darkArtifactSafeSource
        ? Math.min(0.88, 0.54 + artifactAmount * 0.36)
        : Math.min(0.96, 0.58 + artifactAmount * 0.42),
      sensitivity: darkArtifactSafeSource
        ? Math.min(0.9, 0.42 + artifactAmount * 0.5)
        : Math.min(1, 0.45 + artifactAmount * 0.6)
    });
    const rescueAnalysis = artifactAmount >= 0.88 ? analyzeAIGeneratedMastering(renderedBuffer) : null;
    const needsMetallicToneCut = rescueAnalysis && (
      (rescueAnalysis.profile?.metallicDB ?? -18) > -16.5 ||
      (rescueAnalysis.profile?.harshDB ?? -18) > -12.5 ||
      (rescueAnalysis.codecStress ?? 0) > 0.7
    );
    if (needsMetallicToneCut) {
      const rescued = applyMetallicRescueTone(renderedBuffer, {
        amount: Math.min(0.55, (artifactAmount - 0.84) / 0.28),
        sibilanceProtection: settings.sibilanceProtection ?? 0.75,
        artifactProtection: artifactAmount,
        isLossySource: settings.isLossySource
      });
      renderedBuffer = rescued.buffer;
      const recovered = applyArtifactSafeAirRecovery(renderedBuffer, {
        amount: settings.isLossySource ? 0.35 : 0.75
      });
      renderedBuffer = recovered.buffer;
      if (rescued.moves) {
        console.log(`${logPrefix} Metallic rescue moves:`, rescued.moves);
      }
      if (recovered.moves && !recovered.moves.skipped) {
        console.log(`${logPrefix} Post-metallic air recovery moves:`, recovered.moves);
      }
    } else {
      const recovered = applyArtifactSafeAirRecovery(renderedBuffer, {
        amount: settings.isLossySource ? 0.55 : 1
      });
      renderedBuffer = recovered.buffer;
      if (recovered.moves && !recovered.moves.skipped) {
        console.log(`${logPrefix} Artifact-safe air recovery moves:`, recovered.moves);
      }
    }
  }

  if (settings.referenceMatch && settings.referenceAnalysis && !artifactSafeMode) {
    console.log(`${logPrefix} Matching reference tone...`);
    const matched = applyReferenceMatch(renderedBuffer, settings.referenceAnalysis, {
      amount: settings.referenceAmount ?? 0.65
    });
    renderedBuffer = matched.buffer;
    if (matched.moves) {
      console.log(`${logPrefix} Reference moves:`, matched.moves);
    }
  }

  if (renderedBuffer.numberOfChannels === 2 && settings.aiEnhance !== false && !artifactSafeMode) {
    console.log(`${logPrefix} Stabilizing AI stereo image...`);
    const stereoGuarded = applyStereoStabilityGuard(renderedBuffer, {
      amount: settings.aiIntensity ?? 1
    });
    renderedBuffer = stereoGuarded.buffer;
    if (stereoGuarded.moves) {
      console.log(`${logPrefix} Stereo guard moves:`, stereoGuarded.moves);
    }
  }

  if (renderedBuffer.numberOfChannels === 2 && settings.aiEnhance !== false && !artifactSafeMode) {
    const baseWidth = Number.isFinite(Number(settings.stereoWidth)) ? Number(settings.stereoWidth) / 100 : 1;
    const profileWidth = aiProfile.stereoWidthScale ?? 1;
    const effectiveWidth = Math.max(0, Math.min(2, baseWidth * profileWidth));
    const bassFreq = aiProfile.bassMonoFreq ?? 200;
    if (settings.centerBass || Math.abs(effectiveWidth - 1) > 0.01) {
      renderedBuffer = adjustStereoWidth(renderedBuffer, effectiveWidth, !!settings.centerBass, bassFreq);
    }
  }

  // 5. Apply adaptive final air cleanup.
  // Note: HPF (Clean Low End) is already handled by the WebAudio highpass node in the offline render graph.
  const finalFilterAnalysis = settings.aiEnhance !== false && !artifactSafeMode ? analyzeAIGeneratedMastering(renderedBuffer) : null;
  const finalFilterOptions = getAdaptiveFinalFilterOptions(finalFilterAnalysis, settings);
  console.log(`${logPrefix} Applying final air cleanup...`, finalFilterOptions);
  renderedBuffer = applyFinalFilters(renderedBuffer, {
    highpass: false,
    ...finalFilterOptions
  });
  if (onProgress) onProgress(0.65);

  // 6. Measure LUFS (after all processing, before normalization)
  const measuredLufs = measureLUFS(renderedBuffer);
  console.log(`${logPrefix} Measured LUFS:`, measuredLufs.toFixed(1));

  // 7. Normalize to target LUFS (if enabled)
  if (settings.normalizeLoudness && targetLufs) {
    console.log(`${logPrefix} Normalizing to target LUFS:`, targetLufs);
    if (artifactSafeMode) {
      const currentPeakDB = findTruePeak(renderedBuffer);
      const desiredGainDB = Number.isFinite(measuredLufs) ? targetLufs - measuredLufs : 0;
      const peakSafeGainDB = (settings.truePeakCeiling || -1) - 0.3 - currentPeakDB;
      const gainDB = Math.min(desiredGainDB, peakSafeGainDB);
      console.log(`${logPrefix} Artifact-safe gain:`, gainDB.toFixed(2), 'dB');
      renderedBuffer = applyGain(renderedBuffer, gainDB);
      if (settings.truePeakLimit && desiredGainDB > gainDB + 0.25) {
        const artifactAmount = Math.max(0, Math.min(1, settings.artifactProtection ?? 0.7));
        const calibrated = finalizeMasteringTarget(renderedBuffer, {
          targetLufs,
          ceilingDB: settings.truePeakCeiling || -1.5,
          toleranceDB: 0.25,
          maxLimiterPushDB: artifactAmount >= 0.9 ? 1.35 : 1.8
        });
        renderedBuffer = calibrated.buffer;
      }
    } else {
      // Apply gain only; final peak control happens in the clipper/limiter stages below.
      renderedBuffer = normalizeToLUFS(renderedBuffer, targetLufs, 0, { skipLimiter: true });
    }
  }
  if (onProgress) onProgress(0.75);

  if (artifactSafeMode) {
    const polished = applyArtifactSafeAirRecovery(renderedBuffer, {
      amount: settings.isLossySource ? 0.45 : 0.95
    });
    renderedBuffer = polished.buffer;
    if (polished.moves && !polished.moves.skipped) {
      console.log(`${logPrefix} Final artifact-safe air polish moves:`, polished.moves);
    }
  }

  if (settings.truePeakLimit && settings.aiEnhance !== false && !artifactSafeMode) {
    console.log(`${logPrefix} Applying limiter stress guard...`);
    const limiterCharacter = settings.limiterCharacter || 'balanced';
    const guardAmount = limiterCharacter === 'transparent' ? 0.65
      : limiterCharacter === 'punch' ? 0.9
        : limiterCharacter === 'dense' ? 1.15
          : 0.85;
    const guarded = applyLimiterStressGuard(renderedBuffer, {
      amount: guardAmount,
      targetLufs: targetLufs ?? -12,
      intensity: settings.aiIntensity ?? 1
    });
    renderedBuffer = guarded.buffer;
    if (guarded.moves) {
      console.log(`${logPrefix} Limiter guard moves:`, guarded.moves);
    }
  }

  // 8. Soft Clipper (reduces peak-to-loudness ratio before limiting)
  if (settings.truePeakLimit && !artifactSafeMode) {
    const ceiling = settings.truePeakCeiling || -1;
    console.log(`${logPrefix} Applying mastering soft clip (ceiling:`, ceiling, 'dB)...');
    const limiterCharacter = settings.limiterCharacter || 'balanced';
    const limiterDriveScale = limiterCharacter === 'transparent' ? 0.85
      : limiterCharacter === 'punch' ? 1.05
        : limiterCharacter === 'dense' ? 1.2
          : 1.0;
    const artifactSafeScale = settings.isLossySource || (settings.artifactProtection ?? 0) >= 0.78
      ? 0.72
      : 1;
    renderedBuffer = applyMasteringSoftClip(renderedBuffer, {
      ceiling: ceiling,
      lookaheadMs: 0.5,
      releaseMs: 10,
      drive: (aiProfile.softClipDrive ?? 1.5) * Math.sqrt(settings.aiIntensity ?? 1) * limiterDriveScale * artifactSafeScale
    }, (p) => {
      if (onProgress) onProgress(0.75 + p * 0.15);
    });
  }
  if (onProgress) onProgress(0.90);

  // 9. True Peak Limiting - final safety clip (if enabled)
  if (settings.truePeakLimit && !artifactSafeMode) {
    const ceiling = settings.truePeakCeiling || -1;
    const ceilingLinear = Math.pow(10, ceiling / 20);
    console.log(`${logPrefix} Applying true peak limiter (ceiling:`, ceiling, 'dB)...');
    renderedBuffer = applyLookaheadLimiter(renderedBuffer, ceilingLinear);
  }

  if (settings.normalizeLoudness && targetLufs && settings.truePeakLimit && !artifactSafeMode) {
    const ceiling = settings.truePeakCeiling || -1;
    console.log(`${logPrefix} Final loudness/peak calibration...`);
    const calibrated = finalizeMasteringTarget(renderedBuffer, {
      targetLufs,
      ceilingDB: ceiling,
      toleranceDB: 0.15,
      maxLimiterPushDB: (aiProfile.maxLimiterPushDB ?? 1.2) * Math.sqrt(settings.aiIntensity ?? 1) * (
        settings.limiterCharacter === 'transparent' ? 0.75
          : settings.limiterCharacter === 'punch' ? 1.05
            : settings.limiterCharacter === 'dense' ? 1.25
              : 1.0
      ) * (artifactSafeMode ? 0.25 : 1)
    });
    renderedBuffer = calibrated.buffer;
  }
  if (onProgress) onProgress(1.0);

  return { buffer: renderedBuffer, measuredLufs };
}

function ensureFinalRenderSafety(buffer, settings, logPrefix = '[DSP]') {
  if (!buffer || !settings.truePeakLimit) return buffer;

  const ceiling = Number.isFinite(Number(settings.truePeakCeiling))
    ? Number(settings.truePeakCeiling)
    : -1;
  const truePeak = findTruePeak(buffer);

  if (Number.isFinite(truePeak) && truePeak > ceiling + 0.02) {
    console.warn(`${logPrefix} Post-render true peak exceeded ceiling, applying safety limiter:`, {
      truePeak,
      ceiling
    });
    return applyLookaheadLimiter(
      buffer,
      Math.pow(10, ceiling / 20),
      3,
      180,
      3,
      true
    );
  }

  console.log(`${logPrefix} Final safety check:`, {
    truePeak: Number.isFinite(truePeak) ? truePeak.toFixed(2) : '--',
    ceiling
  });
  return buffer;
}

/**
 * Resample an AudioBuffer to a target sample rate.
 * Uses OfflineAudioContext so output sample data and WAV header stay aligned.
 * @param {AudioBuffer} sourceBuffer - Source audio buffer
 * @param {number} targetSampleRate - Target sample rate in Hz
 * @returns {Promise<AudioBuffer>} Resampled buffer (or original if unchanged)
 */
export async function resampleAudioBuffer(sourceBuffer, targetSampleRate) {
  if (!sourceBuffer || !targetSampleRate || sourceBuffer.sampleRate === targetSampleRate) {
    return sourceBuffer;
  }

  const numChannels = sourceBuffer.numberOfChannels;
  const numSamples = Math.ceil(sourceBuffer.duration * targetSampleRate);
  const offlineCtx = new OfflineAudioContext(numChannels, numSamples, targetSampleRate);
  const source = offlineCtx.createBufferSource();

  source.buffer = sourceBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);

  return offlineCtx.startRendering();
}

// ============================================================================
// Offline Rendering (Export)
// ============================================================================

/**
 * Render audio buffer through effects chain using OfflineAudioContext
 * @param {AudioBuffer} sourceBuffer - Source audio buffer
 * @param {Object} settings - Processing settings
 * @param {Function} onProgress - Progress callback (0-100)
 * @param {Object} options - Additional render options
 * @param {Function} options.shouldCancel - Optional cancellation predicate
 * @returns {Promise<Uint8Array>} WAV file data
 */
export async function renderOffline(sourceBuffer, settings, onProgress, options = {}) {
  const { shouldCancel = null, onRenderedBuffer = null } = options || {};
  const throwIfCancelled = () => {
    if (shouldCancel && shouldCancel()) {
      throw new Error('Cancelled');
    }
  };

  const targetSampleRate = settings.sampleRate || 44100;

  console.log('[Offline Render] Starting...', {
    duration: sourceBuffer.duration,
    targetSampleRate,
    numSamples: Math.ceil(sourceBuffer.duration * targetSampleRate)
  });

  // Create offline context and connect nodes
  const { offlineCtx, source } = createRenderContext(sourceBuffer, settings, targetSampleRate);
  source.start(0);
  if (onProgress) onProgress(10);
  throwIfCancelled();

  // Render through Web Audio nodes
  let renderPhaseTimer = null;
  if (onProgress) {
    let fakeProgress = 10;
    renderPhaseTimer = setInterval(() => {
      fakeProgress = Math.min(14, fakeProgress + 1);
      onProgress(fakeProgress);
      if (fakeProgress >= 14 && renderPhaseTimer) {
        clearInterval(renderPhaseTimer);
        renderPhaseTimer = null;
      }
    }, 1000);
  }

  let renderedBuffer;
  try {
    renderedBuffer = await offlineCtx.startRendering();
  } finally {
    if (renderPhaseTimer) clearInterval(renderPhaseTimer);
  }
  throwIfCancelled();
  if (onProgress) onProgress(15);
  // Allow the UI to repaint before the synchronous DSP stages begin.
  await new Promise(resolve => setTimeout(resolve, 0));

  // Apply DSP chain with progress mapping (15-75%)
  const dspResult = applyDSPChain(renderedBuffer, settings, (p) => {
    if (onProgress) onProgress(15 + p * 60);
  }, '[Offline Render]');
  renderedBuffer = ensureFinalRenderSafety(dspResult.buffer, settings, '[Offline Render]');
  if (typeof onRenderedBuffer === 'function') {
    onRenderedBuffer(renderedBuffer);
  }
  throwIfCancelled();

  if (onProgress) onProgress(75);
  // Allow the UI to repaint before WAV encoding begins.
  await new Promise(resolve => setTimeout(resolve, 0));

  // Encode to WAV
  const wavData = await encodeWAVAsync(renderedBuffer, targetSampleRate, settings.bitDepth || 16, {
    onProgress: (p) => {
      if (onProgress) onProgress(75 + p * 15);
    },
    ditherMode: settings.ditherMode,
    shouldCancel: shouldCancel
  });
  if (onProgress) onProgress(90);

  console.log('[Offline Render] Complete!', { outputSize: wavData.byteLength });
  return wavData;
}

// ============================================================================
// Cache Rendering (Preview)
// ============================================================================

/**
 * Render to AudioBuffer (for cache/preview)
 * Preview mode returns a "heavy FX only" buffer for the hybrid live chain.
 * Export/full mode returns a fully rendered buffer (same as renderOffline, but as AudioBuffer).
 * @param {AudioBuffer} sourceBuffer - Source audio buffer
 * @param {Object} settings - Processing settings
 * @param {string} mode - 'preview' (heavy FX only) or 'export' (full chain)
 * @returns {Promise<{buffer: AudioBuffer, lufs: number}>}
 */
export async function renderToAudioBuffer(sourceBuffer, settings, mode = 'preview') {
  if (mode === 'preview') {
    // Hybrid pipeline cache: heavy FX only (Deharsh, Exciter, Warmth, Punch)
    console.log('[Cache Render] Starting (Preview)...', {
      duration: sourceBuffer.duration,
      sampleRate: sourceBuffer.sampleRate
    });

    // Clone to avoid mutating the original buffer
    let renderedBuffer = new AudioBuffer({
      numberOfChannels: sourceBuffer.numberOfChannels,
      length: sourceBuffer.length,
      sampleRate: sourceBuffer.sampleRate
    });
    for (let ch = 0; ch < sourceBuffer.numberOfChannels; ch++) {
      renderedBuffer.copyToChannel(sourceBuffer.getChannelData(ch), ch);
    }

    if (settings.deharsh) {
      renderedBuffer = processHybridDynamic(renderedBuffer, 'mastering', null);
    }
    if (settings.addAir) {
      renderedBuffer = applyExciter(renderedBuffer, null);
    }
    if (settings.tapeWarmth) {
      renderedBuffer = applyTapeWarmth(renderedBuffer, null);
    }
    if (settings.addPunch) {
      const transientAmount = settings.isLossySource || (settings.artifactProtection ?? 0) >= 0.78
        ? 0.45
        : 1;
      renderedBuffer = applyMultibandTransient(renderedBuffer, null, { amount: transientAmount });
    }

    const lufs = measureLUFS(renderedBuffer);
    console.log('[Cache Render] Preview LUFS:', lufs.toFixed(1));
    return { buffer: renderedBuffer, lufs };
  }

  // Full chain cache (export parity)
  const targetSampleRate = sourceBuffer.sampleRate;

  console.log('[Cache Render] Starting (Full)...', {
    duration: sourceBuffer.duration,
    targetSampleRate,
    numSamples: Math.ceil(sourceBuffer.duration * targetSampleRate)
  });

  const { offlineCtx, source } = createRenderContext(sourceBuffer, settings, targetSampleRate);
  source.start(0);

  let renderedBuffer = await offlineCtx.startRendering();

  const dspResult = applyDSPChain(renderedBuffer, settings, null, '[Cache Render]');
  renderedBuffer = ensureFinalRenderSafety(dspResult.buffer, settings, '[Cache Render]');

  const finalLufs = measureLUFS(renderedBuffer);
  console.log('[Cache Render] Final LUFS:', finalLufs.toFixed(1));

  return { buffer: renderedBuffer, lufs: finalLufs };
}
