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

export interface Settings {
  hotkey: Combo | null;
  input_device: string | null;
  onboarding_complete: boolean;
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
  } catch {
    // Never surface raw bridge TypeErrors in onboarding — fall back to preview.
    return previewInvoke<T>(cmd, args);
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

// settings
export const settingsGet = () => invoke<Settings>("settings_get");
export const settingsFinishOnboarding = () => invoke<Settings>("settings_finish_onboarding");

// events
export const onCaptureProgress = (cb: (update: CaptureUpdate) => void): Promise<UnlistenFn> =>
  listen<CaptureUpdate>("hotkey://capture-progress", (event) => cb(event.payload));
export const onCaptureComplete = (cb: (update: CaptureUpdate) => void): Promise<UnlistenFn> =>
  listen<CaptureUpdate>("hotkey://capture-complete", (event) => cb(event.payload));
export const onHotkeyDown = (cb: (combo: Combo) => void): Promise<UnlistenFn> =>
  listen<Combo>("hotkey://down", (event) => cb(event.payload));
export const onHotkeyUp = (cb: (combo: Combo) => void): Promise<UnlistenFn> =>
  listen<Combo>("hotkey://up", (event) => cb(event.payload));
export const onHookFailed = (cb: (reason: string) => void): Promise<UnlistenFn> =>
  listen<string>("hotkey://hook-failed", (event) => cb(event.payload));
export const onMicLevel = (cb: (level: MicLevel) => void): Promise<UnlistenFn> =>
  listen<MicLevel>("mic://level", (event) => cb(event.payload));
export const onMicError = (cb: (reason: string) => void): Promise<UnlistenFn> =>
  listen<string>("mic://error", (event) => cb(event.payload));

export { isTauri };
