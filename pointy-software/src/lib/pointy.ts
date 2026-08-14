/**
 * Typed bridge to the Rust backend. Every value here comes from a real OS query or a
 * live audio/keyboard stream — see src-tauri/src for the implementations.
 *
 * When the UI is opened outside the Tauri shell (Vite browser preview), commands
 * resolve through a local preview adapter so onboarding never throws raw invoke errors.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

import { isTauri } from "@/lib/tauri";
import { registerGlobalHotkey } from "@/lib/global-shortcut";

export type PermissionId = "microphone" | "screen" | "accessibility";
export type PermissionState = "granted" | "denied" | "prompt" | "unknown";

export interface PermissionStatus {
  id: PermissionId;
  state: PermissionState;
  detail: string;
  can_open_settings: boolean;
}

export interface Combo {
  keys: string[];
}

export interface Validation {
  valid: boolean;
  reason: string | null;
  combo: Combo;
}

export interface CaptureUpdate {
  keys: string[];
  validation: Validation;
}

export interface AudioDevice {
  name: string;
  is_default: boolean;
}

export interface MicLevel {
  bands: number[];
  level: number;
  device: string;
}

export interface WakeSession {
  screenshot: string | null;
  transcript: string;
}

export interface Settings {
  hotkey: Combo | null;
  input_device: string | null;
  onboarding_complete: boolean;
}

export interface ClickTarget {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A window the user can pick as the subject of a question. */
export interface AppWindow {
  id: number;
  app: string;
  title: string;
  focused: boolean;
}

/** A capture plus the slice of the monitor it covers, as 0..1 fractions. */
export interface Shot {
  image: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NimReply {
  answer: string;
  advice: string;
  target: ClickTarget | null;
}

/** Number of bars the backend analyses. Keep in sync with audio::BANDS. */
export const BAND_COUNT = 5;

/** Permissions Pointy cannot work without. All three gate the pipeline. */
export const REQUIRED_PERMISSIONS: PermissionId[] = ["microphone", "screen", "accessibility"];

export const isBlocking = (status: PermissionStatus) =>
  REQUIRED_PERMISSIONS.includes(status.id) && status.state !== "granted";

const PREVIEW_DETAILS: Record<PermissionId, string> = {
  microphone: "Preview: grant is simulated until you run the desktop app.",
  screen: "Preview: grant is simulated until you run the desktop app.",
  accessibility: "Preview: grant is simulated until you run the desktop app.",
};

function previewPermissions(overrides?: Partial<Record<PermissionId, PermissionState>>): PermissionStatus[] {
  return REQUIRED_PERMISSIONS.map((id) => ({
    id,
    state: overrides?.[id] ?? "prompt",
    detail: PREVIEW_DETAILS[id],
    can_open_settings: false,
  }));
}

/** In-memory preview state so Allow / Continue work without Rust. */
const preview: {
  permissions: PermissionStatus[];
  settings: Settings;
} = {
  permissions: previewPermissions(),
  settings: {
    hotkey: null,
    input_device: "Default Microphone",
    onboarding_complete: false,
  },
};

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    return previewInvoke<T>(cmd, args);
  }
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (reason) {
    // A missing bridge is a preview problem and falls back silently. Anything else is
    // a real answer from Rust — "Windows is blocking microphone access", a device that
    // vanished — and swallowing it here is what made a dead microphone look like a
    // working one. Those must reach the caller.
    if (reason instanceof TypeError) return previewInvoke<T>(cmd, args);
    throw reason;
  }
}

function previewInvoke<T>(cmd: string, args?: Record<string, unknown>): T {
  switch (cmd) {
    case "permissions_status":
      return preview.permissions as T;
    case "permissions_request": {
      const id = args?.id as PermissionId;
      preview.permissions = preview.permissions.map((entry) =>
        entry.id === id ? { ...entry, state: "granted" as const, detail: "Granted (preview)." } : entry,
      );
      return preview.permissions.find((entry) => entry.id === id)! as T;
    }
    case "permissions_open_settings":
      return undefined as T;
    case "audio_input_devices":
      return [
        { name: "Default Microphone", is_default: true },
        { name: "Headset Microphone", is_default: false },
      ] as T;
    case "audio_start_levels":
      return ((args?.device as string | null) ?? "Default Microphone") as T;
    case "audio_stop_levels":
      return undefined as T;
    case "hotkey_start_capture":
    case "hotkey_stop_capture":
      return undefined as T;
    case "hotkey_validate": {
      const keys = (args?.keys as string[]) ?? [];
      const valid = keys.length >= 2;
      return {
        valid,
        reason: valid ? null : "Add a modifier and another key.",
        combo: { keys },
      } as T;
    }
    case "hotkey_save": {
      const keys = (args?.keys as string[]) ?? ["Ctrl", "Space"];
      preview.settings.hotkey = { keys };
      return { keys } as T;
    }
    case "hotkey_current":
      return preview.settings.hotkey as T;
    case "settings_get":
      return { ...preview.settings } as T;
    case "settings_finish_onboarding":
      preview.settings.onboarding_complete = true;
      return { ...preview.settings } as T;
    case "settings_reset":
      preview.settings = {
        hotkey: null,
        input_device: "Default Microphone",
        onboarding_complete: false,
      };
      return { ...preview.settings } as T;
    case "hotkey_clear":
      preview.settings.hotkey = null;
      return undefined as T;
    case "overlay_set_enabled":
      return undefined as T;
    case "overlay_wake":
    case "overlay_rest":
    case "overlay_hide":
    case "overlay_set_passthrough":
    case "overlay_set_hit_rect":
      return undefined as T;
    case "windows_list":
      return [
        { id: 1, app: "Preview", title: "Run the desktop app to pick a window", focused: true },
      ] as T;
    case "window_focus":
      return undefined as T;
    case "capture_scope":
      return { image: "", x: 0, y: 0, w: 1, h: 1 } as T;
    case "wake_session":
      return { screenshot: null, transcript: "" } as T;
    case "wake_set_transcript":
      return undefined as T;
    case "ask_screen":
      return {
        answer: "Preview mode — NVIDIA NIM runs in the desktop app.",
        advice: "Hold your hotkey in the Tauri window.",
        target: null,
      } as T;
    case "transcribe_wav":
      return "" as T;
    default:
      throw new Error(`Preview mode has no handler for “${cmd}”.`);
  }
}

