/**
 * Controls Module
 * Manages all UI controls: sliders, toggles, faders, and settings state
 */

import { Fader } from '../components/Fader.js';

// ============================================================================
// State
// ============================================================================

// EQ values (managed by faders)
export const eqValues = {
  low: 0,
  lowMid: 0,
  mid: 0,
  highMid: 0,
  high: 0
};

// Input gain and ceiling values (managed by faders)
export const DEFAULT_INPUT_HEADROOM_DB = -3.5;
export const DEFAULT_CEILING_DB = -1;
export const DEFAULT_TARGET_LUFS = -12;
export let inputGainValue = DEFAULT_INPUT_HEADROOM_DB;  // dB
export let ceilingValueDb = DEFAULT_CEILING_DB; // dB
export let targetLufsDb = DEFAULT_TARGET_LUFS; // Target LUFS for normalization

// Fader instances
const faders = {
  inputGain: null,
  ceiling: null,
  eqLow: null,
  eqLowMid: null,
  eqMid: null,
  eqHighMid: null,
  eqHigh: null,
};

// ============================================================================
// DOM Elements
// ============================================================================

const normalizeLoudness = document.getElementById('normalizeLoudness');
const truePeakLimit = document.getElementById('truePeakLimit');
const limiterCharacter = document.getElementById('limiterCharacter');
const cleanLowEnd = document.getElementById('cleanLowEnd');
const glueCompression = document.getElementById('glueCompression');
const aiEnhance = document.getElementById('aiEnhance');
const aiProfile = document.getElementById('aiProfile');
const aiIntensity = document.getElementById('aiIntensity');
const sibilanceProtection = document.getElementById('sibilanceProtection');
const artifactProtection = document.getElementById('artifactProtection');
const referenceMatch = document.getElementById('referenceMatch');
const referenceAmount = document.getElementById('referenceAmount');
const deharsh = document.getElementById('deharsh');
const stereoWidthSlider = document.getElementById('stereoWidth');
const centerBass = document.getElementById('centerBass');
const cutMud = document.getElementById('cutMud');
const addAir = document.getElementById('addAir');
const tapeWarmth = document.getElementById('tapeWarmth');
const autoLevel = document.getElementById('autoLevel');
const addPunch = document.getElementById('addPunch');
const sampleRate = document.getElementById('sampleRate');
const bitDepth = document.getElementById('bitDepth');
const ditherNoiseShaping = document.getElementById('ditherNoiseShaping');
const targetLufsSlider = document.getElementById('targetLufs');

let referenceAnalysis = null;

export function setReferenceAnalysis(analysis) {
  referenceAnalysis = analysis || null;
}

// ============================================================================
// Settings Getters
// ============================================================================

/**
 * Get current settings from all UI controls
 * @returns {Object} Current settings object
 */
export function getCurrentSettings() {
  return {
    normalizeLoudness: normalizeLoudness.checked,
    targetLufs: parseFloat(targetLufsSlider.value),
    truePeakLimit: truePeakLimit.checked,
    limiterCharacter: limiterCharacter?.value || 'balanced',
    truePeakCeiling: ceilingValueDb,
    cleanLowEnd: cleanLowEnd.checked,
    glueCompression: glueCompression.checked,
    deharsh: deharsh.checked,
    stereoWidth: parseInt(stereoWidthSlider.value) || 100,
    centerBass: centerBass.checked,
    cutMud: cutMud.checked,
    addAir: addAir.checked,
    tapeWarmth: tapeWarmth.checked,
    autoLevel: autoLevel.checked,
    aiEnhance: aiEnhance?.checked ?? true,
    aiProfile: aiProfile?.value || 'auto',
    aiIntensity: (parseFloat(aiIntensity?.value) || 100) / 100,
    sibilanceProtection: (parseFloat(sibilanceProtection?.value) || 0) / 100,
    artifactProtection: (parseFloat(artifactProtection?.value) || 0) / 100,
    referenceMatch: referenceMatch?.checked ?? false,
    referenceAmount: (parseFloat(referenceAmount?.value) || 65) / 100,
    referenceAnalysis,
    addPunch: addPunch.checked,
    isLossySource: /\.(mp3|aac|m4a|mp4|ogg|wma|amr)$/i.test(window.__currentAudioFileName || ''),
    inputGain: inputGainValue,
    eqLow: eqValues.low,
    eqLowMid: eqValues.lowMid,
    eqMid: eqValues.mid,
    eqHighMid: eqValues.highMid,
    eqHigh: eqValues.high
  };
}

/**
 * Get export-specific settings (includes format options)
 * @returns {Object} Export settings object
 */
export function getExportSettings() {
  const base = getCurrentSettings();
  const selectedSampleRate = sampleRate.value === 'source' ? 'source' : parseInt(sampleRate.value) || 44100;
  return {
    ...base,
    sampleRate: selectedSampleRate,
    bitDepth: parseInt(bitDepth.value) || 16,
    ditherMode: (parseInt(bitDepth.value) || 16) === 16
      ? (ditherNoiseShaping?.checked ? 'noise-shaped' : 'tpdf')
      : 'none'
  };
}

// ============================================================================
// Fader Initialization
// ============================================================================

/**
 * Initialize all faders
 * @param {Object} callbacks - Callback functions for fader changes
 * @param {Function} callbacks.onInputGainChange - Called when input gain changes
 * @param {Function} callbacks.onInputGainChangeEnd - Called when input gain interaction commits
 * @param {Function} callbacks.onCeilingChange - Called when ceiling changes
 * @param {Function} callbacks.onCeilingChangeEnd - Called when ceiling interaction commits
 * @param {Function} callbacks.onEQChange - Called when any EQ fader changes
 * @param {Function} callbacks.onEQChangeEnd - Called when any EQ interaction commits
 */
