import { AnimatePresence, motion } from "motion/react";

/**
 * The pointing gesture, in miniature.
 *
 * This is the onboarding version of Pointy's actual output: an arrow that swings in and
 * lands a dot on one specific element. Colour is Signal Ochre — the saturated end of
 * the palette, chosen because the real overlay has to stay legible on top of whatever
 * is on screen.
 */
export function GuideArrow({ visible }: { visible: boolean }) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          aria-hidden
          initial={{ opacity: 0, x: -22, y: -14, rotate: -6 }}
          animate={{ opacity: 1, x: 0, y: 0, rotate: 0 }}
          exit={{ opacity: 0, x: -14, y: -8, transition: { duration: 0.22, ease: "easeOut" } }}
          transition={{ type: "spring", stiffness: 420, damping: 26, mass: 0.7 }}
          className="pointer-events-none absolute top-1/2 right-[calc(100%+0.5rem)] -translate-y-1/2"
        >
          <svg width="132" height="56" viewBox="0 0 132 56" fill="none">
            <motion.path
              d="M6 12C26 6 52 8 74 20C88 27.5 98 33 116 36"
              stroke="var(--signal)"
              strokeWidth="3"
              strokeLinecap="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.28, ease: "easeOut" }}
            />
            <motion.path
              d="M104 26L118 36.5L102 44"
              stroke="var(--signal)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2, duration: 0.16 }}
            />
          </svg>

          {/* The guide-dot itself, sitting where the arrow lands. */}
          <motion.span
            className="absolute top-[36px] right-[2px] block size-3 rounded-full bg-signal"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.26, type: "spring", stiffness: 500, damping: 18 }}
          >
            <motion.span
              className="absolute inset-0 rounded-full bg-signal"
              animate={{ scale: [1, 2.1], opacity: [0.55, 0] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
            />
          </motion.span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
