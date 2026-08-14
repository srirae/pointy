import { askScreen, type AskReply, type ClickTarget } from "@/lib/pointy";

export type ScreenAskReply = AskReply;

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
  signal?: AbortSignal,
): Promise<ScreenAskReply> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return askScreen(question, windowId, app);
}
