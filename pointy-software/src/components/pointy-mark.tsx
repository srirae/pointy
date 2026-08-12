/**
 * Wordmark glyph: the guide-dot inside a target ring. Deliberately the product's own
 * motif rather than a generic assistant orb.
 */
export function PointyMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9.25" stroke="var(--forest)" strokeWidth="1.5" opacity="0.35" />
      <circle cx="12" cy="12" r="5" stroke="var(--forest)" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="2.25" fill="var(--signal)" />
    </svg>
  );
}
