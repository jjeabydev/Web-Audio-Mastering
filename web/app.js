// Import DSP Worker Interface
import { DSP_RENDER_REVISION, initDSPWorker, getDSPWorker } from './workers/worker-interface.js';

// Import DSP modules
import {
  measureLUFS,
  findTruePeak,
  applyLookaheadLimiter,
  normalizeToLUFS,
  applyGain,
  analyzeAIGeneratedMastering,
  chooseAIMasteringProfile,
  getAIMasteringRecommendation,
  getAIGeneratedMasteringMoves,
  detectDCOffsetBuffer,
  removeDCOffset,
  getDCOffsetSeverity
} from './lib/dsp/index.js';

// Import presets
import { eqPresets, outputPresets } from './lib/presets/index.js';

// Import UI modules
import {
  // Controls
  eqValues,
  inputGainValue,
  ceilingValueDb,
  targetLufsDb,
  getCurrentSettings,
  getExportSettings,
  initFaders,
  faders,
  setupEQPresets,
  setupOutputPresets,
  updateOutputPresetButtons,
  setTargetLufs,
  setReferenceAnalysis,
  // Meters
  meterState,
  startMeter,
  stopMeter,
  updateLufsDisplay,
  playerState,
  formatTime,
  updatePlayPauseIcon,
  // Encoder
  encodeWAVAsync,
  // Renderer
  renderOffline,
  renderToAudioBuffer,
  resampleAudioBuffer,
  // Waveform
  initWaveSurfer,
  destroyWaveSurfer,
  updateWaveSurferProgress,
  updateWaveformBuffer,
  updateWaveformPeaks,
  showOriginalWaveform
} from './ui/index.js';

if (typeof window !== 'undefined') {
  window.__WAM_DSP_RENDER_REVISION = DSP_RENDER_REVISION;
}
console.info('[Runtime] DSP render revision:', DSP_RENDER_REVISION);

let currentFile = null; // Store the currently selected File object (browser)


// DSP functions imported from ./lib/dsp/index.js
// Presets imported from ./lib/presets/index.js
// UI state and functions imported from ./ui/index.js

// ============================================================================
// Application State (Audio-specific - UI state in ./ui/ modules)
// ============================================================================

const audioNodes = {
  context: null,
  source: null,
  buffer: null,
  analyser: null,
  analyserL: null,   // Left channel analyser for meter
  analyserR: null,   // Right channel analyser for meter
  meterSplitter: null,
  directMeterUpmix: null, // Up-mix node for meter when bypassed
  gain: null,
  // Input gain (first in chain)
  inputGain: null,
  // Effects chain
  highpass: null,
  lowshelf: null,    // mud cut
  highshelf: null,   // air boost
  midPeak: null,     // harshness
  previewBass: null,
  previewMud: null,
  previewPresence: null,
  previewSibilance: null,
  previewHarsh: null,
  previewMetallic: null,
  previewAir: null,
  compressor: null,
  limiter: null,
  // 5-band EQ
  eqLow: null,
  eqLowMid: null,
  eqMid: null,
  eqHighMid: null,
  eqHigh: null,
  // Stereo width (M/S processing)
  stereoSplitter: null,
  stereoMerger: null,
  midGainL: null,
  midGainR: null,
  sideGainL: null,
  sideGainR: null
};

const fileState = {
  selectedFilePath: null,
  originalBuffer: null,      // Original audio buffer
  normalizedBuffer: null,    // Loudness normalized buffer
  normalizedTargetLufs: null, // Target used for normalizedBuffer
  processedBuffer: null,     // Buffer after denoise/exciter processing
  isNormalizing: false,      // True while normalization is in progress
  isProcessingEffects: false, // True while applying denoise/exciter
  dcOffset: null,            // DC offset info { percent, severity, removed }
  // Cached render buffer architecture
  cachedRenderBuffer: null,  // Fully rendered buffer (all DSP applied)
  cachedRenderLufs: null,    // LUFS measured from cached buffer
  isRenderingCache: false,   // True while rendering to cache
  cacheRenderVersion: 0,     // Increments on each settings change
  estimatedBitrateKbps: null,
  aiAnalysis: null,          // Cached source analysis for responsive live preview
  aiAutoRecommendation: null,
  waveformMode: 'original',  // 'original' | 'processed'
  forceLivePreview: false    // True while waiting for full rendered preview to catch up
};

// Level meter state imported from ./ui/meters.js

let isProcessing = false;
let processingCancelled = false;
let processingPromise = null; // Track processing for proper cancellation

// ============================================================================
// DOM Elements (File handling - UI controls in ./ui/ modules)
// ============================================================================

const fileInput = document.getElementById('fileInput'); // Browser file input
const referenceInput = document.getElementById('referenceInput');
const selectReferenceBtn = document.getElementById('selectReference');
const clearReferenceBtn = document.getElementById('clearReference');
const referenceName = document.getElementById('referenceName');

const selectFileBtn = document.getElementById('selectFile');
const changeFileBtn = document.getElementById('changeFile');
const fileZoneContent = document.getElementById('fileZoneContent');
const fileLoaded = document.getElementById('fileLoaded');
const fileName = document.getElementById('fileName');
const fileMeta = document.getElementById('fileMeta');
const dcOffsetBadge = document.getElementById('dcOffsetBadge');
const dropZone = document.getElementById('dropZone');
const processBtn = document.getElementById('processBtn');
const cancelBtn = document.getElementById('cancelBtn');
const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const runtimeRevision = document.getElementById('runtimeRevision');
const statusMessage = document.getElementById('statusMessage');
const seekBar = document.getElementById('seekBar');
const playBtn = document.getElementById('playBtn');
const stopBtn = document.getElementById('stopBtn');
const bypassBtn = document.getElementById('bypassBtn');
const peakL = document.getElementById('peakL');
const peakR = document.getElementById('peakR');

