import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

const STEPS = [
  "Hiding the glass",
  "Reading your screen",
  "Finding the control",
  "Writing the steps",
];

/**
 * Stands in for the answer while NIM works. The composer already holds the
 * question, so this space shows progress instead of repeating what was asked.
 */
export function Thinking() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStep((current) => Math.min(current + 1, STEPS.length - 1));
    }, 1100);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="relative flex size-3.5 items-center justify-center">
          <motion.span
            className="absolute inset-0 rounded-full border-[1.5px] border-[#0d4a47]/25 border-t-[#ffa61f]"
            animate={{ rotate: 360 }}
            transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
          />
        </span>
        <AnimatePresence mode="wait">
          <motion.span
            key={step}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
            className="text-[0.8125rem] font-semibold tracking-[-0.01em] text-[#2e3a47]"
          >
            {STEPS[step]}
          </motion.span>
        </AnimatePresence>
      </div>

      {/* Scanning beam over a stand-in for the captured window. */}
      <div
        className="relative mt-2.5 h-11 overflow-hidden rounded-lg"
        style={{ background: "rgba(46,58,71,0.06)" }}
      >
        <div className="space-y-1.5 p-2">
          <Bar width="62%" delay={0} />
          <Bar width="84%" delay={0.12} />
          <Bar width="48%" delay={0.24} />
        </div>
        <motion.span
          className="absolute inset-y-0 w-16"
          style={{
            background:
              "linear-gradient(90deg, transparent, rgba(255,166,31,0.42), transparent)",
          }}
          animate={{ x: ["-4rem", "22rem"] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
    </div>
  );
}

function Bar({ width, delay }: { width: string; delay: number }) {
  return (
    <motion.span
      className="block h-1.5 rounded-full bg-[#2e3a47]/12"
      style={{ width }}
      animate={{ opacity: [0.35, 0.85, 0.35] }}
      transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut", delay }}
    />
  );
}
