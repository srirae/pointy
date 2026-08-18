import {
  askScreen,
  locateTarget,
  type AskReply,
  type ChatTurn,
  type ClickTarget,
} from "@/lib/pointy";

export type ScreenAskReply = AskReply;

/** Where the glow should go, in fractions of the whole desktop. */
export type PointSpot = { target: ClickTarget };

/** Move a box from shot-relative fractions to screen-relative fractions. */
export function targetToScreen(
  target: ClickTarget,
  frame: { x: number; y: number; w: number; h: number },
): ClickTarget {
  return {
    ...target,
    x: frame.x + target.x * frame.w,
    y: frame.y + target.y * frame.h,
    w: target.w * frame.w,
    h: target.h * frame.h,
  };
}

/**
 * Ask OpenRouter via Rust. The screenshot is captured, downscaled and sent from
 * the backend in one hop — the reply carries the shot's monitor fractions so the
 * target box can be mapped back onto the full screen.
 */
export async function askAboutScreen(
  question: string,
  windowId: number | null,
  app: string | null,
  history: ChatTurn[] = [],
  signal?: AbortSignal,
): Promise<ScreenAskReply> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return askScreen(question, windowId, app, history);
}

/**
 * Find where a control sits *now*, for the moment "point it" is pressed.
 *
 * The box that came back with the answer describes a screenshot that may be
 * seconds old; if the user has scrolled or moved the window since, glowing it
 * would frame the wrong thing. The accessibility tree is read live, so it stays
 * correct. When the control can't be found (custom-drawn UI, no tree), the
 * answer-time box is the honest fallback.
 */
export async function locatePoint(
  label: string,
  windowId: number | null,
  fallback: PointSpot,
): Promise<PointSpot> {
  try {
    const found = await locateTarget(label, windowId, fallback.target);
    if (found) return { target: found.target };
  } catch {
    // A failed tree read is not worth an error message: the older box is still
    // roughly right, and pointing somewhere is better than refusing to point.
  }
  return fallback;
}