function formatRevisionLabel(revision) {
  return String(revision || 'unknown').replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

if (runtimeRevision) {
  runtimeRevision.textContent = `DSP ${formatRevisionLabel(DSP_RENDER_REVISION)}`;
  runtimeRevision.title = `Runtime DSP revision: ${DSP_RENDER_REVISION}`;
}

// Toast helper with auto-clear
let toastTimeout = null;
function showToast(message, type = '', duration = 5000) {
  if (toastTimeout) clearTimeout(toastTimeout);
  statusMessage.textContent = message;
  statusMessage.className = 'status-message' + (type ? ' ' + type : '');
  if (duration > 0) {
    toastTimeout = setTimeout(() => {
      statusMessage.textContent = '';
      statusMessage.className = 'status-message';
    }, duration);
  }
}

// Mini checklist
const miniFormat = document.getElementById('mini-format');
const miniMastering = document.getElementById('mini-mastering');
const miniReference = document.getElementById('mini-reference');
const miniLive = document.getElementById('mini-live');

// Settings elements (referenced for special handling)
const normalizeLoudness = document.getElementById('normalizeLoudness');
const sampleRate = document.getElementById('sampleRate');
const bitDepth = document.getElementById('bitDepth');
const limiterCharacter = document.getElementById('limiterCharacter');
const referenceMatch = document.getElementById('referenceMatch');
const referenceAmount = document.getElementById('referenceAmount');
const referenceAmountValue = document.getElementById('referenceAmountValue');
const ditherNoiseShaping = document.getElementById('ditherNoiseShaping');
const ditherNoiseShapingRow = document.getElementById('ditherNoiseShapingRow');
const targetLufsSlider = document.getElementById('targetLufs');
const targetLufsValue = document.getElementById('targetLufsValue');
const stereoWidthSlider = document.getElementById('stereoWidth');
const stereoWidthValue = document.getElementById('stereoWidthValue');
const outputLufsDisplay = document.getElementById('outputLufs');
const exportFormatValue = document.getElementById('exportFormatValue');
const exportQualityValue = document.getElementById('exportQualityValue');
const truePeakLimit = document.getElementById('truePeakLimit');
const cleanLowEnd = document.getElementById('cleanLowEnd');
const glueCompression = document.getElementById('glueCompression');
const deharsh = document.getElementById('deharsh');
const aiEnhance = document.getElementById('aiEnhance');
const aiProfile = document.getElementById('aiProfile');
const aiIntensity = document.getElementById('aiIntensity');
const aiIntensityValue = document.getElementById('aiIntensityValue');
const sibilanceProtection = document.getElementById('sibilanceProtection');
const sibilanceProtectionValue = document.getElementById('sibilanceProtectionValue');
const artifactProtection = document.getElementById('artifactProtection');
const artifactProtectionValue = document.getElementById('artifactProtectionValue');
const centerBass = document.getElementById('centerBass');
const cutMud = document.getElementById('cutMud');
const addAir = document.getElementById('addAir');
const tapeWarmth = document.getElementById('tapeWarmth');
const autoLevel = document.getElementById('autoLevel');
const addPunch = document.getElementById('addPunch');
const advancedMode = document.getElementById('advancedMode');
const assistantPresetButtons = document.querySelectorAll('.assistant-preset');
const analysisFocusValue = document.getElementById('analysisFocusValue');
const analysisRiskValue = document.getElementById('analysisRiskValue');
const analysisSafeValue = document.getElementById('analysisSafeValue');
const analysisHeadroomValue = document.getElementById('analysisHeadroomValue');
const analysisToneValue = document.getElementById('analysisToneValue');
const analysisActionValue = document.getElementById('analysisActionValue');
const modeProfileValue = document.getElementById('modeProfileValue');
const modeTargetValue = document.getElementById('modeTargetValue');
const modeInputValue = document.getElementById('modeInputValue');
const modeCeilingValue = document.getElementById('modeCeilingValue');
const modeLimiterValue = document.getElementById('modeLimiterValue');
const modeEqValue = document.getElementById('modeEqValue');
const autoGainBtn = document.getElementById('autoGainBtn');
const resetMasteringBtn = document.getElementById('resetMasteringBtn');
const reanalyzeBtn = document.getElementById('reanalyzeBtn');
const clearSessionBtn = document.getElementById('clearSessionBtn');
const topResetMasteringBtn = document.getElementById('topResetMasteringBtn');
const topReanalyzeBtn = document.getElementById('topReanalyzeBtn');
const topClearBtn = document.getElementById('topClearBtn');
const topNoneBtn = document.getElementById('topNoneBtn');
const levelMatchPanel = document.getElementById('levelMatchPanel');

// Transport display elements
const currentTimeEl = document.getElementById('currentTime');
const durationEl = document.getElementById('duration');
import { spectrogram } from './ui/spectrogram.js';

// ... (existing helper imports)

// ===================================
// Spectrogram Setup
// ===================================
const spectroBtn = document.getElementById('spectroBtn');
const spectrogramContainer = document.getElementById('spectrogramContainer');

if (spectroBtn && spectrogramContainer) {
  spectrogram.mount('spectrogramContainer');

  spectroBtn.addEventListener('click', () => {
    spectrogramContainer.classList.toggle('hidden');
    spectroBtn.classList.toggle('active');

    if (!spectrogramContainer.classList.contains('hidden')) {
      spectrogram.start();
    } else {
      spectrogram.stop();
    }
  });
}

function updateDitherControlState() {
  if (!bitDepth || !ditherNoiseShaping || !ditherNoiseShapingRow) return;

  const is16Bit = (parseInt(bitDepth.value) || 16) === 16;
  ditherNoiseShaping.disabled = !is16Bit;
  ditherNoiseShapingRow.classList.toggle('disabled', !is16Bit);
}

function resetOutputToStreamingDefault() {
  const streaming = outputPresets.streaming || { sampleRate: 'source', bitDepth: 24 };
  sampleRate.value = String(streaming.sampleRate);
  bitDepth.value = String(streaming.bitDepth);
  ditherNoiseShaping.checked = false;
  updateDitherControlState();
  updateOutputPresetButtons(outputPresets);
  updateExportFormatSummary();
  clearExportQualitySummary();
}

function resetTransportPreviewState() {
  playerState.isBypassed = false;
  playerState.isSeeking = false;
  playerState.pauseTime = 0;
  playerState.startTime = 0;
  if (playerState.seekUpdateInterval) {
    clearInterval(playerState.seekUpdateInterval);
    playerState.seekUpdateInterval = null;
  }
  if (playerState.seekTimeout) {
    clearTimeout(playerState.seekTimeout);
    playerState.seekTimeout = null;
  }
  bypassBtn?.classList.remove('active');
  const bypassLabel = bypassBtn?.querySelector('.bypass-label');
  if (bypassLabel) bypassLabel.textContent = 'FX';
  syncLevelMatchControls(true);
}

function resetSpectrogramView() {
  spectrogram.stop();
  spectrogramContainer?.classList.add('hidden');
  spectroBtn?.classList.remove('active');
}

async function cleanupAudioContext() {
  // Stop spectrogram
  spectrogram.stop();
  spectrogram.analyser = null;

  // Destroy WaveSurfer first - it may hold references to AudioContext
  destroyWaveSurfer();

  // Stop any playing audio
  if (playerState.isPlaying) {
    stopAudio();
  }

  // Close existing AudioContext to prevent memory leaks
  if (audioNodes.context && audioNodes.context.state !== 'closed') {
    try {
      await audioNodes.context.close();
    } catch (e) {
      console.error('Failed to close AudioContext:', e);
      // Check if context is in bad state
      if (audioNodes.context.state !== 'closed') {
        showToast('Warning: Audio system may be unstable. Restart recommended.', 'error', 10000);
      }
    }
    // Reset all audio nodes
    Object.keys(audioNodes).forEach(key => {
      audioNodes[key] = null;
    });
  }
}

function initAudioContext() {
  if (!audioNodes.context) {
    audioNodes.context = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioNodes.context;
}

function createAudioChain() {
  const ctx = initAudioContext();

  // Create analysers for visualization (stereo metering)
  audioNodes.analyser = ctx.createAnalyser();
  audioNodes.analyser.fftSize = 2048;

  // Connect spectrogram
  spectrogram.connect(audioNodes.analyser);
  if (!spectrogramContainer.classList.contains('hidden')) {
    spectrogram.start();
  }

  audioNodes.analyserL = ctx.createAnalyser();
  audioNodes.analyserL.fftSize = 2048;
  audioNodes.analyserR = ctx.createAnalyser();
  audioNodes.analyserR.fftSize = 2048;
  audioNodes.meterSplitter = ctx.createChannelSplitter(2);

  // Static connections for stereo metering
  audioNodes.meterSplitter.connect(audioNodes.analyserL, 0);
  audioNodes.meterSplitter.connect(audioNodes.analyserR, 1);

  // Direct path metering (bypass): keep a single up-mix node to avoid leaking nodes on each play
  audioNodes.directMeterUpmix = ctx.createGain();
  audioNodes.directMeterUpmix.gain.value = 1.0;
  audioNodes.directMeterUpmix.channelCount = 2;
  audioNodes.directMeterUpmix.channelCountMode = 'explicit';
  audioNodes.directMeterUpmix.channelInterpretation = 'speakers';
  audioNodes.directMeterUpmix.connect(audioNodes.meterSplitter);

  // Create nodes
  audioNodes.inputGain = ctx.createGain();
  audioNodes.inputGain.gain.value = Math.pow(10, inputGainValue / 20);
  audioNodes.gain = ctx.createGain();
  audioNodes.highpass = ctx.createBiquadFilter();
  audioNodes.lowshelf = ctx.createBiquadFilter();
  audioNodes.highshelf = ctx.createBiquadFilter();
  audioNodes.midPeak = ctx.createBiquadFilter();
  audioNodes.previewBass = ctx.createBiquadFilter();
  audioNodes.previewMud = ctx.createBiquadFilter();
  audioNodes.previewPresence = ctx.createBiquadFilter();
  audioNodes.previewSibilance = ctx.createBiquadFilter();
  audioNodes.previewHarsh = ctx.createBiquadFilter();
  audioNodes.previewMetallic = ctx.createBiquadFilter();
  audioNodes.previewAir = ctx.createBiquadFilter();
  audioNodes.compressor = ctx.createDynamicsCompressor();
  audioNodes.limiter = ctx.createDynamicsCompressor();

  // 5-band EQ nodes
  audioNodes.eqLow = ctx.createBiquadFilter();
  audioNodes.eqLowMid = ctx.createBiquadFilter();
  audioNodes.eqMid = ctx.createBiquadFilter();
  audioNodes.eqHighMid = ctx.createBiquadFilter();
  audioNodes.eqHigh = ctx.createBiquadFilter();

  // Stereo width M/S processing nodes
  // M/S encoding: Mid = (L+R)/2, Side = (L-R)/2
  // Output: L' = Mid + Side*width, R' = Mid - Side*width
  audioNodes.stereoSplitter = ctx.createChannelSplitter(2);
  audioNodes.stereoMerger = ctx.createChannelMerger(2);
  // For left output: midGainL adds mid, sideGainL adds side
  audioNodes.midGainL = ctx.createGain();
  audioNodes.midGainR = ctx.createGain();
  audioNodes.sideGainL = ctx.createGain();
  audioNodes.sideGainR = ctx.createGain();
  // We need additional gains for the M/S matrix
  audioNodes.lToMid = ctx.createGain();
  audioNodes.rToMid = ctx.createGain();
  audioNodes.lToSide = ctx.createGain();
  audioNodes.rToSide = ctx.createGain();
  audioNodes.midToL = ctx.createGain();
  audioNodes.midToR = ctx.createGain();
  audioNodes.sideToL = ctx.createGain();
  audioNodes.sideToR = ctx.createGain();

  // Configure EQ bands
  audioNodes.eqLow.type = 'lowshelf';
  audioNodes.eqLow.frequency.value = 80;

  audioNodes.eqLowMid.type = 'peaking';
  audioNodes.eqLowMid.frequency.value = 250;
  audioNodes.eqLowMid.Q.value = 1;

  audioNodes.eqMid.type = 'peaking';
  audioNodes.eqMid.frequency.value = 1000;
  audioNodes.eqMid.Q.value = 1;

  audioNodes.eqHighMid.type = 'peaking';
  audioNodes.eqHighMid.frequency.value = 4000;
  audioNodes.eqHighMid.Q.value = 1;

  audioNodes.eqHigh.type = 'highshelf';
  audioNodes.eqHigh.frequency.value = 12000;

  // Configure highpass (clean low end)
  audioNodes.highpass.type = 'highpass';
  audioNodes.highpass.frequency.value = 30;
  audioNodes.highpass.Q.value = 0.7;

  // Configure cut mud (250Hz cut)
  audioNodes.lowshelf.type = 'peaking';
  audioNodes.lowshelf.frequency.value = 250;
  audioNodes.lowshelf.Q.value = 1.5;
  audioNodes.lowshelf.gain.value = 0;

  // Configure add air (12kHz boost)
  audioNodes.highshelf.type = 'highshelf';
  audioNodes.highshelf.frequency.value = 12000;
  audioNodes.highshelf.gain.value = 0;

  // Configure tame harshness (4-6kHz cut)
  audioNodes.midPeak.type = 'peaking';
  audioNodes.midPeak.frequency.value = 5000;
  audioNodes.midPeak.Q.value = 2;
  audioNodes.midPeak.gain.value = 0;

  audioNodes.previewBass.type = 'lowshelf';
  audioNodes.previewBass.frequency.value = 95;
  audioNodes.previewBass.gain.value = 0;
  audioNodes.previewMud.type = 'peaking';
  audioNodes.previewMud.frequency.value = 280;
  audioNodes.previewMud.Q.value = 1.1;
  audioNodes.previewMud.gain.value = 0;
  audioNodes.previewPresence.type = 'peaking';
  audioNodes.previewPresence.frequency.value = 3900;
  audioNodes.previewPresence.Q.value = 1.0;
  audioNodes.previewPresence.gain.value = 0;
  audioNodes.previewSibilance.type = 'peaking';
  audioNodes.previewSibilance.frequency.value = 6200;
  audioNodes.previewSibilance.Q.value = 2.3;
  audioNodes.previewSibilance.gain.value = 0;
  audioNodes.previewHarsh.type = 'peaking';
  audioNodes.previewHarsh.frequency.value = 7800;
  audioNodes.previewHarsh.Q.value = 1.6;
  audioNodes.previewHarsh.gain.value = 0;
  audioNodes.previewMetallic.type = 'peaking';
  audioNodes.previewMetallic.frequency.value = 10800;
  audioNodes.previewMetallic.Q.value = 3.2;
  audioNodes.previewMetallic.gain.value = 0;
  audioNodes.previewAir.type = 'highshelf';
  audioNodes.previewAir.frequency.value = 12500;
  audioNodes.previewAir.gain.value = 0;

  // Configure glue compressor
  audioNodes.compressor.threshold.value = -18;
  audioNodes.compressor.knee.value = 10;
  audioNodes.compressor.ratio.value = 3;
  audioNodes.compressor.attack.value = 0.02;
  audioNodes.compressor.release.value = 0.25;

  // Configure limiter
  audioNodes.limiter.threshold.value = -1;
  audioNodes.limiter.knee.value = 0;
  // DynamicsCompressorNode.ratio nominal range is [1, 20].
  // Use 20 for the strongest "brickwall-ish" behavior without browser clamping/warnings.
  audioNodes.limiter.ratio.value = 20;
  audioNodes.limiter.attack.value = 0.001; // Fast attack to catch peaks
  audioNodes.limiter.release.value = 0.05;

  // ============================================================================
  // Static audio graph wiring (connect once)
  //
  // We only connect sources to either:
  // - analyser (direct/bypass), or
  // - inputGain (FX chain)
  //
  // This prevents duplicate connections when play/seek restarts.
  // ============================================================================

  // FX chain: inputGain -> filters -> EQ -> comp -> stereo width -> limiter
  audioNodes.inputGain
    .connect(audioNodes.highpass)
    .connect(audioNodes.eqLow)
    .connect(audioNodes.eqLowMid)
    .connect(audioNodes.eqMid)
    .connect(audioNodes.eqHighMid)
    .connect(audioNodes.eqHigh)
    .connect(audioNodes.lowshelf)
    .connect(audioNodes.midPeak)
    .connect(audioNodes.highshelf)
    .connect(audioNodes.previewBass)
    .connect(audioNodes.previewMud)
    .connect(audioNodes.previewPresence)
    .connect(audioNodes.previewSibilance)
    .connect(audioNodes.previewHarsh)
    .connect(audioNodes.previewMetallic)
    .connect(audioNodes.previewAir)
    .connect(audioNodes.compressor)
    .connect(audioNodes.stereoSplitter);

  // M/S Stereo Width Processing
  audioNodes.stereoSplitter.connect(audioNodes.lToMid, 0);
  audioNodes.stereoSplitter.connect(audioNodes.lToSide, 0);
  audioNodes.stereoSplitter.connect(audioNodes.rToMid, 1);
  audioNodes.stereoSplitter.connect(audioNodes.rToSide, 1);

  audioNodes.lToMid.connect(audioNodes.stereoMerger, 0, 0);
  audioNodes.rToMid.connect(audioNodes.stereoMerger, 0, 0);
  audioNodes.lToSide.connect(audioNodes.stereoMerger, 0, 1);
  audioNodes.rToSide.connect(audioNodes.stereoMerger, 0, 1);

  audioNodes.stereoMerger.connect(audioNodes.limiter);

  // Metering: limiter always feeds the meter splitter (direct path feeds it via directMeterUpmix)
  audioNodes.limiter.connect(audioNodes.meterSplitter);

  // Output + spectrogram: analyser feeds output; limiter feeds analyser (FX on), direct source feeds analyser (bypass)
  audioNodes.limiter.connect(audioNodes.analyser);
  audioNodes.analyser.connect(audioNodes.gain);
  audioNodes.gain.connect(ctx.destination);

  // Apply current UI fader state to the newly created nodes (especially input gain)
  updateInputGain();
  updateAudioChain();
  updateStereoWidth();
  updateEQ();
}

/**
 * Set up audio buffer for real-time preview playback
 *
 * ARCHITECTURE NOTE:
 * - Effects (denoise, exciter, saturation, transient) are NOT applied here
 * - They are applied in the unified offline chain (renderOffline / updateOutputLufs)
 * - Real-time preview uses normalizedBuffer through simplified Web Audio chain
 * - This ensures export LUFS display matches actual export output
 */
async function processEffects() {
  if (!fileState.originalBuffer) return;

  // Set fallback buffer for immediate UI access
  // This will be replaced by cached buffer when render completes
  audioNodes.buffer = fileState.normalizedBuffer || fileState.originalBuffer;

  // Trigger cached buffer render (debounced)
  // This renders the FULL DSP chain once, then:
  // - Preview plays from cached buffer
  // - LUFS meter reads from cached buffer
  // - Export uses cached buffer
  schedulePreviewUpdate();

  console.log('[Preview] Scheduled cache render with full DSP chain');
}

/**
 * Update the output LUFS display
 *
 * Reads from the cached render buffer LUFS value.
 * The actual rendering happens in scheduleRenderToCache().
 * This function just displays the cached value.
 */
function updateOutputLufs() {
  if (fileState.cachedRenderLufs !== null) {
    updateLufsDisplay(fileState.cachedRenderLufs, false);
  } else if (fileState.isRenderingCache) {
    updateLufsDisplay(null, true);
  } else if (!fileState.originalBuffer) {
    updateLufsDisplay(null, false);
  } else {
    // No cache yet, trigger render
    scheduleRenderToCache();
  }
}

function applyLiveChainParams() {
  if (audioNodes.gain) {
    let outputGain = 1;
    if (
      fileState.forceLivePreview &&
      normalizeLoudness.checked &&
      Number.isFinite(fileState.normalizedTargetLufs)
    ) {
      const targetDelta = parseFloat(targetLufsSlider.value) - fileState.normalizedTargetLufs;
      outputGain = Math.pow(10, Math.max(-6, Math.min(6, targetDelta)) / 20);
    }
    audioNodes.gain.gain.setTargetAtTime(outputGain, audioNodes.context.currentTime, 0.015);
  }

  // Highpass (clean low end)
  audioNodes.highpass.frequency.value = (cleanLowEnd.checked && !playerState.isBypassed) ? 30 : 1;

  // Cut Mud
  audioNodes.lowshelf.gain.value = (cutMud.checked && !playerState.isBypassed) ? -3 : 0;

  // Add Air (Exciter) - applied offline via processEffects()
  // highshelf disabled - exciter processing is baked into cachedRenderBuffer
  audioNodes.highshelf.gain.value = 0;

  // midPeak filter (unused - harshness taming now handled by deharsh dynamic processor)
  audioNodes.midPeak.gain.value = 0;

  applyPreviewApproximation();

  // Glue Compression
  const artifactSafeMode = /\.(mp3|aac|m4a|mp4|ogg|wma|amr)$/i.test(currentFile?.name || '') ||
    Number(artifactProtection?.value || 0) >= 78 ||
    Number(sibilanceProtection?.value || 0) >= 75;
  if (glueCompression.checked && !playerState.isBypassed && !artifactSafeMode) {
    audioNodes.compressor.threshold.value = -14;
    audioNodes.compressor.knee.value = 24;
    audioNodes.compressor.ratio.value = 1.45;
    audioNodes.compressor.attack.value = 0.03;
    audioNodes.compressor.release.value = 0.22;
  } else {
    audioNodes.compressor.threshold.value = 0;
    audioNodes.compressor.knee.value = 0;
    audioNodes.compressor.ratio.value = 1;
  }

  // Limiter
  if (truePeakLimit.checked && !playerState.isBypassed && !artifactSafeMode) {
    audioNodes.limiter.threshold.value = ceilingValueDb;
    audioNodes.limiter.knee.value = 6;
    audioNodes.limiter.ratio.value = 12;
    audioNodes.limiter.attack.value = 0.003;
    audioNodes.limiter.release.value = 0.12;
  } else {
    audioNodes.limiter.threshold.value = 0;
    audioNodes.limiter.knee.value = 0;
    audioNodes.limiter.ratio.value = 1;
  }
}

function applyPreviewApproximation() {
  const previewNodes = [
    audioNodes.previewBass,
    audioNodes.previewMud,
    audioNodes.previewPresence,
    audioNodes.previewSibilance,
    audioNodes.previewHarsh,
    audioNodes.previewMetallic,
    audioNodes.previewAir
  ];

  if (!previewNodes.every(Boolean)) return;

  const reset = () => {
    previewNodes.forEach(node => {
      node.gain.value = 0;
    });
  };

  if (!fileState.forceLivePreview || playerState.isBypassed || !fileState.originalBuffer) {
    reset();
    return;
  }

  try {
    const settings = getCurrentSettings();
    const transparentSafeMode = settings.isLossySource ||
      (settings.artifactProtection ?? 0) >= 0.78 ||
      (settings.sibilanceProtection ?? 0) >= 0.75;
    if (transparentSafeMode) {
      reset();
      return;
    }
    const analysis = fileState.aiAnalysis || analyzeAIGeneratedMastering(fileState.originalBuffer);
    fileState.aiAnalysis = analysis;
    const profile = chooseAIMasteringProfile(analysis, settings.aiProfile || 'auto');
    const moves = getAIGeneratedMasteringMoves(
      analysis,
      Math.max(0.25, Math.min(1.75, (profile.repairStrength ?? 1) * (settings.aiIntensity ?? 1))),
      profile,
      {
        sibilanceProtection: settings.sibilanceProtection ?? 0.6,
        artifactProtection: settings.artifactProtection ?? 0.7,
        isLossySource: settings.isLossySource
      }
    );

    const previewScale = 0.55;
    audioNodes.previewBass.gain.value = moves.bassLift * previewScale;
    audioNodes.previewMud.gain.value = moves.mudCut * previewScale;
    if (transparentSafeMode) {
      audioNodes.previewPresence.gain.value = 0;
      audioNodes.previewSibilance.gain.value = 0;
      audioNodes.previewHarsh.gain.value = 0;
      audioNodes.previewMetallic.gain.value = 0;
      audioNodes.previewAir.gain.value = Math.max(-2, Math.min(0, moves.airShelf + moves.sibilanceCut * 0.18 + moves.metallicCut * 0.16)) * previewScale;
    } else {
      audioNodes.previewPresence.gain.value = moves.presenceCut * previewScale;
      audioNodes.previewSibilance.gain.value = moves.sibilanceCut * previewScale;
      audioNodes.previewHarsh.gain.value = moves.harshCut * previewScale;
      audioNodes.previewMetallic.gain.value = moves.metallicCut * previewScale;
      audioNodes.previewAir.gain.value = moves.airShelf * previewScale;
    }

    if (settings.referenceMatch && settings.referenceAnalysis) {
      const refSource = analysis.profile;
      const refTarget = settings.referenceAnalysis.profile;
      const amount = Math.max(0, Math.min(1, settings.referenceAmount ?? 0.65)) * 0.45;
      audioNodes.previewBass.gain.value += Math.max(-0.8, Math.min(0.8, (refTarget.subToBassDB - refSource.subToBassDB) * -0.18 * amount));
      audioNodes.previewMud.gain.value += Math.max(-1.2, Math.min(0.8, (refTarget.mudDB - refSource.mudDB) * 0.32 * amount));
      audioNodes.previewPresence.gain.value += Math.max(-1, Math.min(0.8, (refTarget.presenceToBodyDB - refSource.presenceToBodyDB) * 0.28 * amount));
      audioNodes.previewHarsh.gain.value += Math.max(-1.2, Math.min(0.4, (refTarget.harshDB - refSource.harshDB) * 0.24 * amount));
      audioNodes.previewAir.gain.value += Math.max(-0.9, Math.min(0.9, (refTarget.airDB - refSource.airDB) * 0.22 * amount));
    }
  } catch (err) {
    console.warn('[Preview] Failed to apply live approximation:', err);
    reset();
  }
}

function updateAudioChain({ scheduleCache = true, immediate = false, delayMs = undefined } = {}) {
  if (!audioNodes.context || !audioNodes.highpass) return;

  applyLiveChainParams();
  if (!playerState.isBypassed && fileState.originalBuffer) {
    updateLiveWaveformPreview({ immediate, delayMs: Math.min(delayMs ?? 120, 120) });
  }

  // Trigger cache render when settings change (not when merely toggling bypass)
  // This ensures preview/meter/export all use the same rendered buffer.
  if (scheduleCache && fileState.originalBuffer) {
    scheduleRenderToCache({ immediate, delayMs });
  }
}

function updateStereoWidth() {
  if (!audioNodes.stereoSplitter) return;

  const width = playerState.isBypassed ? 1.0 : parseInt(stereoWidthSlider.value) / 100;

  // M/S Matrix coefficients
  // Mid = (L + R) * 0.5
  // Side = (L - R) * 0.5
  // L' = Mid + Side * width = L*0.5 + R*0.5 + (L*0.5 - R*0.5)*width
  //    = L*(0.5 + 0.5*width) + R*(0.5 - 0.5*width)
  // R' = Mid - Side * width = L*0.5 + R*0.5 - (L*0.5 - R*0.5)*width
  //    = L*(0.5 - 0.5*width) + R*(0.5 + 0.5*width)

  const midCoef = 0.5;
  const sideCoef = 0.5 * width;

  // L' = L*(midCoef + sideCoef) + R*(midCoef - sideCoef)
  // R' = L*(midCoef - sideCoef) + R*(midCoef + sideCoef)
  audioNodes.lToMid.gain.value = midCoef + sideCoef;  // L contribution to L'
  audioNodes.rToMid.gain.value = midCoef - sideCoef;  // R contribution to L'
  audioNodes.lToSide.gain.value = midCoef - sideCoef; // L contribution to R'
  audioNodes.rToSide.gain.value = midCoef + sideCoef; // R contribution to R'
}

function connectAudioChain(source) {
  // Static graph is wired in createAudioChain().
  // Here we only connect the source to the FX chain input.
  source.connect(audioNodes.inputGain);
}

/**
 * Connect source directly to output (bypassing effects chain)
 * Used for FX bypass (original / level-matched preview)
 */
function connectDirectToOutput(source) {
  // Static graph is wired in createAudioChain().
  // Direct path: source -> analyser -> gain -> destination
  source.connect(audioNodes.analyser);

  // Metering path: up-mix to 2ch so meters don't freeze on mono sources
  if (audioNodes.directMeterUpmix) {
    source.connect(audioNodes.directMeterUpmix);
  }
}

function isCurrentArtifactSafeSource() {
  return /\.(mp3|aac|m4a|mp4|ogg|wma|amr)$/i.test(currentFile?.name || '') ||
    Number(artifactProtection?.value || 0) >= 78 ||
    Number(sibilanceProtection?.value || 0) >= 75;
}

function getBypassPlaybackBuffer() {
  const levelMatch = document.getElementById('levelMatchBtn')?.checked;
  return levelMatch
    ? fileState.normalizedBuffer || fileState.originalBuffer
    : fileState.originalBuffer;
}

function getActivePlaybackBuffer() {
  if (playerState.isBypassed) {
    return getBypassPlaybackBuffer();
  }

  if (isCurrentArtifactSafeSource()) {
    return fileState.cachedRenderBuffer || null;
  }

  if (fileState.forceLivePreview) {
    return fileState.normalizedBuffer || fileState.originalBuffer || audioNodes.buffer;
  }

  return fileState.cachedRenderBuffer || fileState.normalizedBuffer || audioNodes.buffer || fileState.originalBuffer;
}

function getTimelineBuffer() {
  return getActivePlaybackBuffer() || audioNodes.buffer || fileState.normalizedBuffer || fileState.originalBuffer;
}

function clampPlaybackTime(time, buffer = getTimelineBuffer()) {
  const duration = Number(buffer?.duration) || 0;
  if (!duration) return Math.max(0, Number(time) || 0);
  return Math.max(0, Math.min(Number(time) || 0, Math.max(0, duration - 0.001)));
}

function syncTimelineDuration(buffer = getTimelineBuffer()) {
  if (!buffer) return;
  seekBar.max = buffer.duration;
  durationEl.textContent = formatTime(buffer.duration);
  playerState.pauseTime = clampPlaybackTime(playerState.pauseTime, buffer);
  seekBar.value = playerState.pauseTime;
  updateWaveSurferProgress(playerState.pauseTime, buffer.duration);
}

function switchToLivePreview() {
  if (!playerState.isPlaying || playerState.isBypassed || !audioNodes.context || !fileState.originalBuffer) {
    return;
  }

  if (isCurrentArtifactSafeSource()) {
    return;
  }

  if (fileState.forceLivePreview) {
    applyLiveChainParams();
    updateStereoWidth();
    updateEQ();
    return;
  }

  const liveBuffer = fileState.normalizedBuffer || fileState.originalBuffer;
  const currentTime = getPlaybackPosition();
  playerState.pauseTime = Math.max(0, Math.min(currentTime, liveBuffer.duration - 0.001));
  fileState.forceLivePreview = true;
  applyLiveChainParams();
  updateStereoWidth();
  updateEQ();
  playAudio();
}

function updateEQ() {
  if (!audioNodes.eqLow) return;

  if (playerState.isBypassed) {
    audioNodes.eqLow.gain.value = 0;
    audioNodes.eqLowMid.gain.value = 0;
    audioNodes.eqMid.gain.value = 0;
    audioNodes.eqHighMid.gain.value = 0;
    audioNodes.eqHigh.gain.value = 0;
  } else {
    audioNodes.eqLow.gain.value = eqValues.low;
    audioNodes.eqLowMid.gain.value = eqValues.lowMid;
    audioNodes.eqMid.gain.value = eqValues.mid;
    audioNodes.eqHighMid.gain.value = eqValues.highMid;
    audioNodes.eqHigh.gain.value = eqValues.high;
  }
}

function updateInputGain() {
  if (!audioNodes.inputGain) return;
  const linear = Math.pow(10, inputGainValue / 20);
  audioNodes.inputGain.gain.setValueAtTime(linear, audioNodes.context?.currentTime || 0);
}

function showProcessedWaveform(buffer) {
  if (!buffer || fileState.waveformMode === 'processed') return;
  updateWaveformBuffer(buffer);
  fileState.waveformMode = 'processed';
}

function showSourceWaveform() {
  if (fileState.waveformMode === 'original') return;
  showOriginalWaveform();
  fileState.waveformMode = 'original';
}

function getLivePreviewWaveformGain() {
  let gainDB = inputGainValue;

  if (
    normalizeLoudness.checked &&
    Number.isFinite(fileState.normalizedTargetLufs)
  ) {
    gainDB += parseFloat(targetLufsSlider.value) - fileState.normalizedTargetLufs;
  }

  if (truePeakLimit.checked) {
    gainDB = Math.min(gainDB, Math.max(0, ceilingValueDb + 1));
  }

  return Math.pow(10, Math.max(-12, Math.min(12, gainDB)) / 20);
}

function updateLiveWaveformPreview(options = {}) {
  if (!fileState.originalBuffer || playerState.isBypassed) return;

  const render = () => {
    const buffer = fileState.normalizedBuffer || fileState.originalBuffer;
    updateWaveformPeaks(buffer, {
      gain: getLivePreviewWaveformGain()
    });
    fileState.waveformMode = 'live';
  };

  if (options.immediate) {
    if (liveWaveformTimeout) {
      clearTimeout(liveWaveformTimeout);
      liveWaveformTimeout = null;
    }
    render();
    return;
  }

  if (liveWaveformTimeout) clearTimeout(liveWaveformTimeout);
  liveWaveformTimeout = setTimeout(() => {
    liveWaveformTimeout = null;
    render();
  }, options.delayMs ?? 80);
}

// Fader initialization moved to ./ui/controls.js
// Use initFaders() with callbacks from the imported module

// Offline render/encoding (renderOffline, renderToAudioBuffer, encodeWAVAsync)
// live in ./ui/renderer.js and ./ui/encoder.js

// Debounce timer for cache render
let cacheRenderTimeout = null;
let cacheRenderQueued = false;
let cacheRenderQueuedImmediate = false;
let liveWaveformTimeout = null;
const CACHE_RENDER_DEBOUNCE_MS = 500;
const LIVE_PREVIEW_RENDER_DEBOUNCE_MS = 300;

// getCurrentSettings imported from ./ui/controls.js

/**
 * Schedule a render to the cache buffer (debounced)
 * This is called whenever settings change
 */
function scheduleRenderToCache(options = {}) {
  const {
    immediate = false,
    delayMs = immediate ? 0 : CACHE_RENDER_DEBOUNCE_MS
  } = options;

  clearExportQualitySummary();

  // Clear any pending render
  if (cacheRenderTimeout) {
    clearTimeout(cacheRenderTimeout);
  }

  // Increment version to invalidate any in-progress render
  fileState.cacheRenderVersion++;
  const thisVersion = fileState.cacheRenderVersion;

  // Show "rendering..." indicator
  if (outputLufsDisplay) {
    outputLufsDisplay.textContent = '... LUFS';
  }
  updateChecklist();

  // Debounce the actual render
  cacheRenderTimeout = setTimeout(async () => {
    cacheRenderTimeout = null;
    if (!fileState.originalBuffer) return;
    if (fileState.isRenderingCache) {
      // Already rendering; remember to run one more pass when it completes.
      cacheRenderQueued = true;
      cacheRenderQueuedImmediate = cacheRenderQueuedImmediate || immediate;
      return;
    }

    cacheRenderQueued = false;
    cacheRenderQueuedImmediate = false;
    fileState.isRenderingCache = true;
    console.log('[Cache] Starting render, version:', thisVersion);

    try {
      const settings = getCurrentSettings();

      // Try to use DSP worker for off-main-thread processing
      const dspWorker = getDSPWorker();
      let buffer, lufs;

      if (dspWorker && dspWorker.isReady) {
        try {
          // Use worker - doesn't freeze UI
          console.log('[Cache] Using DSP worker for render');
          // Use ORIGINAL buffer as input - normalization happens once at the END of the chain
          // Using normalized buffer causes double-normalization which crushes dynamics
          const inputBuffer = fileState.originalBuffer;
          const result = await dspWorker.renderFullChain(
            inputBuffer,
            settings,
            // Build a master-preview buffer that matches export (includes final limiter).
            'export',
            (progress, status) => {
              // Show progress in LUFS display
              const percent = Math.round(progress * 100);
              if (outputLufsDisplay && progress < 1) {
                outputLufsDisplay.textContent = `${percent}%`;
              }
            }
          );
          buffer = result.audioBuffer;
          lufs = result.lufs;
        } catch (workerErr) {
          // Worker can fail in some environments; fall back to main thread so FX preview still works.
          console.warn('[Cache] Worker render failed, falling back to main thread render:', workerErr);
          const result = await renderToAudioBuffer(fileState.originalBuffer, settings, 'export');
          buffer = result.buffer;
          lufs = result.lufs;
        }
      } else {
        // Fallback to main thread rendering
        console.log('[Cache] Falling back to main thread render');
        const result = await renderToAudioBuffer(fileState.originalBuffer, settings, 'export');
        buffer = result.buffer;
        lufs = result.lufs;
      }

      // Only update cache if this is still the latest version
      if (thisVersion === fileState.cacheRenderVersion) {
        fileState.cachedRenderBuffer = buffer;
        fileState.cachedRenderLufs = lufs;
        fileState.forceLivePreview = false;
        applyLiveChainParams();
        if (!playerState.isBypassed) {
          fileState.waveformMode = 'original';
          showProcessedWaveform(buffer);
        }
        seekBar.max = buffer.duration;
        durationEl.textContent = formatTime(buffer.duration);
        if (!playerState.isPlaying) {
          syncTimelineDuration(buffer);
        }

        // Update LUFS display
        if (outputLufsDisplay) {
          outputLufsDisplay.textContent = `${lufs.toFixed(1)} LUFS`;
        }

        // Update the playback buffer if not currently playing
        if (!playerState.isPlaying) {
          audioNodes.buffer = buffer;
        }

        // Enable playback now that cache is ready
        playBtn.disabled = false;
        stopBtn.disabled = false;

        console.log('[Cache] Render complete, version:', thisVersion, 'LUFS:', lufs.toFixed(1));
        updateChecklist();

        // If we're actively previewing FX, hot-swap to the new master-preview buffer.
        // This keeps meters/audio in sync with the full chain (including final limiter)
        // after any setting change.
        if (playerState.isPlaying && !playerState.isBypassed && audioNodes.context) {
          const currentTime = audioNodes.context.currentTime - playerState.startTime;
          playerState.pauseTime = clampPlaybackTime(currentTime, buffer);
          playAudio();
        }
      } else {
        console.log('[Cache] Render discarded (outdated version:', thisVersion, 'current:', fileState.cacheRenderVersion, ')');
      }
    } catch (err) {
      console.error('[Cache] Render error:', err);
      if (outputLufsDisplay) {
        outputLufsDisplay.textContent = '-- LUFS';
      }
      // Still enable playback on error so user isn't stuck
      playBtn.disabled = false;
      stopBtn.disabled = false;
      updateChecklist();
    } finally {
      fileState.isRenderingCache = false;
      updateChecklist();
      if (cacheRenderQueued && fileState.originalBuffer) {
        const runQueuedImmediately = cacheRenderQueuedImmediate;
        cacheRenderQueued = false;
        cacheRenderQueuedImmediate = false;
        scheduleRenderToCache({ immediate: runQueuedImmediately });
      }
    }
  }, delayMs);
}

function schedulePreviewUpdate(options = {}) {
  if (playerState.isPlaying && !playerState.isBypassed && options.liveNow !== false) {
    switchToLivePreview();
  } else if (fileState.forceLivePreview) {
    applyLiveChainParams();
    updateStereoWidth();
    updateEQ();
  }

  if (!playerState.isBypassed && fileState.originalBuffer) {
    updateLiveWaveformPreview({
      immediate: options.immediate,
      delayMs: Math.min(options.delayMs ?? LIVE_PREVIEW_RENDER_DEBOUNCE_MS, 120)
    });
  }

  scheduleRenderToCache({
    immediate: playerState.isPlaying && !playerState.isBypassed,
    ...options
  });
}

function getPlaybackPosition() {
  if (!audioNodes.context || !playerState.isPlaying) return playerState.pauseTime;
  return audioNodes.context.currentTime - playerState.startTime;
}

// ============================================================================
// Level Meter (wrappers for ./ui/meters.js)
// ============================================================================

/**
 * Start level meter with current audio context
 */
function startMeterAnimation() {
  startMeter(audioNodes.analyserL, audioNodes.analyserR, () => playerState.isPlaying);
}

/**
 * Stop level meter animation
 */
function stopMeterAnimation() {
  stopMeter();
}

// WaveSurfer functions (initWaveSurfer, updateWaveSurferProgress, etc.)
// moved to ./ui/waveform.js

// ============================================================================
// EQ Preset Event Listeners - setup moved to initialization via setupEQPresets()
// ============================================================================

// ============================================================================
// Audio File Loading
// ============================================================================

// Loading modal elements
const loadingModal = document.getElementById('loadingModal');
const loadingText = document.getElementById('loadingText');
const loadingProgressBar = document.getElementById('loadingProgressBar');
const loadingPercent = document.getElementById('loadingPercent');
const modalCancelBtn = document.getElementById('modalCancelBtn');

function showLoadingModal(text, percent, showCancel = false) {
  const numericPercent = Number(percent);
  const clamped = Number.isFinite(numericPercent) ? Math.max(0, Math.min(100, numericPercent)) : 0;
  const displayPercent = Math.round(clamped);

  console.log('[Modal] Show:', text, `${displayPercent}%`);
  loadingModal.classList.remove('hidden');
  loadingText.textContent = text;
  loadingProgressBar.style.width = `${displayPercent}%`;
  loadingPercent.textContent = `${displayPercent}%`;
  modalCancelBtn.classList.toggle('hidden', !showCancel);
}

function hideLoadingModal() {
  console.log('[Modal] Hide');
  loadingModal.classList.add('hidden');
  modalCancelBtn.classList.add('hidden');
}

// Consolidated cancel handler to prevent race conditions
async function cancelProcessing() {
  if (!isProcessing || processingCancelled) return;

  processingCancelled = true;
  // Disable buttons to prevent multiple cancel clicks
  modalCancelBtn.disabled = true;
  cancelBtn.disabled = true;
  showLoadingModal('Cancelling...', 0, false);

  // Wait for processing to actually complete before allowing new operations
  if (processingPromise) {
    try {
      await processingPromise;
    } catch (e) {
      // Ignore cancellation error - expected
    }
  }
}

modalCancelBtn.addEventListener('click', cancelProcessing);

async function loadReferenceFile(file) {
  const ctx = initAudioContext();
  showLoadingModal('Analyzing reference...', 10);

  try {
    const arrayBuffer = await file.arrayBuffer();
    showLoadingModal('Decoding reference...', 35);
    const decodedBuffer = await ctx.decodeAudioData(arrayBuffer);

    showLoadingModal('Measuring reference...', 70);
    const analysis = analyzeAIGeneratedMastering(decodedBuffer);
    analysis.lufs = measureLUFS(decodedBuffer);
    analysis.truePeak = findTruePeak(decodedBuffer);
    analysis.sampleRate = decodedBuffer.sampleRate;

    setReferenceAnalysis(analysis);
    referenceMatch.checked = true;
    referenceName.textContent = file.name;
    applyAssistantPreset('reference');
    showToast(`Reference loaded: ${file.name}`, 'success', 3000);
  } catch (error) {
    console.error('Reference analysis failed:', error);
    setReferenceAnalysis(null);
    referenceMatch.checked = false;
    referenceName.textContent = 'No reference';
    showToast(`Reference failed: ${error.message}`, 'error');
    updateChecklist();
  } finally {
    hideLoadingModal();
  }
}

async function loadAudioFile(file) {
  const ctx = initAudioContext();

  showLoadingModal('Loading audio...', 5);

  try {
    // Read file data from browser File object
    const arrayBuffer = await file.arrayBuffer();

    // Create blob from original file data immediately (for WaveSurfer)
    const originalBlob = new Blob([arrayBuffer], { type: file.type || 'audio/mpeg' });

    showLoadingModal('Decoding audio...', 20);

    // Decode audio using browser's native decoder (supports MP3, WAV, FLAC, AAC, M4A, MP4)
    let decodedBuffer;
    try {
      decodedBuffer = await ctx.decodeAudioData(arrayBuffer);
    } catch (decodeError) {
      throw new Error(`Cannot decode audio file. Format may be unsupported or file is corrupted.`);
    }

    // Detect and remove DC offset
    showLoadingModal('Checking DC offset...', 25);
    const dcInfo = detectDCOffsetBuffer(decodedBuffer);
    const dcSeverity = getDCOffsetSeverity(dcInfo.average.percent);

    if (dcInfo.significant) {
      console.log(`[DC Offset] Detected: ${dcInfo.average.percent.toFixed(4)}% (${dcSeverity})`);
      // Remove DC offset from the buffer
      for (let ch = 0; ch < decodedBuffer.numberOfChannels; ch++) {
        const channelData = decodedBuffer.getChannelData(ch);
        removeDCOffset(channelData);
      }
      fileState.dcOffset = {
        percent: dcInfo.average.percent,
        severity: dcSeverity,
        removed: true
      };
      console.log('[DC Offset] Removed');
    } else {
      fileState.dcOffset = {
        percent: dcInfo.average.percent,
        severity: dcSeverity,
        removed: false
      };
    }

    fileState.originalBuffer = decodedBuffer;

    if (cacheRenderTimeout) {
      clearTimeout(cacheRenderTimeout);
      cacheRenderTimeout = null;
    }
    if (liveWaveformTimeout) {
      clearTimeout(liveWaveformTimeout);
      liveWaveformTimeout = null;
    }
    cacheRenderQueued = false;
    cacheRenderQueuedImmediate = false;

    // Reset all derived buffers so a new upload cannot reuse stale mastering state.
    fileState.normalizedBuffer = null;
    fileState.normalizedTargetLufs = null;
    fileState.processedBuffer = null;
    fileState.cachedRenderBuffer = null;
    fileState.cachedRenderLufs = null;
    fileState.forceLivePreview = false;
    fileState.isRenderingCache = false;
    fileState.isProcessingEffects = false;
    fileState.aiAnalysis = null;
    fileState.estimatedBitrateKbps = null;
    fileState.aiAutoRecommendation = null;
    fileState.waveformMode = 'original';
    fileState.cacheRenderVersion++;
    clearExportQualitySummary();

    // Show measuring phase with intermediate progress updates
    showLoadingModal('Measuring loudness...', 35);

    // Small delay to allow UI to update before CPU-intensive LUFS measurement
    await new Promise(resolve => setTimeout(resolve, 10));

    showLoadingModal('Analyzing audio levels...', 50);

    // Measure original LUFS and true peak BEFORE normalization
    const originalLufs = measureLUFS(decodedBuffer);
    const originalTruePeak = findTruePeak(decodedBuffer);
    fileState.originalLufs = originalLufs;
    fileState.originalTruePeak = originalTruePeak;
    fileState.originalSampleRate = decodedBuffer.sampleRate;
    fileState.estimatedBitrateKbps = Math.round((file.size * 8) / (decodedBuffer.duration * 1000));
    fileState.aiAnalysis = analyzeAIGeneratedMastering(decodedBuffer);
    resetOutputToStreamingDefault();
    updateExportFormatSummary();
    setAssistantPresetActive('ai-auto');
    clearReferenceState();
    applyAIAutoRecommendation(fileState.aiAnalysis, {
      bitrateKbps: fileState.estimatedBitrateKbps,
      isLossy: /\.(mp3|aac|m4a|mp4|ogg|wma|amr)$/i.test(file.name)
    }, { force: true });

    const isLossySource = /\.(mp3|aac|m4a|mp4|ogg|wma|amr)$/i.test(file.name);
    const requestedTarget = Number.parseFloat(targetLufsSlider.value);
    const rescuePreviewMode = Number(artifactProtection?.value || 0) >= 85;
    const normalizedTarget = isLossySource
      ? Math.min(Number.isFinite(requestedTarget) ? requestedTarget : targetLufsDb, rescuePreviewMode ? -14 : -14.5)
      : (Number.isFinite(requestedTarget) ? requestedTarget : targetLufsDb);
    let normalizedBuffer;
    if (isLossySource) {
      const desiredGainDB = Number.isFinite(originalLufs) ? normalizedTarget - originalLufs : 0;
      const peakSafeGainDB = -1.8 - originalTruePeak;
      normalizedBuffer = applyGain(decodedBuffer, Math.min(desiredGainDB, peakSafeGainDB));
    } else {
      // Normalize to target LUFS using pure JavaScript
      normalizedBuffer = normalizeToLUFS(decodedBuffer, normalizedTarget);
    }

    showLoadingModal('Applying normalization...', 70);

    // Small delay for UI feedback
    await new Promise(resolve => setTimeout(resolve, 10));

    showLoadingModal('Preparing audio...', 85);

    // Store normalized buffer
    fileState.normalizedBuffer = normalizedBuffer;
    fileState.normalizedTargetLufs = normalizedTarget;

    // Apply effects (denoise, exciter) if enabled
    await processEffects();

    createAudioChain();

    // Update duration display
    const duration = audioNodes.buffer.duration;
    durationEl.textContent = formatTime(duration);
    seekBar.max = duration;

    // Initialize waveform display with original file blob
    initWaveSurfer(audioNodes.buffer, originalBlob, {
      onSeek: (time) => {
        const safeTime = clampPlaybackTime(time);
        seekBar.value = safeTime;
        currentTimeEl.textContent = formatTime(safeTime);
        seekTo(safeTime);
      },
      getBuffer: () => getTimelineBuffer()
    });

    // Keep play button disabled until cache render completes
    // processBtn can be enabled now
    processBtn.disabled = false;

    // Show live indicators
    document.body.classList.add('audio-loaded');

    // Cache render now runs in the background; loading flow is complete here.
    hideLoadingModal();

    return true;
  } catch (error) {
    console.error('Error loading audio:', error);
    hideLoadingModal();
    showToast(`Error: ${error.message}`, 'error');
    return false;
  }
}

// ============================================================================
// Audio Playback
// ============================================================================

function playAudio() {
  if (!audioNodes.context) return;

  // Choose playback buffer based on bypass state:
  // - Bypassed (FX OFF): Use original/normalized buffer (unprocessed)
  // - Not bypassed (FX ON): Use cached processed buffer if available
  let playbackBuffer;
  let useDirectOutput = false;

  if (playerState.isBypassed) {
    // Bypass: check Level Match setting
    playbackBuffer = getBypassPlaybackBuffer();
    if (document.getElementById('levelMatchBtn')?.checked) {
      console.log('[Playback] Bypass ON (Level Matched) - using normalizedBuffer');
    } else {
      console.log('[Playback] Bypass ON (True Bypass) - using originalBuffer');
    }

    useDirectOutput = true; // Skip effects chain entirely
  } else {
    if (isCurrentArtifactSafeSource()) {
      if (!fileState.cachedRenderBuffer) {
        playBtn.disabled = true;
        scheduleRenderToCache({ immediate: true });
        showToast('피아노 보호 렌더를 준비하는 중입니다. 잠시 후 다시 재생해 주세요.', '', 2500);
        return;
      }
      playbackBuffer = fileState.cachedRenderBuffer;
      useDirectOutput = true;
      console.log('[Playback] FX ON - artifact-safe direct preview');
    } else if (fileState.forceLivePreview) {
      // FX ON: use the live chain immediately while a new rendered preview is catching up.
      playbackBuffer = fileState.normalizedBuffer || fileState.originalBuffer || audioNodes.buffer;
      useDirectOutput = false;
      console.log('[Playback] FX ON - live preview while cache renders');
    } else if (fileState.cachedRenderBuffer) {
      playbackBuffer = fileState.cachedRenderBuffer;
      useDirectOutput = true; // Cached buffer is full chain (includes final limiter) - do NOT run through live chain.
      console.log('[Playback] FX ON - using cachedRenderBuffer (Full Chain)');
    } else {
      // Fallback to normalized buffer through effects chain
      playbackBuffer = fileState.normalizedBuffer || audioNodes.buffer;
      useDirectOutput = false; // Use live effects chain
      console.log('[Playback] FX ON - NO cached buffer, falling back to full live chain');
    }
  }

  if (!playbackBuffer) return;

  try {
    if (audioNodes.context.state === 'suspended') {
      audioNodes.context.resume();
    }

    stopAudio();

    audioNodes.source = audioNodes.context.createBufferSource();
    audioNodes.source.buffer = playbackBuffer;

    // Bypass uses direct output; FX ON routes through the live WebAudio chain
    if (useDirectOutput) {
      connectDirectToOutput(audioNodes.source);
    } else {
      connectAudioChain(audioNodes.source);
    }

    audioNodes.source.onended = () => {
      if (playerState.isPlaying) {
        playerState.isPlaying = false;
        updatePlayPauseIcon(false);
        clearInterval(playerState.seekUpdateInterval);
        stopMeterAnimation();
      }
    };

    const offset = clampPlaybackTime(playerState.pauseTime, playbackBuffer);
    playerState.pauseTime = offset;
    syncTimelineDuration(playbackBuffer);
    playerState.startTime = audioNodes.context.currentTime - offset;
    audioNodes.source.start(0, offset);
    playerState.isPlaying = true;
    updatePlayPauseIcon(true);
    startMeterAnimation();

    clearInterval(playerState.seekUpdateInterval);
    playerState.seekUpdateInterval = setInterval(() => {
      if (playerState.isPlaying && playbackBuffer && !playerState.isSeeking) {
        const currentTime = audioNodes.context.currentTime - playerState.startTime;
        if (currentTime >= playbackBuffer.duration) {
          stopAudio();
          playerState.pauseTime = 0;
          seekBar.value = 0;
          currentTimeEl.textContent = '0:00';
        } else {
          seekBar.value = currentTime;
          currentTimeEl.textContent = formatTime(currentTime);
          updateWaveSurferProgress(currentTime, playbackBuffer.duration);
        }
      }
    }, 100);
  } catch (err) {
    console.error('[Playback] Error in playAudio:', err);
    showToast(`Playback error: ${err.message}`, 'error');
    stopAudio();
  }
}

function pauseAudio() {
  if (!playerState.isPlaying) return;

  playerState.pauseTime = clampPlaybackTime(audioNodes.context.currentTime - playerState.startTime);
  stopAudio();
  stopMeterAnimation();
}

function stopAudio() {
  if (audioNodes.source) {
    // IMPORTANT: Clear the onended handler before stopping, otherwise a late
    // onended from the previous source can flip isPlaying=false and freeze the
    // meter/scrubber after we restart playback (e.g. when toggling FX bypass).
    const oldSource = audioNodes.source;
    audioNodes.source = null;

    try { oldSource.onended = null; } catch (e) { }
    try { oldSource.stop(); } catch (e) { }
    try { oldSource.disconnect(); } catch (e) { }
  }
  playerState.isPlaying = false;
  updatePlayPauseIcon(false);
  clearInterval(playerState.seekUpdateInterval);
}

function seekTo(time) {
  // Rapid timeline drags must keep audio and cursor together. Cancel the old
  // unlock timer and let the latest seek replace the previous source.
  if (playerState.seekTimeout) {
    clearTimeout(playerState.seekTimeout);
    playerState.seekTimeout = null;
  }
  playerState.isSeeking = true;

  let playbackBuffer = getActivePlaybackBuffer();
  if (!playbackBuffer && !playerState.isBypassed && isCurrentArtifactSafeSource()) {
    playBtn.disabled = true;
    scheduleRenderToCache({ immediate: true });
    showToast('피아노 보호 렌더를 준비하는 중입니다. 잠시 후 다시 이동해 주세요.', '', 2200);
    playerState.isSeeking = false;
    return;
  }

  const safeTime = clampPlaybackTime(time, playbackBuffer || getTimelineBuffer());
  playerState.pauseTime = safeTime;
  seekBar.value = safeTime;
  currentTimeEl.textContent = formatTime(safeTime);

  if (playerState.isPlaying) {
    if (audioNodes.source) {
      try {
        // Clear reference first to prevent race conditions
        const oldSource = audioNodes.source;
        audioNodes.source = null;
        // Clear onended before stopping to prevent it from setting isPlaying = false
        oldSource.onended = null;
        oldSource.stop();
        oldSource.disconnect();
      } catch (e) { }
    }
    clearInterval(playerState.seekUpdateInterval);

    // Select correct buffer based on bypass state (same logic as playAudio)
    let useDirectOutput = false;

    if (playerState.isBypassed) {
      playbackBuffer = getBypassPlaybackBuffer();
      useDirectOutput = true;
    } else {
      if (isCurrentArtifactSafeSource()) {
        playbackBuffer = fileState.cachedRenderBuffer;
        useDirectOutput = true;
      } else if (fileState.forceLivePreview) {
        playbackBuffer = fileState.normalizedBuffer || fileState.originalBuffer || audioNodes.buffer;
        useDirectOutput = false;
      } else if (fileState.cachedRenderBuffer) {
        playbackBuffer = fileState.cachedRenderBuffer;
        // Cached buffer is full chain (includes final limiter) - do NOT run through live chain.
        useDirectOutput = true;
      } else {
        playbackBuffer = fileState.normalizedBuffer || audioNodes.buffer;
        useDirectOutput = false;
      }
    }

    if (!playbackBuffer) {
      playerState.isSeeking = false;
      return;
    }

    const restartTime = clampPlaybackTime(safeTime, playbackBuffer);
    playerState.pauseTime = restartTime;
    syncTimelineDuration(playbackBuffer);

    audioNodes.source = audioNodes.context.createBufferSource();
    audioNodes.source.buffer = playbackBuffer;

    if (useDirectOutput) {
      connectDirectToOutput(audioNodes.source);
    } else {
      connectAudioChain(audioNodes.source);
    }

    audioNodes.source.onended = () => {
      if (playerState.isPlaying) {
        playerState.isPlaying = false;
        updatePlayPauseIcon(false);
        clearInterval(playerState.seekUpdateInterval);
      }
    };

    playerState.startTime = audioNodes.context.currentTime - restartTime;
    audioNodes.source.start(0, restartTime);

    playerState.seekUpdateInterval = setInterval(() => {
      if (playerState.isPlaying && playbackBuffer && !playerState.isSeeking) {
        const currentTime = audioNodes.context.currentTime - playerState.startTime;
        if (currentTime >= playbackBuffer.duration) {
          stopAudio();
          playerState.pauseTime = 0;
          seekBar.value = 0;
          currentTimeEl.textContent = '0:00';
        } else {
          seekBar.value = currentTime;
          currentTimeEl.textContent = formatTime(currentTime);
          updateWaveSurferProgress(currentTime, playbackBuffer.duration);
        }
      }
    }, 100);
  } else {
    updateWaveSurferProgress(safeTime, (playbackBuffer || getTimelineBuffer())?.duration);
  }

  // Release seek lock after a brief delay to allow audio to stabilize
  playerState.seekTimeout = setTimeout(() => {
    playerState.isSeeking = false;
    playerState.seekTimeout = null;
  }, 50);
}

// formatTime imported from ./ui/transport.js

// ============================================================================
// File Selection (Browser)
// ============================================================================

// Open file picker when button clicked
selectFileBtn.addEventListener('click', () => {
  fileInput.click();
});

changeFileBtn.addEventListener('click', () => {
  stopAudio();
  playerState.pauseTime = 0;
  fileInput.click();
});

selectReferenceBtn.addEventListener('click', () => {
  referenceInput.click();
});

referenceInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) {
    await loadReferenceFile(file);
  }
  referenceInput.value = '';
});

