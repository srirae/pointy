import { permissionsRequest, permissionsStatus } from "@/lib/pointy";

/**
 * Ask for microphone access and return whether it was granted.
 * Tries the OS permission probe first, then getUserMedia (the prompt the webview can raise).
 */
export async function requestMicrophoneAccess(): Promise<{ granted: boolean; error: string | null }> {
  try {
    const status = await permissionsRequest("microphone");
    if (status.state === "granted") return { granted: true, error: null };
  } catch {
    // Fall through to getUserMedia — that's the real browser/webview prompt.
  }

  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    const statuses = await permissionsStatus().catch(() => []);
    const mic = statuses.find((entry) => entry.id === "microphone");
    return {
      granted: mic?.state === "granted",
      error: mic?.state === "granted" ? null : "Microphone permission is required.",
    };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return { granted: true, error: null };
  } catch (reason) {
    return {
      granted: false,
      error:
        reason instanceof Error
          ? reason.message
          : "Microphone was blocked. Allow it in system settings, then try again.",
    };
  }
}
