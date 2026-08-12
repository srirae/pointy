/**
 * Typed bridge to the Rust backend. Every value here comes from a real OS query or a
 * live audio/keyboard stream — see src-tauri/src for the implementations.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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

/** Permissions Pointy cannot work without. All three gate the pipeline. */
export const REQUIRED_PERMISSIONS: PermissionId[] = ["microphone", "screen", "accessibility"];

export const isBlocking = (status: PermissionStatus) =>
  REQUIRED_PERMISSIONS.includes(status.id) && status.state !== "granted";