clearReferenceBtn.addEventListener('click', () => {
  clearReferenceState();
  markCustomPreset();
  schedulePreviewUpdate({ immediate: playerState.isPlaying && !playerState.isBypassed });
  updateChecklist();
});

function clearReferenceState() {
  setReferenceAnalysis(null);
  referenceMatch.checked = false;
  referenceName.textContent = 'No reference';
}

async function clearCurrentSession({ toast = true } = {}) {
  if (isProcessing) {
    showToast('Cannot clear while export is processing.', 'error');
    return;
  }

  if (cacheRenderTimeout) {
    clearTimeout(cacheRenderTimeout);
    cacheRenderTimeout = null;
  }
  if (liveWaveformTimeout) {
    clearTimeout(liveWaveformTimeout);
    liveWaveformTimeout = null;
  }
  if (lufsDebounceTimeout) {
    clearTimeout(lufsDebounceTimeout);
    lufsDebounceTimeout = null;
  }
  cacheRenderQueued = false;
  cacheRenderQueuedImmediate = false;

  stopAudio();
  stopMeter();
  await cleanupAudioContext();
  destroyWaveSurfer();
  resetTransportPreviewState();
  resetSpectrogramView();

  currentFile = null;
  window.__currentAudioFileName = '';
  fileInput.value = '';
  fileState.selectedFilePath = null;
  fileState.originalBuffer = null;
  fileState.normalizedBuffer = null;
  fileState.normalizedTargetLufs = null;
  fileState.processedBuffer = null;
  fileState.isNormalizing = false;
  fileState.isProcessingEffects = false;
  fileState.dcOffset = null;
  fileState.cachedRenderBuffer = null;
  fileState.cachedRenderLufs = null;
  fileState.isRenderingCache = false;
  fileState.estimatedBitrateKbps = null;
  fileState.aiAnalysis = null;
  fileState.aiAutoRecommendation = null;
  fileState.waveformMode = 'original';
  fileState.forceLivePreview = false;
  fileState.originalLufs = null;
  fileState.originalTruePeak = null;
  fileState.originalSampleRate = null;
  fileState.cacheRenderVersion++;

  clearReferenceState();
  applyModeDefaults(AI_MODE_DEFAULTS.auto);
  resetOutputToStreamingDefault();
  setAssistantPresetActive('ai-auto');
  clearExportQualitySummary();

  fileName.textContent = 'No file';
  fileMeta.textContent = '--';
  durationEl.textContent = '0:00';
  currentTimeEl.textContent = '0:00';
  seekBar.value = 0;
  seekBar.max = 100;
  outputLufsDisplay.textContent = '-- LUFS';
  peakL.textContent = 'L: -∞ dB';
  peakR.textContent = 'R: -∞ dB';
  dcOffsetBadge?.classList.add('hidden');
  fileLoaded.classList.add('hidden');
  fileZoneContent.classList.remove('hidden');
  document.body.classList.remove('audio-loaded');
  processBtn.disabled = true;
  playBtn.disabled = true;
  stopBtn.disabled = true;
  playerState.pauseTime = 0;

  updateChecklist();

  if (toast) {
    showToast('Cleared current file and mastering state.', 'success', 1800);
  }
}

