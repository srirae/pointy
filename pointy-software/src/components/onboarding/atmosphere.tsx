import { motion } from "motion/react";

/**
 * Soft atmospheric field behind every setup step — depth without noise.
 * Signal ochre and forest wash in gently so the window never feels flat.
 */
export function Atmosphere() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-background" />
      <motion.div
        className="absolute -top-[28%] -left-[12%] h-[70%] w-[55%] rounded-full bg-forest/[0.06] blur-[90px]"
        animate={{ x: [0, 28, 0], y: [0, 18, 0] }}
        transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute -right-[18%] top-[8%] h-[55%] w-[50%] rounded-full bg-ochre/[0.11] blur-[100px]"
        animate={{ x: [0, -22, 0], y: [0, 30, 0] }}
        transition={{ duration: 22, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute bottom-[-20%] left-[30%] h-[45%] w-[45%] rounded-full bg-signal/[0.07] blur-[110px]"
        animate={{ scale: [1, 1.08, 1], opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 14, repeat: Infinity, ease: "easeInOut" }}
      />
      <div
        className="absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgb(46 58 71 / 0.06) 1px, transparent 0)",
          backgroundSize: "22px 22px",
        }}
      />
    </div>
  );
}