export function initFaders(callbacks = {}) {
  // Destroy old faders before creating new ones (prevents memory leaks on re-init)
  Object.keys(faders).forEach(key => {
    if (faders[key] && typeof faders[key].destroy === 'function') {
      faders[key].destroy();
    }
    faders[key] = null;
  });

  // Input Gain Fader
  faders.inputGain = new Fader('#inputGainFader', {
    min: -12,
    max: 12,
    value: DEFAULT_INPUT_HEADROOM_DB,
    resetValue: DEFAULT_INPUT_HEADROOM_DB,
    step: 0.5,
    label: 'Input',
    unit: 'dB',
    orientation: 'vertical',
    height: 120,
    showScale: false,
    decimals: 1,
    onChange: (val) => {
      inputGainValue = val;
      if (callbacks.onInputGainChange) callbacks.onInputGainChange(val);
    },
    onChangeEnd: (val) => {
      if (callbacks.onInputGainChangeEnd) callbacks.onInputGainChangeEnd(val);
    }
  });

  // Ceiling Fader
  faders.ceiling = new Fader('#ceilingFader', {
    min: -6,
    max: 0,
    value: DEFAULT_CEILING_DB,
    resetValue: DEFAULT_CEILING_DB,
    step: 0.5,
    label: 'Ceiling',
    unit: 'dB',
    orientation: 'vertical',
    height: 120,
    showScale: false,
    decimals: 1,
    onChange: (val) => {
      ceilingValueDb = val;
      if (callbacks.onCeilingChange) callbacks.onCeilingChange(val);
    },
    onChangeEnd: (val) => {
      if (callbacks.onCeilingChangeEnd) callbacks.onCeilingChangeEnd(val);
    }
  });

  // EQ Faders
  const eqConfig = [
    { key: 'eqLow', selector: '#eqLowFader', label: '80Hz', stateKey: 'low' },
    { key: 'eqLowMid', selector: '#eqLowMidFader', label: '250Hz', stateKey: 'lowMid' },
    { key: 'eqMid', selector: '#eqMidFader', label: '1kHz', stateKey: 'mid' },
    { key: 'eqHighMid', selector: '#eqHighMidFader', label: '4kHz', stateKey: 'highMid' },
    { key: 'eqHigh', selector: '#eqHighFader', label: '12kHz', stateKey: 'high' }
  ];

  eqConfig.forEach(({ key, selector, label, stateKey }) => {
    faders[key] = new Fader(selector, {
      min: -12,
      max: 12,
      value: 0,
      resetValue: 0,
      step: 0.5,
      label: label,
      unit: 'dB',
      orientation: 'vertical',
      height: 120,
      showScale: false,
      decimals: 1,
      onChange: (val) => {
        eqValues[stateKey] = val;
        clearActivePreset();
        if (callbacks.onEQChange) callbacks.onEQChange(eqValues);
      },
      onChangeEnd: () => {
        if (callbacks.onEQChangeEnd) callbacks.onEQChangeEnd(eqValues);
      }
    });
  });
}

/**
 * Clear active preset button highlight
 */
export function clearActivePreset() {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
}

/**
 * Apply an EQ preset
 * @param {Object} preset - Preset values { low, lowMid, mid, highMid, high }
 * @param {Function} onEQChange - Callback when EQ changes
 */
export function applyEQPreset(preset, onEQChange) {
  // Update eqValues state
  eqValues.low = preset.low;
  eqValues.lowMid = preset.lowMid;
  eqValues.mid = preset.mid;
  eqValues.highMid = preset.highMid;
  eqValues.high = preset.high;

  // Update fader displays
  if (faders.eqLow) faders.eqLow.setValue(preset.low);
  if (faders.eqLowMid) faders.eqLowMid.setValue(preset.lowMid);
  if (faders.eqMid) faders.eqMid.setValue(preset.mid);
  if (faders.eqHighMid) faders.eqHighMid.setValue(preset.highMid);
  if (faders.eqHigh) faders.eqHigh.setValue(preset.high);

  if (onEQChange) onEQChange(eqValues);
}

/**
 * Set target LUFS value
 * @param {number} value - New target LUFS
 */
export function setTargetLufs(value) {
  targetLufsDb = value;
}

/**
 * Setup EQ preset buttons
 * @param {Object} presets - EQ presets object
 * @param {Function} onEQChange - Callback when EQ changes
 */
export function setupEQPresets(presets, onEQChange) {
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = presets[btn.dataset.preset];
      if (preset) {
        applyEQPreset(preset, onEQChange);
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    });
  });
}

/**
 * Setup output format preset buttons
 * @param {Object} presets - Output presets object
 * @param {Function} onPresetApplied - Optional callback after applying a preset
 */
export function setupOutputPresets(presets, onPresetApplied = null) {
  document.querySelectorAll('.output-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = presets[btn.dataset.preset];
      if (preset) {
        sampleRate.value = preset.sampleRate;
        bitDepth.value = preset.bitDepth;
        document.querySelectorAll('.output-preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (onPresetApplied) onPresetApplied(preset);
      }
    });
  });
}

/**
 * Update output preset button states based on current selection
 * @param {Object} presets - Output presets object
 */
export function updateOutputPresetButtons(presets) {
  const currentRate = sampleRate.value === 'source' ? 'source' : parseInt(sampleRate.value);
  const currentDepth = parseInt(bitDepth.value);

  document.querySelectorAll('.output-preset-btn').forEach(btn => {
    const preset = presets[btn.dataset.preset];
    const isMatch = preset && preset.sampleRate === currentRate && preset.bitDepth === currentDepth;
    btn.classList.toggle('active', isMatch);
  });
}

// ============================================================================
// Exports
// ============================================================================

export { faders };