async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) {
    return () => {};
  }
  try {
    return await tauriListen<T>(event, handler);
  } catch {
    return () => {};
  }
}

// permissions
export const permissionsStatus = () => invoke<PermissionStatus[]>("permissions_status");
export const permissionsRequest = (id: PermissionId) =>
  invoke<PermissionStatus>("permissions_request", { id });
export const permissionsOpenSettings = (id: PermissionId) =>
  invoke<void>("permissions_open_settings", { id });

// audio
export const audioInputDevices = () => invoke<AudioDevice[]>("audio_input_devices");
export const audioStartLevels = (device?: string | null) =>
  invoke<string>("audio_start_levels", { device: device ?? null });
export const audioStopLevels = () => invoke<void>("audio_stop_levels");

// hotkey
export const hotkeyStartCapture = () => invoke<void>("hotkey_start_capture");
export const hotkeyStopCapture = () => invoke<void>("hotkey_stop_capture");
export const hotkeyValidate = (keys: string[]) => invoke<Validation>("hotkey_validate", { keys });
export const hotkeySave = (keys: string[]) => invoke<Combo>("hotkey_save", { keys });
export const hotkeyCurrent = () => invoke<Combo | null>("hotkey_current");

/** Persist and arm the wake combo. OS accelerator registration is best-effort. */
export async function registerAndSaveHotkey(keys: string[]): Promise<Combo> {
  const saved = await hotkeySave(keys);
  const { saveHotkey } = await import("@/lib/store");
  await saveHotkey(saved.keys);
  try {
    await registerGlobalHotkey(keys);
  } catch {
    // The Rust keyboard hook is already armed. Plugin ACL or unsupported
    // accelerators must not block saving a hotkey.
  }
  return saved;
}

// settings
export const settingsGet = () => invoke<Settings>("settings_get");
export const settingsFinishOnboarding = () => invoke<Settings>("settings_finish_onboarding");
export const settingsReset = () => invoke<Settings>("settings_reset");
export const hotkeyClear = () => invoke<void>("hotkey_clear");

// overlay
export const overlaySetEnabled = (enabled: boolean) =>
  invoke<void>("overlay_set_enabled", { enabled });
export const overlayHide = () => invoke<void>("overlay_hide");
export const overlayWake = () => invoke<void>("overlay_wake");
export const overlayRest = () => invoke<void>("overlay_rest");
export const overlaySetPassthrough = (enabled: boolean) =>
  invoke<void>("overlay_set_passthrough", { enabled });
export const overlaySetHitRect = (rect: { x: number; y: number; w: number; h: number }) =>
  invoke<void>("overlay_set_hit_rect", { rect });
export const windowsList = () => invoke<AppWindow[]>("windows_list");
export const windowFocus = (id: number) => invoke<void>("window_focus", { id });
export const captureScope = (windowId?: number | null) =>
  invoke<Shot>("capture_scope", { windowId: windowId ?? null });
export const wakeSession = () => invoke<WakeSession>("wake_session");
export const wakeSetTranscript = (transcript: string) =>
  invoke<void>("wake_set_transcript", { transcript });
export const askScreen = (question: string, screenshot?: string | null, app?: string | null) =>
  invoke<NimReply>("ask_screen", {
    question,
    screenshot: screenshot ?? null,
    app: app ?? null,
  });
export const transcribeWav = (wavBase64: string) =>
  invoke<string>("transcribe_wav", { wavBase64 });

// events
export const onCaptureProgress = (cb: (update: CaptureUpdate) => void): Promise<UnlistenFn> =>
  listen<CaptureUpdate>("hotkey://capture-progress", (event) => cb(event.payload));
export const onCaptureComplete = (cb: (update: CaptureUpdate) => void): Promise<UnlistenFn> =>
  listen<CaptureUpdate>("hotkey://capture-complete", (event) => cb(event.payload));
export const onHotkeyDown = (cb: (combo: Combo) => void): Promise<UnlistenFn> =>
  listen<Combo>("hotkey://down", (event) => cb(event.payload));
export const onHotkeyUp = (cb: (combo: Combo) => void): Promise<UnlistenFn> =>
  listen<Combo>("hotkey://up", (event) => cb(event.payload));
export const onOverlayHidden = (cb: () => void): Promise<UnlistenFn> =>
  listen<unknown>("overlay://hidden", () => cb());
export const onHookFailed = (cb: (reason: string) => void): Promise<UnlistenFn> =>
  listen<string>("hotkey://hook-failed", (event) => cb(event.payload));
export const onMicLevel = (cb: (level: MicLevel) => void): Promise<UnlistenFn> =>
  listen<MicLevel>("mic://level", (event) => cb(event.payload));
export const onMicError = (cb: (reason: string) => void): Promise<UnlistenFn> =>
  listen<string>("mic://error", (event) => cb(event.payload));

export { isTauri };
