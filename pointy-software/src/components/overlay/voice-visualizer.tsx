import { motion } from "motion/react";

/**
 * The pill's audio visualisation.
 *
 * The backend gives us five bands (see `audio::BANDS`), far too coarse to draw directly
 * — 24 bars over 5 values reads as five fat blocks. So the bars sample the band curve
 * with linear interpolation, mirrored around the centre: low frequencies in the middle,
 * highs at the edges. That symmetry is what makes it read as a voice rather than a
 * spectrum analyser.
 *
 * Two details do most of the work on how expensive this feels:
 *
 * * every bar keeps a floor height, so the row never breaks into gaps — it breathes as
 *   one shape;
 * * the springs are detuned slightly per bar (see `SPRING`), so neighbours do not snap
 *   in lockstep. Uniform springs are the tell of a cheap visualiser.
 */
const BAR_COUNT = 23;
const MIN_HEIGHT = 2;
const MAX_HEIGHT = 22;

/** Sample the band curve at 0..1 with linear interpolation between neighbours. */
function sampleBands(bands: number[], at: number): number {
  if (bands.length === 0) return 0;
  const position = at * (bands.length - 1);
  const low = Math.floor(position);
  const high = Math.min(low + 1, bands.length - 1);
  const mix = position - low;
  return (bands[low] ?? 0) * (1 - mix) + (bands[high] ?? 0) * mix;
}

/** Critically damped — reaches the target and stops. Nothing here should wobble. */
function spring(index: number) {
  return {
    type: "spring" as const,
    // Alternating stiffness by a few percent is enough to break lockstep without
    // reading as lag on any one bar.
    stiffness: 460 + (index % 3) * 28,
    damping: 30,
    mass: 0.4,
  };
}

export function VoiceVisualizer({ bands, level }: { bands: number[]; level: number }) {
  const center = (BAR_COUNT - 1) / 2;
  // Below the noise floor the bars would twitch on room hum. Hold them flat instead, so
  // silence looks like silence and the first syllable is unmistakable.
  const quiet = level < 0.04;

  return (
    <div className="flex h-[22px] items-center gap-[3px]">
      {Array.from({ length: BAR_COUNT }).map((_, index) => {
        const distance = Math.abs(index - center) / center;
        const band = quiet ? 0 : sampleBands(bands, distance);
        // Taper the outermost bars so the shape ends softly instead of being clipped.
        const taper = 0.42 + 0.58 * (1 - distance ** 2);
        const height = MIN_HEIGHT + band * taper * (MAX_HEIGHT - MIN_HEIGHT);

        return (
          <motion.span
            key={index}
            className="w-[2px] shrink-0 rounded-full"
            style={{
              // Nordic Ochre, warming towards Signal Ochre as the bar peaks. Painted as
              // a literal so the pill never inherits the light app theme.
              background: "linear-gradient(to top, #d9a865, #ffa61f)",
            }}
            initial={{ height: MIN_HEIGHT, opacity: 0.32 }}
            animate={{ height, opacity: 0.32 + band * 0.68 }}
            transition={spring(index)}
          />
        );
      })}
    </div>
  );
}
