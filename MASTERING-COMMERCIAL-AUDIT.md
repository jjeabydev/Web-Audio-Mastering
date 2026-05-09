# Commercial Mastering Audit

This audit tracks commercial mastering capabilities that are useful for this app's AI/MP3 mastering goal, and maps them to current implementation status.

## Sources Checked

- BandLab Mastering FAQ: presets, intensity, input gain/auto gain, headroom guidance.
  https://help.bandlab.com/hc/en-us/articles/55678885417113-BandLab-Mastering-FAQ
- BandLab mastering workflow: presets, input gain, intensity, export flow.
  https://help.bandlab.com/hc/en-us/articles/360001374513-Using-BandLab-Mastering-on-your-songs
- LANDR mastering styles: warm, balanced, open.
  https://support.landr.com/hc/en-us/articles/360019272934-What-are-Mastering-Styles
- LANDR mastering product page: revisions, album mastering, reference mastering, volume matching, streaming optimization.
  https://www.landr.com/mastering-styles
- LANDR reference mastering: reference tracks guide tonal balance and polish.
  https://www.landr.com/reference-mastering
- eMastered reference mastering: analyzes a reference track and applies comparable sonic processes.
  https://intercom.help/emastered/en/articles/2645102-what-is-reference-mastering
- Ozone Master Assistant: target curves, reference target, EQ matching, dynamics, Dynamic EQ before/after maximizer comparison.
  https://downloads.izotope.com/docs/ozone8/master-assistant/index.html
- Ozone Maximizer: true peak, character, stereo independence, transient emphasis, limiter response behavior.
  https://downloads.izotope.com/docs/ozone802/en/maximizer/index.html

## Current Strengths

- AI source repair: analyzes tonal balance and applies corrective EQ for mud, presence, harshness, sibilance, metallic ringing, and air.
- Reference Match: compares source/reference tonal profile and moves the master toward the reference.
- Live comparison: setting changes are heard quickly via live approximation, then replaced by full offline render.
- Loudness pipeline: target LUFS, true peak ceiling, soft clipper, limiter, final calibration.
- Commercial-style controls: Manual, AI Auto, AI Clean, AI Loud, Match Ref, intensity, sibilance, metallic protection, limiter character.
- Level matched preview: avoids judging louder as better.

## Improvements Applied

### Limiter Stress Guard

Commercial reference: Ozone Master Assistant places Dynamic EQ nodes where the maximizer/limiter is likely to create distortion.

Implemented equivalent:

- Runs after loudness normalization and before soft clip/true peak limiting.
- Detects low-end, mud, presence, harshness, metallic ringing, and excessive air pressure.
- Applies small corrective cuts before the limiter has to work too hard.
- Scales with target LUFS, AI intensity, and limiter character.

Expected benefit:

- Less crunchy high end at loud settings.
- Less bass-driven limiter pumping.
- More stable loudness without flattening the whole master.

### Stereo Stability Guard

Problem target: AI/MP3 masters can contain phasey side energy that sounds wide on headphones but loses focus on speakers or mono playback.

Implemented equivalent:

- Measures stereo correlation and side-to-mid energy.
- When side energy is excessive or correlation is risky, lightly reduces side level.
- High-passes the side channel so low-end stays centered.
- Runs only in AI mastering mode and only when the stereo image is risky.

Expected benefit:

- More stable vocal/lead center.
- Less glassy, phasey high-end spread.
- Better translation on phones, cars, mono speakers, and clubs.

## Next Improvement Candidates

1. Auto Headroom:
   Automatically set input gain so incoming peaks land around commercial pre-master headroom while preserving the current manual fader.

2. Codec Safety Preview:
   Detect masters that may clip after MP3/AAC encoding and suggest a lower ceiling or softer limiter character.

3. Revision Suggestions:
   After analysis, show simple recommendations such as "raise Metallic", "use AI Clean", or "lower target LUFS".

4. Album Consistency:
   Batch-level loudness and tonal consistency across multiple files, similar to album mastering workflows.

5. Better Reference Match:
   Analyze multiple reference tracks and average their tonal targets, similar to modern reference mastering workflows.
