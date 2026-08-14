import { askScreen, type ClickTarget, wakeSession } from "@/lib/pointy";

export type ScreenAskReply = {
  answer: string;
  advice: string;
  target: ClickTarget | null;
};

/** Shrink a PNG data URL so a 4K capture does not blow the vision request. */
export async function shrinkScreenshot(dataUrl: string, maxEdge = 1280): Promise<string> {
  if (!dataUrl.startsWith("data:image")) return dataUrl;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export async function waitForScreenshot(ms = 2800): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const session = await wakeSession();
      if (session.screenshot) return session.screenshot;
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 90));
  }
  return null;
}

/** Ask NVIDIA NIM via Rust so the `.env` key is actually used. */
export async function askAboutScreen(
  question: string,
  screenshot: string | null,
  signal?: AbortSignal,
): Promise<ScreenAskReply> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const image = screenshot ? await shrinkScreenshot(screenshot) : null;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return askScreen(question, image);
}