// Handle file input change
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) {
    await loadFile(file);
  }
  // Reset input so same file can be selected again
  fileInput.value = '';
});

async function loadFile(file) {
  // Prevent loading while export is in progress
  if (isProcessing) {
    showToast('Cannot load file while processing', 'error');
    return false;
  }

  try {
    // Cleanup previous AudioContext to prevent memory leaks
    await cleanupAudioContext();
    resetTransportPreviewState();
    resetSpectrogramView();

    // Store file reference for browser
    currentFile = file;
    window.__currentAudioFileName = file.name || '';
    fileState.selectedFilePath = file.name;

    // Load into Web Audio first to get metadata
    const loaded = await loadAudioFile(file);

    if (loaded && audioNodes.buffer) {
      // Get file info from the decoded audio buffer
      const name = file.name.substring(0, 100);
      const ext = name.split('.').pop().toUpperCase();
      const sampleRateKHz = (fileState.originalSampleRate / 1000).toFixed(1);
      const duration = formatTime(audioNodes.buffer.duration);
      const lufs = fileState.originalLufs !== undefined ? fileState.originalLufs.toFixed(1) : '--';
      const truePeak = fileState.originalTruePeak !== undefined ? fileState.originalTruePeak.toFixed(1) : '--';

      // Estimate bitrate from file size (for compressed formats)
      const estimatedBitrate = fileState.estimatedBitrateKbps
        || Math.round((file.size * 8) / (audioNodes.buffer.duration * 1000)); // kbps

      fileName.textContent = name;
      // Format: {type} • {bitrate} • {sample-rate} • {LUFS} • {dBTP} • {length}
      fileMeta.textContent = `${ext} • ${estimatedBitrate}kbps • ${sampleRateKHz}kHz • ${lufs} LUFS • ${truePeak} dBTP • ${duration}`;

      // Show DC offset badge if DC offset was removed
      if (dcOffsetBadge) {
        if (fileState.dcOffset?.removed) {
          dcOffsetBadge.classList.remove('hidden');
          dcOffsetBadge.title = `DC offset of ${fileState.dcOffset.percent.toFixed(3)}% was detected and removed`;
        } else {
          dcOffsetBadge.classList.add('hidden');
        }
      }

      fileZoneContent.classList.add('hidden');
      fileLoaded.classList.remove('hidden');

      // Re-apply current UI settings to the new audio nodes
      updateInputGain();
      updateEQ();
      updateStereoWidth();
      updateAudioChain();

      updateChecklist();
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error in loadFile:', error);
    showToast(`Failed to load file: ${error.message}`, 'error');
    return false;
  }
}

function isSupportedAudioFile(file) {
  if (!file) return false;
  if (file.type?.startsWith('audio/')) return true;
  return /\.(mp3|wav|flac|aac|m4a|mp4|ogg|wma|amr)$/i.test(file.name || '');
}

async function loadDroppedFile(file) {
  if (!isSupportedAudioFile(file)) {
    showToast('Please drop a supported audio file.', 'error');
    return false;
  }

  stopAudio();
  playerState.pauseTime = 0;
  return loadFile(file);
}

// Drag and drop
function hasDraggedFiles(e) {
  return Array.from(e.dataTransfer?.types || []).includes('Files');
}

function setDropActive(active) {
  dropZone.classList.toggle('drag-over', active);
}

['dragenter', 'dragover'].forEach(type => {
  window.addEventListener(type, (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropActive(true);
  });
});

['dragleave', 'dragend'].forEach(type => {
  window.addEventListener(type, (e) => {
    if (type === 'dragleave' && e.relatedTarget) return;
    setDropActive(false);
  });
});

window.addEventListener('drop', async (e) => {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
  setDropActive(false);

  const file = e.dataTransfer?.files?.[0];
  if (file) {
    await loadDroppedFile(file);
  }
});

dropZone.addEventListener('dragover', (e) => {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'copy';
  setDropActive(true);
});

dropZone.addEventListener('drop', async (e) => {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  setDropActive(false);

  const file = e.dataTransfer?.files?.[0];
  if (file) {
    await loadDroppedFile(file);
  }
});

// ============================================================================
// Player Controls
// ============================================================================

playBtn.addEventListener('click', () => {
  if (playerState.isPlaying) {
    pauseAudio();
  } else {
    playAudio();
  }
});

stopBtn.addEventListener('click', () => {
  stopAudio();
  stopMeter();
  playerState.pauseTime = 0;
  seekBar.value = 0;
  currentTimeEl.textContent = '0:00';
});

// Seek bar is hidden - wavesurfer handles interaction
// This is kept for programmatic updates only
seekBar.addEventListener('input', () => {
  const time = parseFloat(seekBar.value);
  currentTimeEl.textContent = formatTime(time);
});

bypassBtn.addEventListener('click', () => {
  playerState.isBypassed = !playerState.isBypassed;
  const bypassLabel = bypassBtn.querySelector('.bypass-label');
  if (bypassLabel) {
    bypassLabel.textContent = playerState.isBypassed ? 'OFF' : 'FX';
  }
  bypassBtn.classList.toggle('active', playerState.isBypassed);

  console.log('[Bypass] Toggled to:', playerState.isBypassed ? 'OFF (original)' : 'FX ON (processed)');
  console.log('[Bypass] cachedRenderBuffer exists:', !!fileState.cachedRenderBuffer);
  console.log('[Bypass] isPlaying:', playerState.isPlaying);

  // Ensure live node params reflect bypass state (without triggering expensive cache re-render)
  updateEQ();
  updateStereoWidth();
  updateAudioChain({ scheduleCache: false });

  // Update waveform display to show original or processed
  if (playerState.isBypassed) {
    fileState.forceLivePreview = false;
    showSourceWaveform();
  } else {
    // Show processed waveform (if cached buffer exists)
    if (fileState.cachedRenderBuffer) {
      showProcessedWaveform(fileState.cachedRenderBuffer);
    }
  }

  // If playing, restart playback to switch buffers (original vs processed)
  if (playerState.isPlaying) {
    console.log('[Bypass] Restarting playback to switch buffer');
    const currentTime = audioNodes.context.currentTime - playerState.startTime;
    playerState.pauseTime = clampPlaybackTime(currentTime);
    playAudio(); // This will use the correct buffer based on isBypassed
  }
});

// ============================================================================
// Export/Processing (Browser Download)
// ============================================================================

processBtn.addEventListener('click', async () => {
  if (!audioNodes.buffer) {
    showToast('✗ No audio loaded', 'error');
    return;
  }

  isProcessing = true;
  processingCancelled = false;
  processBtn.disabled = true;
  // Re-enable cancel buttons for new processing
  modalCancelBtn.disabled = false;
  cancelBtn.disabled = false;

  // Store promise for cancellation tracking
  processingPromise = processAudio();
  await processingPromise;
  processingPromise = null;
});

async function processAudio() {

  // Parse and validate settings
  const parsedSampleRate = resolveExportSampleRate();
  const parsedBitDepth = parseInt(bitDepth.value) || 16;
  const parsedStereoWidth = parseInt(stereoWidthSlider.value) || 100;

  // Validate settings
  if (![44100, 48000, 88200, 96000, 176400, 192000].includes(parsedSampleRate)) {
    showToast('Invalid sample rate', 'error');
    processBtn.disabled = false;
    isProcessing = false;
    return;
  }
  if (![16, 24].includes(parsedBitDepth)) {
    showToast('Invalid bit depth', 'error');
    processBtn.disabled = false;
    isProcessing = false;
    return;
  }
  if (parsedStereoWidth < 0 || parsedStereoWidth > 200) {
    showToast('Invalid stereo width', 'error');
    processBtn.disabled = false;
    isProcessing = false;
    return;
  }

  const settings = getExportSettings();
  settings.sampleRate = parsedSampleRate;
  settings.bitDepth = parsedBitDepth;
  settings.stereoWidth = parsedStereoWidth;

  const updateProgress = (percent, text) => {
    showLoadingModal(text || 'Rendering...', percent, true);
  };

  try {
    showLoadingModal('Preparing audio...', 2, true);

    if (processingCancelled) {
      throw new Error('Cancelled');
    }

    // Re-verify buffer exists (could be unloaded during async operations)
    if (!fileState.originalBuffer) {
      throw new Error('Audio buffer was unloaded during processing');
    }

    let outputData;
    let exportStats = null;
    let exportRenderSource = 'main-thread';
    let exportRevision = 'main-thread';
    let exportChainDebug = null;
    let exportManifest = null;
    const settingsSummary = summarizeExportSettings(settings);
    const settingsFingerprint = hashString(stableStringify(settingsSummary));
    console.log('[Export] Settings fingerprint:', settingsFingerprint, settingsSummary);

    // Hybrid Pipeline: Cached buffer is preview-only (missing EQ/Comp).
    // ALWAYS render full chain for export to ensure parity.
    console.log('[Export] Starting full chain render (Export Mode)...');
    showLoadingModal('Rendering audio...', 5, true);

    const dspWorker = getDSPWorker();
    if (dspWorker && dspWorker.isReady) {
      // Use Worker (Preferred), but fall back to main thread if it fails so export is never blocked.
      try {
        await dspWorker.restart();
        const result = await dspWorker.renderFullChain(
          fileState.originalBuffer,
          settings,
          'export',
          // Keep headroom for WAV encoding + download prep so the bar stays monotonic.
          (progress, status) => updateProgress(Math.round(5 + progress * 80), status)
        );

        if (processingCancelled) {
          throw new Error('Cancelled');
        }
        if (result.staleWorker) {
          console.warn('[Export] DSP worker revision mismatch:', {
            expected: DSP_RENDER_REVISION,
            actual: result.dspRevision || 'missing'
          });
          dspWorker.terminate();
          showToast('DSP worker가 오래된 상태라 메인 렌더러로 다시 Export 합니다.', 'error', 6500);
          const staleError = new Error('Stale DSP worker');
          staleError.staleWorker = true;
          throw staleError;
        } else {
          console.log('[Export] DSP worker revision:', result.dspRevision);
        }
        exportRenderSource = 'worker';
        exportRevision = result.dspRevision || 'unknown-worker';
        exportChainDebug = result.chainDebug || null;

        const needsResample = result.audioBuffer.sampleRate !== parsedSampleRate;
        let exportBuffer = result.audioBuffer;
        if (needsResample) {
          updateProgress(86, `Resampling to ${parsedSampleRate / 1000}kHz...`);
          exportBuffer = await resampleAudioBuffer(exportBuffer, parsedSampleRate);
        }
        if (processingCancelled) {
          throw new Error('Cancelled');
        }

        exportBuffer = ensureExportBufferSafety(exportBuffer, settings);
        exportStats = getExportQualityStats(exportBuffer, settings);
        updateExportQualitySummary(exportStats);

        const encodeProgressStart = needsResample ? 86 : 85;
        const encodeProgressSpan = needsResample ? 9 : 10;
        updateProgress(encodeProgressStart, 'Encoding WAV...');
        // Yield so the UI can repaint before encoding begins.
        await new Promise(resolve => setTimeout(resolve, 0));

        outputData = await encodeWAVAsync(exportBuffer, parsedSampleRate, parsedBitDepth, {
          onProgress: (p) => updateProgress(Math.round(encodeProgressStart + p * encodeProgressSpan), 'Encoding WAV...'),
          shouldCancel: () => processingCancelled,
          ditherMode: settings.ditherMode
        });
      } catch (workerErr) {
        if (processingCancelled || workerErr?.message === 'Cancelled') {
          throw workerErr;
        }
        console.warn('[Export] Worker render failed, falling back to main thread render:', workerErr);
        exportRenderSource = workerErr?.staleWorker ? 'main-thread-after-stale-worker' : 'main-thread-after-worker-error';
        exportRevision = DSP_RENDER_REVISION;
        outputData = await renderOffline(fileState.originalBuffer, settings, updateProgress, {
          shouldCancel: () => processingCancelled,
          onRenderedBuffer: (buffer) => {
            exportStats = getExportQualityStats(buffer, settings);
            updateExportQualitySummary(exportStats);
          }
        });
      }
    } else {
      // Fallback (Main Thread)
      exportRenderSource = 'main-thread-no-worker';
      exportRevision = DSP_RENDER_REVISION;
      outputData = await renderOffline(fileState.originalBuffer, settings, updateProgress, {
        shouldCancel: () => processingCancelled,
        onRenderedBuffer: (buffer) => {
          exportStats = getExportQualityStats(buffer, settings);
          updateExportQualitySummary(exportStats);
        }
      });
    }

    if (processingCancelled) {
      throw new Error('Cancelled');
    }

    // Download file via browser
    showLoadingModal('Preparing download...', 96, true);

    // Create blob from WAV data
    const blob = new Blob([outputData], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const outputHash = await hashExportBytes(outputData);
    exportManifest = {
      renderSource: exportRenderSource,
      revision: exportRevision,
      settingsFingerprint,
      outputHash,
      bytes: outputData?.length || outputData?.byteLength || 0,
      stats: exportStats,
      chainDebug: exportChainDebug
    };
    console.log('[Export] Render manifest:', exportManifest);

    // Generate a unique output filename so repeated exports cannot be confused
    // with an older browser download.
    const outputName = createExportFileName(currentFile?.name, {
      revision: exportRevision,
      settingsFingerprint,
      outputHash
    });
    console.log('[Export] Download filename:', outputName);

    // Create download link and trigger download
    const a = document.createElement('a');
    a.href = url;
    a.download = outputName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Cleanup blob URL after download starts
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showLoadingModal('Complete!', 100, false);
    setTimeout(() => {
      hideLoadingModal();
      showToast(formatExportCompleteMessage(exportStats, exportManifest), 'success', exportStats ? 6500 : 3500);
    }, 300);

  } catch (error) {
    hideLoadingModal();
    if (processingCancelled || error.message === 'Cancelled') {
      showToast('Export cancelled.');
    } else {
      console.error('Processing error:', error);
      showToast(`✗ Error: ${error.message || error}`, 'error');
    }
  }

  isProcessing = false;
  processBtn.disabled = false;
}

function resolveExportSampleRate() {
  if (sampleRate.value === 'source' && Number.isFinite(fileState.originalSampleRate)) {
    return Math.max(44100, Math.round(fileState.originalSampleRate));
  }
  return parseInt(sampleRate.value) || 44100;
}

function formatExportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

function createExportFileName(inputName, manifest = {}) {
  const baseName = (inputName || 'audio')
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .trim() || 'audio';
  const revision = String(manifest.revision || DSP_RENDER_REVISION)
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .replace(/[^a-z0-9-]+/gi, '')
    .slice(0, 36);
  const settings = String(manifest.settingsFingerprint || '').replace(/[^a-f0-9]/gi, '').slice(0, 8);
  const output = String(manifest.outputHash || '').replace(/[^a-f0-9]/gi, '').slice(0, 12);
  const suffix = [
    revision && `rev-${revision}`,
    settings && `set-${settings}`,
    output && `sha-${output}`
  ].filter(Boolean).join('_');
  return `${baseName}_wam_${formatExportTimestamp()}${suffix ? `_${suffix}` : ''}.wav`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function summarizeExportSettings(settings) {
  return {
    aiEnhance: settings.aiEnhance,
    aiProfile: settings.aiProfile,
    aiIntensity: settings.aiIntensity,
    artifactProtection: settings.artifactProtection,
    sibilanceProtection: settings.sibilanceProtection,
    targetLufs: settings.targetLufs,
    inputGain: settings.inputGain,
    truePeakLimit: settings.truePeakLimit,
    truePeakCeiling: settings.truePeakCeiling,
    limiterCharacter: settings.limiterCharacter,
    normalizeLoudness: settings.normalizeLoudness,
    addAir: settings.addAir,
    addPunch: settings.addPunch,
    tapeWarmth: settings.tapeWarmth,
    cutMud: settings.cutMud,
    deharsh: settings.deharsh,
    autoLevel: settings.autoLevel,
    cleanLowEnd: settings.cleanLowEnd,
    glueCompression: settings.glueCompression,
    centerBass: settings.centerBass,
    stereoWidth: settings.stereoWidth,
    referenceMatch: settings.referenceMatch,
    referenceAmount: settings.referenceAmount,
    isLossySource: settings.isLossySource,
    sampleRate: settings.sampleRate,
    bitDepth: settings.bitDepth,
    ditherMode: settings.ditherMode,
    eqLow: settings.eqLow,
    eqLowMid: settings.eqLowMid,
    eqMid: settings.eqMid,
    eqHighMid: settings.eqHighMid,
    eqHigh: settings.eqHigh
  };
}

async function hashExportBytes(bytes) {
  if (!bytes || !Number.isFinite(bytes.length)) return '';
  if (globalThis.crypto?.subtle) {
    const view = bytes instanceof Uint8Array
      ? bytes
      : new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength || bytes.length);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', view);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  const length = bytes.length;
  for (let i = 0; i < length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  hash ^= length & 0xff;
  hash = Math.imul(hash, 16777619);
  hash ^= (length >>> 8) & 0xff;
  hash = Math.imul(hash, 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function formatSampleRateLabel(rate) {
  if (!Number.isFinite(rate)) return '44.1k';
  const khz = rate / 1000;
  return Number.isInteger(khz) ? `${khz}k` : `${khz.toFixed(1)}k`;
}

function updateExportFormatSummary() {
  if (!exportFormatValue) return;

  const selectedRate = sampleRate.value === 'source'
    ? `Source/${formatSampleRateLabel(resolveExportSampleRate())}`
    : formatSampleRateLabel(parseInt(sampleRate.value) || 44100);
  const selectedDepth = parseInt(bitDepth.value) || 16;
  exportFormatValue.textContent = `${selectedRate} / ${selectedDepth}-bit`;
}

function getExportQualityStats(buffer, settings) {
  if (!buffer) return null;
  return {
    lufs: measureLUFS(buffer),
    truePeak: findTruePeak(buffer),
    sampleRate: buffer.sampleRate,
    bitDepth: settings.bitDepth || 16,
    ceiling: Number.isFinite(Number(settings.truePeakCeiling)) ? Number(settings.truePeakCeiling) : -1
  };
}

function updateExportQualitySummary(stats) {
  if (!stats) {
    clearExportQualitySummary();
    return;
  }

  const safeTruePeak = Number.isFinite(stats.truePeak) && stats.truePeak <= stats.ceiling + 0.02;
  if (exportQualityValue) {
    exportQualityValue.textContent = `${stats.lufs.toFixed(1)} LUFS / ${stats.truePeak.toFixed(2)} dBTP`;
    exportQualityValue.classList.toggle('warning', !safeTruePeak);
  }
  if (outputLufsDisplay) {
    outputLufsDisplay.textContent = `${stats.lufs.toFixed(1)} LUFS`;
  }
}

function clearExportQualitySummary() {
  if (exportQualityValue) {
    exportQualityValue.textContent = 'Export --';
    exportQualityValue.classList.remove('warning');
  }
}

function formatExportCompleteMessage(stats, manifest = null) {
  const trace = manifest
    ? ` DSP ${formatRevisionLabel(manifest.revision)}, set ${String(manifest.settingsFingerprint || '').slice(0, 8)}, sha ${String(manifest.outputHash || '').slice(0, 12)}.`
    : '';
  if (!stats) return `✓ Export complete! Your mastered file is downloading.${trace}`;
  return `✓ Export complete: ${stats.lufs.toFixed(1)} LUFS, ${stats.truePeak.toFixed(2)} dBTP, ${formatSampleRateLabel(stats.sampleRate)} / ${stats.bitDepth}-bit WAV.${trace}`;
}

function ensureExportBufferSafety(buffer, settings) {
  if (!buffer || !settings.truePeakLimit) return buffer;

  const ceiling = Number.isFinite(Number(settings.truePeakCeiling))
    ? Number(settings.truePeakCeiling)
    : -1;
  const truePeak = findTruePeak(buffer);

  if (Number.isFinite(truePeak) && truePeak > ceiling + 0.02) {
    console.warn('[Export] Post-render true peak exceeded ceiling, applying final safety limiter:', {
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

  console.log('[Export] Final safety check:', {
    lufs: measureLUFS(buffer).toFixed(1),
    truePeak: Number.isFinite(truePeak) ? truePeak.toFixed(2) : '--',
    ceiling
  });
  return buffer;
}

cancelBtn.addEventListener('click', cancelProcessing);

// ============================================================================
// Settings & Checklist
// ============================================================================

function updateChecklist() {
  miniFormat.classList.toggle('active', fileState.selectedFilePath !== null);
  if (miniMastering) {
    const profileLabel = aiProfile?.selectedOptions?.[0]?.textContent || 'AI Auto';
    miniMastering.classList.toggle('active', aiEnhance?.checked ?? true);
    miniMastering.textContent = (aiEnhance?.checked ?? true) ? `● ${profileLabel}` : '● Manual';
  }
  if (miniReference) {
    const hasReference = referenceMatch?.checked && referenceName?.textContent !== 'No reference';
    miniReference.classList.toggle('active', hasReference);
  }
  if (miniLive) {
    const isPending = fileState.isRenderingCache || fileState.forceLivePreview || cacheRenderTimeout;
    miniLive.classList.toggle('active', Boolean(fileState.cachedRenderBuffer) && !isPending);
    miniLive.classList.toggle('pending', Boolean(isPending));
    miniLive.textContent = isPending ? '● Updating' : '● Live';
  }
  updateControlPanelSummary();
}

function clamp01(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function getStereoRisk(analysis = fileState.aiAnalysis) {
  if (!analysis?.stereo) return 0;
  return Math.max(
    clamp01((analysis.stereo.sideToMidDB + 5) / 8),
    clamp01((analysis.stereo.lowSideToMidDB + 10) / 10),
    clamp01((analysis.stereo.highSideToMidDB + 8) / 12),
    clamp01((0.12 - analysis.stereo.correlation) / 0.5)
  );
}

function getSourceRiskLabel(analysis = fileState.aiAnalysis) {
  if (!analysis) return '--';

  const peaks = analysis.peaks || {};
  const limiterRisk = analysis.limiterRisk ?? 0;
  const codecStress = analysis.codecStress ?? 0;
  const clippedOrPinned = (peaks.clipDensity ?? 0) > 0.0001 || (peaks.peakDensity ?? 0) > 0.015;
  const stereoRisk = getStereoRisk(analysis);

  if (clippedOrPinned || limiterRisk > 0.58) return 'Limiter';
  if (codecStress > 0.45) return 'Codec';
  if (stereoRisk > 0.75) return 'Stereo';
  if ((peaks.loudestCrestDB ?? 12) < 6.5) return 'Dense';
  return 'Low';
}

function getSourceHeadroomDB(analysis = fileState.aiAnalysis) {
  if (Number.isFinite(fileState.originalTruePeak)) {
    return -fileState.originalTruePeak;
  }
  const measuredHeadroom = analysis?.peaks?.truePeakHeadroomDB;
  return Number.isFinite(measuredHeadroom) ? measuredHeadroom : NaN;
}

function getHeadroomLabel(analysis = fileState.aiAnalysis) {
  const headroom = getSourceHeadroomDB(analysis);
  if (!Number.isFinite(headroom)) return '--';
  if (headroom <= 0.3) return 'Clipped';
  if (headroom < 4) return `Hot ${headroom.toFixed(1)}`;
  if (headroom <= 8) return `Good ${headroom.toFixed(1)}`;
  return `Quiet ${headroom.toFixed(1)}`;
}

function getFocusLabel(analysis = fileState.aiAnalysis) {
  if (!analysis) return 'Waiting';
  const activePct = Math.round((analysis.activeRatio ?? 0) * 100);
  const loudestPct = Math.round((analysis.loudestRatio ?? 0) * 100);
  if (loudestPct > 0) return `Loudest ${loudestPct}%`;
  if (activePct > 0) return `Active ${activePct}%`;
  return 'Full Track';
}

function getToneLabel(analysis = fileState.aiAnalysis) {
  if (!analysis?.profile) return '--';
  const { mudDB, harshDB, metallicDB = -18, airDB, presenceToBodyDB = 0 } = analysis.profile;
  if (harshDB > -11 || metallicDB > -13) return 'Harsh';
  if (mudDB > -7.5 && presenceToBodyDB < 0.5) return 'Muddy';
  if (airDB < -23 && harshDB < -13 && metallicDB < -15) return 'Dull';
  if (presenceToBodyDB < -2.5 && airDB < -20) return 'Veiled';
  return 'Open';
}

function getAnalysisActionLabel(analysis = fileState.aiAnalysis) {
  if (!analysis) return 'Upload';
  const headroom = getSourceHeadroomDB(analysis);
  if (Number.isFinite(headroom) && headroom < 4) return 'Auto Gain';

  const risk = getSourceRiskLabel(analysis);
  if (risk === 'Limiter' || risk === 'Codec') return 'AI Clean';
  if (risk === 'Stereo') return 'Center Bass';

  const tone = getToneLabel(analysis);
  if (tone === 'Dull' || tone === 'Veiled' || tone === 'Muddy') return 'Clarity';
  if (tone === 'Harsh') return 'AI Clean';
  return 'Ready';
}

function applyAnalysisAction() {
  const action = getAnalysisActionLabel();

  if (action === 'Upload') {
    fileInput.click();
    return;
  }

  if (action === 'Auto Gain') {
    applySourceSafeGain();
    return;
  }

  if (action === 'AI Clean') {
    applyAssistantPreset('ai-clean');
    showToast('AI Clean applied from analysis.', 'success', 1600);
    return;
  }

  if (action === 'Center Bass') {
    centerBass.checked = true;
    updateAudioChain({ immediate: playerState.isPlaying && !playerState.isBypassed });
    updateChecklist();
    updateControlPanelSummary();
    showToast('Center Bass enabled for safer stereo translation.', 'success', 1800);
    return;
  }

  if (action === 'Clarity') {
    aiProfile.value = 'clarity';
    applyAIProfileSelectionDefaults();
    showToast('Clarity applied to reduce muddiness.', 'success', 1600);
    return;
  }

  showToast('Analysis looks ready.', 'success', 1200);
}

function formatProfileName(value) {
  if (!value) return 'Auto';
  return value
    .replace(/-/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function getModeProfileLabel() {
  const activePreset = getActiveAssistantPresetName();
  if (activePreset === 'ai-auto' && fileState.aiAutoRecommendation?.profile) {
    return `AI ${formatProfileName(fileState.aiAutoRecommendation.profile)}`;
  }
  if (activePreset === 'ai-clean') return 'AI Clean';
  if (activePreset === 'artifact-safe') return 'Artifact Safe';
  if (activePreset === 'ai-loud') return 'AI Loud';
  if (activePreset === 'reference') return 'Reference';
  if (activePreset === 'manual') return 'Manual';
  if (activePreset === 'custom') return 'Custom';
  return formatProfileName(aiProfile.value || 'auto');
}

function isEqFlat() {
  return Math.max(
    Math.abs(eqValues.low),
    Math.abs(eqValues.lowMid),
    Math.abs(eqValues.mid),
    Math.abs(eqValues.highMid),
    Math.abs(eqValues.high)
  ) < 0.05;
}

function resetEQToFlat() {
  eqValues.low = 0;
  eqValues.lowMid = 0;
  eqValues.mid = 0;
  eqValues.highMid = 0;
  eqValues.high = 0;
  if (faders.eqLow) faders.eqLow.setValue(0);
  if (faders.eqLowMid) faders.eqLowMid.setValue(0);
  if (faders.eqMid) faders.eqMid.setValue(0);
  if (faders.eqHighMid) faders.eqHighMid.setValue(0);
  if (faders.eqHigh) faders.eqHigh.setValue(0);
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === 'flat');
  });
  updateEQ();
}

function updateControlPanelSummary() {
  if (analysisFocusValue) analysisFocusValue.textContent = getFocusLabel();
  if (analysisRiskValue) analysisRiskValue.textContent = getSourceRiskLabel();
  if (analysisHeadroomValue) analysisHeadroomValue.textContent = getHeadroomLabel();
  if (analysisToneValue) analysisToneValue.textContent = getToneLabel();
  if (analysisActionValue) analysisActionValue.textContent = getAnalysisActionLabel();
  if (analysisSafeValue) {
    const safeOn = truePeakLimit.checked && cleanLowEnd.checked && centerBass.checked;
    const lossySafe = !currentFile || !/\.(mp3|aac|m4a|mp4|ogg|wma|amr)$/i.test(currentFile.name) || ceilingValueDb <= -1.4;
    const sourceHeadroom = getSourceHeadroomDB();
    const compensatedHeadroom = sourceHeadroom - Math.min(0, inputGainValue);
    const sourceProtected = !Number.isFinite(sourceHeadroom) || compensatedHeadroom >= 4 || inputGainValue <= -5.5;
    analysisSafeValue.textContent = safeOn && lossySafe && sourceProtected ? 'On' : 'Check';
  }
  if (modeTargetValue) modeTargetValue.textContent = `Target ${targetLufsSlider.value}`;
  if (modeProfileValue) modeProfileValue.textContent = `Profile ${getModeProfileLabel()}`;
  if (modeInputValue) modeInputValue.textContent = `Input ${inputGainValue.toFixed(1)}`;
  if (modeCeilingValue) modeCeilingValue.textContent = `TP ${ceilingValueDb.toFixed(1)}`;
  if (modeLimiterValue) {
    const label = limiterCharacter.selectedOptions?.[0]?.textContent || limiterCharacter.value;
    modeLimiterValue.textContent = label;
  }
  if (modeEqValue) modeEqValue.textContent = isEqFlat() ? 'EQ Flat' : 'EQ Custom';
  if (levelMatchPanel) {
    const transportLevelMatch = document.getElementById('levelMatchBtn');
    levelMatchPanel.checked = transportLevelMatch?.checked ?? true;
  }
}

function setAdvancedMode(enabled) {
  document.body.classList.toggle('advanced-mode', enabled);
  if (advancedMode) advancedMode.checked = enabled;
}

function setAssistantPresetActive(name) {
  assistantPresetButtons.forEach(btn => {
    const isCustomButton = btn.dataset.masteringPreset === 'custom';
    btn.classList.toggle('hidden', isCustomButton && name !== 'custom');
    btn.classList.toggle('active', btn.dataset.masteringPreset === name);
  });
  updateControlPanelSummary();
}

function markCustomPreset() {
  setAssistantPresetActive('custom');
}

function updateSliderLabels() {
  aiIntensityValue.textContent = `${aiIntensity.value}%`;
  sibilanceProtectionValue.textContent = `${sibilanceProtection.value}%`;
  artifactProtectionValue.textContent = `${artifactProtection.value}%`;
  referenceAmountValue.textContent = `${referenceAmount.value}%`;
  stereoWidthValue.textContent = `${stereoWidthSlider.value}%`;
  targetLufsValue.textContent = `${targetLufsSlider.value} LUFS`;
  updateControlPanelSummary();
}

function setTargetLufsControl(value) {
  targetLufsSlider.value = String(value);
  setTargetLufs(value);
}

function getActiveAssistantPresetName() {
  return document.querySelector('.assistant-preset.active')?.dataset.masteringPreset || '';
}

const AI_MODE_DEFAULTS = {
  auto: {
    aiProfile: 'auto',
    aiIntensity: 105,
    sibilanceProtection: 65,
    artifactProtection: 70,
    inputGain: -3.5,
    truePeakCeiling: -1,
    targetLufs: -12,
    limiterCharacter: 'balanced',
    addPunch: true,
    tapeWarmth: true,
    addAir: false,
    cutMud: false,
    stereoWidth: 100,
    referenceAmount: 65,
    cleanLowEnd: true,
    glueCompression: true,
    deharsh: true,
    centerBass: true,
    autoLevel: true
  },
  clean: {
    aiProfile: 'clean',
    aiIntensity: 90,
    sibilanceProtection: 75,
    artifactProtection: 80,
    inputGain: -5,
    truePeakCeiling: -1.5,
    targetLufs: -14,
    limiterCharacter: 'transparent',
    addPunch: false,
    tapeWarmth: true,
    addAir: false,
    cutMud: true,
    stereoWidth: 98,
    referenceAmount: 60,
    cleanLowEnd: true,
    glueCompression: true,
    deharsh: true,
    centerBass: true,
    autoLevel: false
  },
  artifactSafe: {
    rescueMode: true,
    aiProfile: 'clean',
    aiIntensity: 85,
    sibilanceProtection: 85,
    artifactProtection: 95,
    inputGain: -5.5,
    truePeakCeiling: -1.5,
    targetLufs: -14,
    limiterCharacter: 'transparent',
    addPunch: false,
    tapeWarmth: false,
    addAir: false,
    cutMud: true,
    stereoWidth: 98,
    referenceAmount: 55,
    cleanLowEnd: true,
    glueCompression: false,
    deharsh: true,
    centerBass: true,
    autoLevel: false
  },
  loud: {
    aiProfile: 'loud',
    aiIntensity: 110,
    sibilanceProtection: 75,
    artifactProtection: 80,
    inputGain: -5,
    truePeakCeiling: -1.5,
    targetLufs: -10.5,
    limiterCharacter: 'dense',
    addPunch: true,
    tapeWarmth: true,
    addAir: false,
    cutMud: true,
    stereoWidth: 100,
    referenceAmount: 60,
    cleanLowEnd: true,
    glueCompression: true,
    deharsh: true,
    centerBass: true,
    autoLevel: true
  },
  reference: {
    aiProfile: 'auto',
    aiIntensity: 100,
    sibilanceProtection: 65,
    artifactProtection: 70,
    inputGain: -3.5,
    truePeakCeiling: -1,
    targetLufs: -12,
    limiterCharacter: 'balanced',
    addPunch: true,
    tapeWarmth: true,
    addAir: false,
    cutMud: false,
    stereoWidth: 100,
    referenceAmount: 65,
    cleanLowEnd: true,
    glueCompression: true,
    deharsh: true,
    centerBass: true,
    autoLevel: true
  },
  manual: {
    aiProfile: 'auto',
    aiIntensity: 100,
    sibilanceProtection: 50,
    artifactProtection: 50,
    inputGain: -3.5,
    truePeakCeiling: -1,
    targetLufs: -14,
    limiterCharacter: 'transparent',
    addPunch: false,
    tapeWarmth: false,
    addAir: false,
    cutMud: false,
    stereoWidth: 100,
    referenceAmount: 65,
    cleanLowEnd: true,
    glueCompression: true,
    deharsh: false,
    centerBass: true,
    autoLevel: false
  },
  universal: { aiProfile: 'universal', aiIntensity: 105, sibilanceProtection: 65, artifactProtection: 70, inputGain: -3.5, truePeakCeiling: -1, targetLufs: -12, limiterCharacter: 'balanced', addPunch: true, tapeWarmth: true, addAir: false, cutMud: false, stereoWidth: 100 },
  fire: { aiProfile: 'fire', aiIntensity: 110, sibilanceProtection: 70, artifactProtection: 75, inputGain: -4.5, truePeakCeiling: -1.5, targetLufs: -11, limiterCharacter: 'punch', addPunch: true, tapeWarmth: true, addAir: false, cutMud: true, stereoWidth: 100 },
  clarity: { aiProfile: 'clarity', aiIntensity: 100, sibilanceProtection: 70, artifactProtection: 75, inputGain: -3.5, truePeakCeiling: -1.5, targetLufs: -12.5, limiterCharacter: 'balanced', addPunch: false, tapeWarmth: true, addAir: true, cutMud: true, stereoWidth: 100 },
  tape: { aiProfile: 'tape', aiIntensity: 100, sibilanceProtection: 70, artifactProtection: 75, inputGain: -4, truePeakCeiling: -1.5, targetLufs: -13, limiterCharacter: 'transparent', addPunch: false, tapeWarmth: true, addAir: false, cutMud: false, stereoWidth: 100 },
  natural: { aiProfile: 'natural', aiIntensity: 95, sibilanceProtection: 65, artifactProtection: 70, inputGain: -3.5, truePeakCeiling: -1.5, targetLufs: -13, limiterCharacter: 'transparent', addPunch: false, tapeWarmth: true, addAir: false, cutMud: false, stereoWidth: 100 },
  spatial: { aiProfile: 'spatial', aiIntensity: 100, sibilanceProtection: 70, artifactProtection: 75, inputGain: -4, truePeakCeiling: -1.5, targetLufs: -12.5, limiterCharacter: 'balanced', addPunch: false, tapeWarmth: true, addAir: false, cutMud: false, stereoWidth: 105 },
  cinematic: { aiProfile: 'cinematic', aiIntensity: 100, sibilanceProtection: 65, artifactProtection: 70, inputGain: -4, truePeakCeiling: -1.5, targetLufs: -13, limiterCharacter: 'balanced', addPunch: true, tapeWarmth: true, addAir: false, cutMud: false, stereoWidth: 102 },
  punchy: { aiProfile: 'punchy', aiIntensity: 105, sibilanceProtection: 70, artifactProtection: 75, inputGain: -4.5, truePeakCeiling: -1.5, targetLufs: -11.5, limiterCharacter: 'punch', addPunch: true, tapeWarmth: true, addAir: false, cutMud: true, stereoWidth: 100 },
  warm: { aiProfile: 'warm', aiIntensity: 100, sibilanceProtection: 70, artifactProtection: 75, inputGain: -4, truePeakCeiling: -1.5, targetLufs: -13, limiterCharacter: 'transparent', addPunch: false, tapeWarmth: true, addAir: false, cutMud: false, stereoWidth: 100 },
  vocal: { aiProfile: 'vocal', aiIntensity: 100, sibilanceProtection: 80, artifactProtection: 75, inputGain: -4, truePeakCeiling: -1.5, targetLufs: -12.5, limiterCharacter: 'transparent', addPunch: false, tapeWarmth: true, addAir: false, cutMud: true, stereoWidth: 98 },
  bass: { aiProfile: 'bass', aiIntensity: 100, sibilanceProtection: 70, artifactProtection: 75, inputGain: -4.5, truePeakCeiling: -1.5, targetLufs: -12, limiterCharacter: 'balanced', addPunch: true, tapeWarmth: true, addAir: false, cutMud: true, stereoWidth: 98 }
};

function refineModeDefaultsForCurrentSource(defaults) {
  const refined = { ...defaults };
  const analysis = fileState.aiAnalysis;
  const currentName = currentFile?.name || '';
  const isLossy = /\.(mp3|aac|m4a|mp4|ogg|wma|amr)$/i.test(currentName);
  const isLowBitrate = isLossy && Number.isFinite(fileState.estimatedBitrateKbps) && fileState.estimatedBitrateKbps < 192;

  if (isLossy) {
    refined.truePeakCeiling = Math.min(refined.truePeakCeiling ?? -1, -1.5);
    refined.sibilanceProtection = Math.max(refined.sibilanceProtection ?? 65, 75);
    refined.artifactProtection = Math.max(refined.artifactProtection ?? 70, 80);
    refined.targetLufs = Math.min(refined.targetLufs ?? -12, -14);
    refined.limiterCharacter = 'transparent';
    refined.addAir = false;
    refined.addPunch = false;
    refined.tapeWarmth = false;
    refined.glueCompression = false;
  }

  if (!analysis) return refined;

  const peaks = analysis.peaks || {};
  const clippedOrPinned = (peaks.clipDensity ?? 0) > 0.0001 || (peaks.peakDensity ?? 0) > 0.015;
  const limiterRisk = analysis.limiterRisk ?? 0;
  const codecStress = analysis.codecStress ?? 0;
  const stereoRisk = getStereoRisk(analysis);
  const profile = analysis.profile || {};
  const darkButSafe = (profile.airDB ?? -18) < -24 &&
    (profile.presenceToBodyDB ?? 0) < -10 &&
    (profile.harshDB ?? -18) < -12 &&
    (profile.metallicDB ?? -18) < -14 &&
    limiterRisk < 0.35 &&
    codecStress < 0.28;
  const muddyOrVeiled = (profile.mudDB ?? -18) > -7.5 ||
    ((profile.airDB ?? -18) < -23 && (profile.presenceToBodyDB ?? 0) < -8 && (profile.harshDB ?? -18) < -12);
  const percussiveArtifactRisk = isLossy ||
    codecStress > 0.32 ||
    (profile.metallicDB ?? -18) > -14.5 ||
    (profile.harshDB ?? -18) > -11.5;
  const artifactRescueRisk = (
    isLossy &&
    (
      (profile.metallicDB ?? -18) > -15.5 ||
      (profile.harshDB ?? -18) > -12.5 ||
      codecStress > 0.34 ||
      (peaks.peakDensity ?? 0) > 0.006 ||
      (peaks.spikeDensity ?? 0) > 0.00005 ||
      (peaks.loudestCrestDB ?? analysis.crestDB ?? 12) < 8
    )
  ) || (profile.metallicDB ?? -18) > -12.5 || codecStress > 0.58 || (peaks.spikeDensity ?? 0) > 0.00005;

  if (clippedOrPinned || limiterRisk > 0.55 || (peaks.loudestCrestDB ?? 12) < 6.5) {
    refined.inputGain = Math.min(refined.inputGain ?? -3.5, -5.5);
    refined.truePeakCeiling = Math.min(refined.truePeakCeiling ?? -1, -1.5);
    refined.targetLufs = -14;
    refined.limiterCharacter = 'transparent';
    refined.addPunch = false;
    refined.tapeWarmth = false;
    refined.glueCompression = false;
  } else if (limiterRisk > 0.38 || codecStress > 0.45) {
    refined.inputGain = Math.min(refined.inputGain ?? -3.5, -5);
    refined.truePeakCeiling = Math.min(refined.truePeakCeiling ?? -1, -1.5);
    refined.targetLufs = Math.min(refined.targetLufs ?? -12, -12.5);
    refined.limiterCharacter = 'transparent';
    refined.glueCompression = false;
  }

  if (codecStress > 0.42) {
    refined.aiIntensity = Math.min(refined.aiIntensity ?? 100, 100);
    refined.sibilanceProtection = Math.max(refined.sibilanceProtection ?? 65, 80);
    refined.artifactProtection = Math.max(refined.artifactProtection ?? 70, 85);
    refined.limiterCharacter = 'transparent';
    refined.addAir = false;
    refined.addPunch = false;
    refined.tapeWarmth = false;
    refined.glueCompression = false;
  }

  if (percussiveArtifactRisk) {
    refined.aiIntensity = Math.min(refined.aiIntensity ?? 100, 100);
    refined.sibilanceProtection = Math.max(refined.sibilanceProtection ?? 65, 78);
    refined.artifactProtection = Math.max(refined.artifactProtection ?? 70, 82);
    refined.targetLufs = -14;
    refined.truePeakCeiling = Math.min(refined.truePeakCeiling ?? -1, -1.5);
    refined.limiterCharacter = 'transparent';
    refined.addAir = false;
    refined.addPunch = false;
    refined.tapeWarmth = false;
    refined.glueCompression = false;
  }

  if (artifactRescueRisk) {
    refined.aiIntensity = Math.min(refined.aiIntensity ?? 100, 95);
    refined.sibilanceProtection = Math.max(refined.sibilanceProtection ?? 65, 80);
    refined.artifactProtection = Math.max(refined.artifactProtection ?? 70, 90);
    refined.targetLufs = -14;
    refined.truePeakCeiling = Math.min(refined.truePeakCeiling ?? -1, -1.5);
    refined.limiterCharacter = 'transparent';
    refined.addAir = false;
    refined.addPunch = false;
    refined.tapeWarmth = false;
    refined.glueCompression = false;
  }

  if (darkButSafe && !isLossy && !isLowBitrate && !refined.rescueMode) {
    refined.aiProfile = refined.aiProfile === 'auto' ? 'clarity' : refined.aiProfile;
    refined.addAir = true;
    refined.artifactProtection = Math.min(refined.artifactProtection ?? 75, 75);
    refined.sibilanceProtection = Math.min(refined.sibilanceProtection ?? 70, 75);
  }

  if (muddyOrVeiled) {
    refined.cutMud = true;
  }

  if (stereoRisk > 0.75) {
    refined.stereoWidth = Math.min(refined.stereoWidth ?? 100, 95);
    refined.centerBass = true;
  }

  return refined;
}

function applyReferenceTargetDefaults(defaults) {
  const referenceAnalysis = getCurrentSettings().referenceAnalysis;
  if (!referenceAnalysis) return defaults;

  const refined = { ...defaults };
  const refLufs = referenceAnalysis.lufs;
  if (Number.isFinite(refLufs)) {
    const safeReferenceTarget = Math.max(-13.5, Math.min(-10.5, refLufs));
    refined.targetLufs = Math.min(refined.targetLufs ?? -12, safeReferenceTarget);
  }

  const refStereo = referenceAnalysis.stereo;
  if (refStereo) {
    const refIsWideButStable = refStereo.sideToMidDB < -7 && refStereo.correlation > 0.25;
    const refIsRisky = getStereoRisk(referenceAnalysis) > 0.65;
    if (refIsWideButStable && !refIsRisky) {
      refined.stereoWidth = Math.min(108, Math.max(refined.stereoWidth ?? 100, 104));
    } else if (refIsRisky) {
      refined.stereoWidth = Math.min(refined.stereoWidth ?? 100, 96);
    }
  }

  refined.referenceAmount = Math.min(refined.referenceAmount ?? 65, 70);
  return refined;
}

function applyModeDefaults(defaults, options = {}) {
  const baseDefaults = options.referenceTarget
    ? applyReferenceTargetDefaults({ ...AI_MODE_DEFAULTS.auto, ...defaults })
    : { ...AI_MODE_DEFAULTS.auto, ...defaults };
  const merged = refineModeDefaultsForCurrentSource(baseDefaults);
  aiEnhance.checked = options.aiEnhance ?? true;
  normalizeLoudness.checked = true;
  truePeakLimit.checked = true;
  cleanLowEnd.checked = merged.cleanLowEnd;
  glueCompression.checked = merged.glueCompression;
  deharsh.checked = merged.deharsh;
  centerBass.checked = merged.centerBass;
  autoLevel.checked = merged.autoLevel;
  aiProfile.value = merged.aiProfile;
  aiIntensity.value = String(merged.aiIntensity);
  sibilanceProtection.value = String(merged.sibilanceProtection);
  artifactProtection.value = String(merged.artifactProtection);
  referenceAmount.value = String(merged.referenceAmount);
  setTargetLufsControl(merged.targetLufs);
  if (faders.inputGain && Number.isFinite(merged.inputGain)) {
    faders.inputGain.setValue(merged.inputGain, true);
  }
  if (faders.ceiling && Number.isFinite(merged.truePeakCeiling)) {
    faders.ceiling.setValue(merged.truePeakCeiling, true);
  }
  limiterCharacter.value = merged.limiterCharacter;
  addPunch.checked = merged.addPunch;
  tapeWarmth.checked = merged.tapeWarmth;
  addAir.checked = merged.addAir;
  cutMud.checked = merged.cutMud;
  stereoWidthSlider.value = String(merged.stereoWidth);
  if (options.resetEQ !== false) {
    resetEQToFlat();
  }
  updateSliderLabels();
}

function applyAIAutoRecommendation(analysis, source = {}, options = {}) {
  if (!analysis || (!options.force && getActiveAssistantPresetName() !== 'ai-auto')) return null;

  const recommendation = options.recommendation || getAIMasteringRecommendation(analysis, source);
  fileState.aiAutoRecommendation = recommendation;

  aiEnhance.checked = true;
  aiProfile.value = 'auto';
  normalizeLoudness.checked = true;
  truePeakLimit.checked = true;
  cleanLowEnd.checked = recommendation.cleanLowEnd;
  glueCompression.checked = recommendation.glueCompression;
  deharsh.checked = recommendation.deharsh;
  centerBass.checked = recommendation.centerBass;
  autoLevel.checked = recommendation.autoLevel;
  addPunch.checked = recommendation.addPunch;
  addAir.checked = recommendation.addAir;
  cutMud.checked = recommendation.cutMud;
  tapeWarmth.checked = recommendation.tapeWarmth;
  limiterCharacter.value = recommendation.limiterCharacter;
  aiIntensity.value = String(recommendation.aiIntensity);
  sibilanceProtection.value = String(recommendation.sibilanceProtection);
  artifactProtection.value = String(recommendation.artifactProtection);
  referenceAmount.value = String(recommendation.referenceAmount);
  stereoWidthSlider.value = String(recommendation.stereoWidth);
  setTargetLufsControl(recommendation.targetLufs);

  if (faders.inputGain) {
    faders.inputGain.setValue(recommendation.inputGain, true);
  }
  if (faders.ceiling) {
    faders.ceiling.setValue(recommendation.truePeakCeiling, true);
  }

  resetEQToFlat();
  updateSliderLabels();
  updateChecklist();
  console.log('[AI Auto] Applied analysis recommendation:', recommendation);
  return recommendation;
}

function getArtifactSafeRecommendation(analysis, source = {}) {
  const base = getAIMasteringRecommendation(analysis, source);
  const peaks = analysis?.peaks || {};
  const spikeRisk = Math.max(0, ((peaks.spikeDensity ?? 0) - 0.0008) * 180);
  const limiterRisk = analysis?.limiterRisk ?? 0;
  const codecStress = analysis?.codecStress ?? 0;
  const rescueBoost = Math.max(spikeRisk, limiterRisk, codecStress);
  return {
    ...base,
    rescueMode: true,
    aiProfile: base.profile || 'clean',
    aiIntensity: Math.min(base.aiIntensity ?? 100, rescueBoost > 0.45 ? 85 : 90),
    sibilanceProtection: Math.max(base.sibilanceProtection ?? 75, 85),
    artifactProtection: Math.max(base.artifactProtection ?? 80, rescueBoost > 0.45 ? 95 : 90),
    inputGain: Math.min(base.inputGain ?? -3.5, -5.5),
    truePeakCeiling: Math.min(base.truePeakCeiling ?? -1, -1.5),
    targetLufs: Math.min(base.targetLufs ?? -12, -14),
    limiterCharacter: 'transparent',
    addPunch: false,
    tapeWarmth: false,
    addAir: false,
    glueCompression: false,
    autoLevel: false,
    referenceAmount: Math.min(base.referenceAmount ?? 65, 55),
    cleanLowEnd: true,
    centerBass: true,
    deharsh: true,
    cutMud: true,
    stereoWidth: Math.min(base.stereoWidth ?? 100, 98)
  };
}

function getCurrentSourceDescriptor() {
  const currentName = currentFile?.name || fileState.selectedFilePath || '';
  return {
    bitrateKbps: fileState.estimatedBitrateKbps,
    isLossy: /\.(mp3|aac|m4a|mp4|ogg|wma|amr)$/i.test(currentName)
  };
}

function applySourceSafeGain() {
  if (!fileState.aiAnalysis) {
    showToast('Upload a song first so Auto Gain can analyze it.', 'error');
    return;
  }

  const recommendation = getAIMasteringRecommendation(fileState.aiAnalysis, getCurrentSourceDescriptor());
  setTargetLufsControl(recommendation.targetLufs);
  limiterCharacter.value = recommendation.limiterCharacter;
  truePeakLimit.checked = true;
  cleanLowEnd.checked = recommendation.cleanLowEnd;
  centerBass.checked = recommendation.centerBass;
  cutMud.checked = recommendation.cutMud;
  sibilanceProtection.value = String(recommendation.sibilanceProtection);
  artifactProtection.value = String(recommendation.artifactProtection);
  if (faders.inputGain) {
    faders.inputGain.setValue(recommendation.inputGain, true);
  }
  if (faders.ceiling) {
    faders.ceiling.setValue(recommendation.truePeakCeiling, true);
  }
  updateSliderLabels();
  markCustomPreset();
  schedulePreviewUpdate({ immediate: playerState.isPlaying && !playerState.isBypassed });
  updateChecklist();
  showToast('Auto Gain applied from source analysis.', 'success', 1800);
}

function resetMasteringFromAnalysis(options = {}) {
  const { reanalyze = false, toast = false } = options;

  if (!fileState.originalBuffer) {
    showToast('Upload a song first so AI Auto can analyze it.', 'error');
    return null;
  }

  if (reanalyze || !fileState.aiAnalysis) {
    fileState.aiAnalysis = analyzeAIGeneratedMastering(fileState.originalBuffer);
    fileState.aiAutoRecommendation = null;
  }

  clearReferenceState();
  setAssistantPresetActive('ai-auto');

  const recommendation = applyAIAutoRecommendation(
    fileState.aiAnalysis,
    getCurrentSourceDescriptor(),
    { force: true }
  );

  schedulePreviewUpdate({ immediate: playerState.isPlaying && !playerState.isBypassed });
  updateOutputPresetButtons(outputPresets);
  updateChecklist();

  if (toast) {
    showToast(
      reanalyze ? 'Analyzed again and reset to AI Auto defaults.' : 'Reset to latest AI Auto defaults.',
      'success',
      1800
    );
  }

  return recommendation;
}

function applyAssistantPreset(name) {
  if (name === 'manual') {
    referenceMatch.checked = false;
    applyModeDefaults(AI_MODE_DEFAULTS.manual, { aiEnhance: false });
    setAssistantPresetActive('manual');
    schedulePreviewUpdate({ immediate: playerState.isPlaying && !playerState.isBypassed });
    updateOutputPresetButtons(outputPresets);
    updateChecklist();
    return;
  }

  if (name === 'reference' && referenceName.textContent === 'No reference') {
    referenceMatch.checked = false;
    selectReferenceBtn.click();
    updateChecklist();
    return;
  }

  if (name === 'ai-auto' && fileState.aiAnalysis) {
    setAssistantPresetActive('ai-auto');
    applyAIAutoRecommendation(
      fileState.aiAnalysis,
      getCurrentSourceDescriptor(),
      { force: true }
    );
    referenceMatch.checked = false;
    schedulePreviewUpdate({ immediate: playerState.isPlaying && !playerState.isBypassed });
    updateOutputPresetButtons(outputPresets);
    updateChecklist();
    return;
  }

  if (name === 'ai-clean') {
    applyModeDefaults(AI_MODE_DEFAULTS.clean);
    referenceMatch.checked = false;
  } else if (name === 'artifact-safe') {
    const analysisDefaults = fileState.aiAnalysis
      ? getArtifactSafeRecommendation(fileState.aiAnalysis, getCurrentSourceDescriptor())
      : AI_MODE_DEFAULTS.artifactSafe;
    applyModeDefaults(analysisDefaults);
    referenceMatch.checked = false;
  } else if (name === 'ai-loud') {
    applyModeDefaults(AI_MODE_DEFAULTS.loud);
    referenceMatch.checked = false;
  } else if (name === 'reference') {
    applyModeDefaults(AI_MODE_DEFAULTS.reference, { referenceTarget: true });
    referenceMatch.checked = true;
  } else {
    applyModeDefaults(AI_MODE_DEFAULTS.auto);
    referenceMatch.checked = false;
  }

  setAssistantPresetActive(name);
  schedulePreviewUpdate({ immediate: playerState.isPlaying && !playerState.isBypassed });
  updateOutputPresetButtons(outputPresets);
  updateChecklist();
}

function applyAIProfileSelectionDefaults() {
  const selectedProfile = aiProfile.value || 'auto';

  if (selectedProfile === 'auto' && fileState.aiAnalysis) {
    applyAssistantPreset('ai-auto');
    return;
  }

  const defaults = AI_MODE_DEFAULTS[selectedProfile] || AI_MODE_DEFAULTS.auto;
  referenceMatch.checked = false;
  applyModeDefaults(defaults);

  if (selectedProfile === 'clean') {
    setAssistantPresetActive('ai-clean');
  } else if (selectedProfile === 'loud') {
    setAssistantPresetActive('ai-loud');
  } else if (selectedProfile === 'auto') {
    setAssistantPresetActive('ai-auto');
  } else {
    setAssistantPresetActive('custom');
  }

  schedulePreviewUpdate({ immediate: playerState.isPlaying && !playerState.isBypassed });
  updateOutputPresetButtons(outputPresets);
  updateChecklist();
}

// Special handling for normalizeLoudness to switch buffers
normalizeLoudness.addEventListener('change', () => {
  if (normalizeLoudness.checked) {
    // Switch to normalized buffer if available
    if (fileState.normalizedBuffer) {
      audioNodes.buffer = fileState.normalizedBuffer;
      console.log('[Normalize] Switched to normalized buffer');
    }
  } else {
    // Switch back to original buffer
    if (fileState.originalBuffer) {
      audioNodes.buffer = fileState.originalBuffer;
      console.log('[Normalize] Switched to original buffer');
    }
  }
  updateAudioChain({ immediate: playerState.isPlaying && !playerState.isBypassed });
  updateChecklist();
});

[truePeakLimit, limiterCharacter, cleanLowEnd, glueCompression, centerBass, cutMud, autoLevel].forEach(el => {
  el.addEventListener('change', () => {
    updateAudioChain({ immediate: playerState.isPlaying && !playerState.isBypassed });
    updateChecklist();
  });
});

advancedMode.addEventListener('change', () => {
  setAdvancedMode(advancedMode.checked);
});

assistantPresetButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.masteringPreset === 'custom') return;
    applyAssistantPreset(btn.dataset.masteringPreset);
  });
});

// Deharsh, Exciter (Add Air), Tape Warmth, and Multiband Transient (Add Punch) require re-processing the buffer
// These are applied offline for preview/export parity
[deharsh, aiEnhance, addAir, tapeWarmth, addPunch].forEach(el => {
  el.addEventListener('change', () => {
    markCustomPreset();
    processEffects();
    updateChecklist();
  });
});

aiProfile.addEventListener('change', () => {
  applyAIProfileSelectionDefaults();
});

autoGainBtn?.addEventListener('click', () => {
  applySourceSafeGain();
});

resetMasteringBtn?.addEventListener('click', () => {
  resetMasteringFromAnalysis({ toast: true });
});

reanalyzeBtn?.addEventListener('click', () => {
  resetMasteringFromAnalysis({ reanalyze: true, toast: true });
});

clearSessionBtn?.addEventListener('click', () => {
  clearCurrentSession({ toast: true });
});

topResetMasteringBtn?.addEventListener('click', () => {
  resetMasteringFromAnalysis({ toast: true });
});

topReanalyzeBtn?.addEventListener('click', () => {
  resetMasteringFromAnalysis({ reanalyze: true, toast: true });
});

topClearBtn?.addEventListener('click', () => {
  clearCurrentSession({ toast: true });
});

topNoneBtn?.addEventListener('click', () => {
  applyAssistantPreset('manual');
  showToast('Automatic mastering cleared. Manual/None is active.', 'success', 1800);
});

analysisActionValue?.addEventListener('click', () => {
  applyAnalysisAction();
});

aiIntensity.addEventListener('input', () => {
  aiIntensityValue.textContent = `${aiIntensity.value}%`;
  markCustomPreset();
  if (playerState.isPlaying && !playerState.isBypassed) {
    schedulePreviewUpdate({ delayMs: LIVE_PREVIEW_RENDER_DEBOUNCE_MS });
  }
});

aiIntensity.addEventListener('change', () => {
  schedulePreviewUpdate({ immediate: playerState.isPlaying && !playerState.isBypassed });
  updateChecklist();
});

sibilanceProtection.addEventListener('input', () => {
  sibilanceProtectionValue.textContent = `${sibilanceProtection.value}%`;
  markCustomPreset();
  if (playerState.isPlaying && !playerState.isBypassed) {
    schedulePreviewUpdate({ delayMs: LIVE_PREVIEW_RENDER_DEBOUNCE_MS });
  }
});

sibilanceProtection.addEventListener('change', () => {
  schedulePreviewUpdate({ immediate: playerState.isPlaying && !playerState.isBypassed });
  updateChecklist();
});

artifactProtection.addEventListener('input', () => {
  artifactProtectionValue.textContent = `${artifactProtection.value}%`;
  markCustomPreset();
  if (playerState.isPlaying && !playerState.isBypassed) {
    schedulePreviewUpdate({ delayMs: LIVE_PREVIEW_RENDER_DEBOUNCE_MS });
  }
});

artifactProtection.addEventListener('change', () => {
  schedulePreviewUpdate({ immediate: playerState.isPlaying && !playerState.isBypassed });
  updateChecklist();
});

referenceMatch.addEventListener('change', () => {
  if (referenceMatch.checked && referenceName.textContent === 'No reference') {
    referenceMatch.checked = false;
    selectReferenceBtn.click();
    updateChecklist();
    return;
  }
  setAssistantPresetActive(referenceMatch.checked ? 'reference' : 'custom');
  schedulePreviewUpdate({ immediate: playerState.isPlaying && !playerState.isBypassed });
  updateChecklist();
});

referenceAmount.addEventListener('input', () => {
  referenceAmountValue.textContent = `${referenceAmount.value}%`;
  setAssistantPresetActive(referenceMatch.checked && referenceName.textContent !== 'No reference' ? 'reference' : 'custom');
  if (playerState.isPlaying && !playerState.isBypassed) {
    schedulePreviewUpdate({ delayMs: LIVE_PREVIEW_RENDER_DEBOUNCE_MS });
  }
});

referenceAmount.addEventListener('change', () => {
  schedulePreviewUpdate({ immediate: playerState.isPlaying && !playerState.isBypassed });
  updateChecklist();
});

// truePeakSlider event listener removed - now using ceiling fader

const levelMatchBtn = document.getElementById('levelMatchBtn');
function syncLevelMatchControls(sourceChecked) {
  levelMatchBtn.checked = sourceChecked;
  if (levelMatchPanel) levelMatchPanel.checked = sourceChecked;
  updateChecklist();
}

levelMatchBtn.addEventListener('change', () => {
  syncLevelMatchControls(levelMatchBtn.checked);
  if (playerState.isBypassed && playerState.isPlaying) {
    // Restart playback to switch buffers
    const currentTime = audioNodes.context.currentTime - playerState.startTime;
    playerState.pauseTime = currentTime;
    playAudio();
  }
});

levelMatchPanel?.addEventListener('change', () => {
  syncLevelMatchControls(levelMatchPanel.checked);
  if (playerState.isBypassed && playerState.isPlaying) {
    const currentTime = audioNodes.context.currentTime - playerState.startTime;
    playerState.pauseTime = currentTime;
    playAudio();
  }
});

stereoWidthSlider.addEventListener('input', () => {
  stereoWidthValue.textContent = `${stereoWidthSlider.value}%`;
  updateStereoWidth();
  // Live node update while dragging; defer cache rebuild to interaction commit.
  updateAudioChain({ scheduleCache: false });
});

stereoWidthSlider.addEventListener('change', () => {
  updateAudioChain({ immediate: playerState.isPlaying && !playerState.isBypassed });
});

// Target LUFS slider with debounced re-normalization
let lufsDebounceTimeout = null;
let isRenormalizing = false;

async function renormalizeAudio(newTargetLufs) {
  // Only re-normalize if we have an original buffer and normalization is enabled
  if (!fileState.originalBuffer || !normalizeLoudness.checked) {
    return;
  }

  // Prevent concurrent re-normalization
  if (isRenormalizing) {
    return;
  }
  isRenormalizing = true;

  try {
    // Keep loudness changes non-blocking. Export/cache rendering uses the original
    // buffer and final LUFS target; this background buffer only keeps level-matched
    // bypass and live fallback close to the selected target.
    await new Promise(resolve => setTimeout(resolve, 0));

    // Re-normalize to new target. Lossy/piano-risk sources use peak-safe gain only;
    // limiter-based loudness normalization can create the metallic piano artifacts.
    let normalizedBuffer;
    const lossySource = isCurrentArtifactSafeSource();
    if (lossySource) {
      const currentLufs = Number.isFinite(fileState.originalLufs)
        ? fileState.originalLufs
        : measureLUFS(fileState.originalBuffer);
      const currentPeak = Number.isFinite(fileState.originalTruePeak)
        ? fileState.originalTruePeak
        : findTruePeak(fileState.originalBuffer);
      const rescuePreviewMode = Number(artifactProtection?.value || 0) >= 85;
      const safeTarget = Math.min(newTargetLufs, rescuePreviewMode ? -14 : -14.5);
      const desiredGainDB = Number.isFinite(currentLufs) ? safeTarget - currentLufs : 0;
      const peakSafeGainDB = -1.8 - currentPeak;
      normalizedBuffer = applyGain(fileState.originalBuffer, Math.min(desiredGainDB, peakSafeGainDB));
      newTargetLufs = safeTarget;
    } else {
      normalizedBuffer = normalizeToLUFS(fileState.originalBuffer, newTargetLufs);
    }

    // Update normalized buffer
    fileState.normalizedBuffer = normalizedBuffer;
    fileState.normalizedTargetLufs = newTargetLufs;

    schedulePreviewUpdate({ immediate: playerState.isPlaying && !playerState.isBypassed });

  } catch (error) {
    console.error('Re-normalization failed:', error);
    showToast(`Normalization failed: ${error.message}`, 'error');
  } finally {
    isRenormalizing = false;
  }
}

targetLufsSlider.addEventListener('input', () => {
  const newValue = parseFloat(targetLufsSlider.value);

  // Update display immediately
  setTargetLufs(newValue);
  targetLufsValue.textContent = `${newValue} LUFS`;
  markCustomPreset();
  updateControlPanelSummary();

  if (lufsDebounceTimeout) {
    clearTimeout(lufsDebounceTimeout);
    lufsDebounceTimeout = null;
  }

  schedulePreviewUpdate({ delayMs: LIVE_PREVIEW_RENDER_DEBOUNCE_MS });

  // Debounce level-match buffer refresh; the audible/export chain reacts via cache render.
  lufsDebounceTimeout = setTimeout(() => {
    renormalizeAudio(newValue);
  }, 500); // 500ms debounce
});

[sampleRate, bitDepth].forEach(el => {
  el.addEventListener('change', () => {
    updateDitherControlState();
    updateOutputPresetButtons(outputPresets);
    updateExportFormatSummary();
    clearExportQualitySummary();
  });
});

// ============================================================================
// Tooltip System
// ============================================================================

const tooltip = document.getElementById('tooltip');
const showTipsCheckbox = document.getElementById('showTips');
let tooltipTimeout = null;

const savedTipsPref = localStorage.getItem('showTips');
if (savedTipsPref !== null) {
  showTipsCheckbox.checked = savedTipsPref === 'true';
}

showTipsCheckbox.addEventListener('change', () => {
  localStorage.setItem('showTips', showTipsCheckbox.checked);
  if (!showTipsCheckbox.checked) {
    tooltip.classList.remove('visible');
  }
});

document.querySelectorAll('[data-tip]').forEach(el => {
  el.addEventListener('mouseenter', () => {
    if (!showTipsCheckbox.checked) return;

    const tipText = el.getAttribute('data-tip');
    if (!tipText) return;

    clearTimeout(tooltipTimeout);
    tooltipTimeout = setTimeout(() => {
      tooltip.textContent = tipText;

      const rect = el.getBoundingClientRect();
      let left = rect.left;
      let top = rect.bottom + 8;

      tooltip.style.left = '0px';
      tooltip.style.top = '0px';
      tooltip.classList.add('visible');

      const tooltipRect = tooltip.getBoundingClientRect();

      if (left + tooltipRect.width > window.innerWidth - 20) {
        left = window.innerWidth - tooltipRect.width - 20;
      }
      if (top + tooltipRect.height > window.innerHeight - 20) {
        top = rect.top - tooltipRect.height - 8;
      }

      tooltip.style.left = `${Math.max(10, left)}px`;
      tooltip.style.top = `${top}px`;
    }, 400);
  });

  el.addEventListener('mouseleave', () => {
    clearTimeout(tooltipTimeout);
    tooltip.classList.remove('visible');
  });
});

// ============================================================================
// Window Cleanup - prevent resource leaks on close
// ============================================================================

window.addEventListener('beforeunload', () => {
  // Stop level meter animation
  if (meterState.animationId) {
    cancelAnimationFrame(meterState.animationId);
    meterState.animationId = null;
  }

  // Clear seek update interval
  if (playerState.seekUpdateInterval) {
    clearInterval(playerState.seekUpdateInterval);
    playerState.seekUpdateInterval = null;
  }

  // Stop audio playback
  if (audioNodes.source) {
    try {
      audioNodes.source.stop();
    } catch (e) { /* ignore */ }
  }

  // Destroy WaveSurfer
  destroyWaveSurfer();

  // Destroy faders
  Object.keys(faders).forEach(key => {
    if (faders[key] && typeof faders[key].destroy === 'function') {
      try {
        faders[key].destroy();
      } catch (e) { /* ignore */ }
    }
    faders[key] = null;
  });

  // Close AudioContext
  if (audioNodes.context && audioNodes.context.state !== 'closed') {
    try {
      audioNodes.context.close();
    } catch (e) { /* ignore */ }
  }
});

// ============================================================================
// Initialize
// ============================================================================

// Initialize faders with callbacks that wire to audio chain
initFaders({
  onInputGainChange: (val) => {
    updateInputGain();
    updateControlPanelSummary();
    // Keep live chain responsive while dragging; defer cache rebuild to commit.
    updateAudioChain({ scheduleCache: false });
  },
  onInputGainChangeEnd: () => {
    updateAudioChain({ immediate: playerState.isPlaying && !playerState.isBypassed });
  },
  onCeilingChange: () => {
    updateControlPanelSummary();
    // Live preview updates immediately; defer cache rebuild to commit.
    updateAudioChain({ scheduleCache: false });
  },
  onCeilingChangeEnd: () => {
    updateAudioChain({ immediate: playerState.isPlaying && !playerState.isBypassed });
  },
  onEQChange: (eqVals) => {
    markCustomPreset();
    updateEQ();
    updateControlPanelSummary();
    // Keep live chain responsive while dragging; defer cache rebuild to commit.
    updateAudioChain({ scheduleCache: false });
  },
  onEQChangeEnd: () => {
    updateAudioChain({ immediate: playerState.isPlaying && !playerState.isBypassed });
  }
});

// Setup EQ presets with callback
setupEQPresets(eqPresets, () => {
  markCustomPreset();
  updateEQ();
  updateControlPanelSummary();
  updateAudioChain({ immediate: playerState.isPlaying && !playerState.isBypassed });
});

// Setup output format presets
setupOutputPresets(outputPresets, () => {
  updateDitherControlState();
  updateOutputPresetButtons(outputPresets);
  updateExportFormatSummary();
  clearExportQualitySummary();
});
updateDitherControlState();
updateOutputPresetButtons(outputPresets);
updateExportFormatSummary();

setAdvancedMode(false);
updateSliderLabels();
updateChecklist();

// Initialize DSP worker for off-main-thread processing
initDSPWorker().then(() => {
  console.log('[App] DSP Worker initialized');
}).catch(err => {
  console.warn('[App] DSP Worker initialization failed, falling back to main thread:', err);
});
