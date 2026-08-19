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

export interface ModelProgress {
  phase: string;
  asset: string;
  downloaded: number;
  total: number | null;
  ready: boolean;
  error: string | null;
}

export interface Settings {
  hotkey: Combo | null;
  input_device: string | null;
  onboarding_complete: boolean;
  /** ISO-639-1 code the user speaks; null means English. */
  voice_language: string | null;
}

export interface Language {
  code: string;
  english: string;
  native: string;
  /** Null for English, whose voice ships with the app. */
  voice: string | null;
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
  multi_step: boolean;
  action: string;
  confidence: number;
  target: ClickTarget | null;
}

/** Exact physical point of a resolved control (see uia::DotPoint). */
export interface DotPoint {
  label: string;
  raw_x: number;
  raw_y: number;
  raw_w: number;
  raw_h: number;
  dpi_scale: number;
  dot_x: number;
  dot_y: number;
  fx: number;
  fy: number;
  fw: number;
  fh: number;
  /** Center of the box as 0..1 fractions of the virtual desktop. */
  cx: number;
  cy: number;
}

/** `ask_screen` reply plus the capture's monitor fractions for mapping. */
export interface AskReply extends NimReply {
  x: number;
  y: number;
  w: number;
  h: number;
  dot: DotPoint | null;
}

/** One earlier exchange, sent back so the model can resolve follow-ups. */
export interface ChatTurn {
  question: string;
  answer: string;
}

/**
 * A control re-found in the live accessibility tree. Unlike `AskReply.target`,
 * these fractions are already relative to the whole desktop — the overlay's own
 * coordinate space — so no shot mapping is needed.
 */
export interface LocatedTarget {
  target: ClickTarget;
  dot: DotPoint;
}

/** Local usage-tracking totals: app/title -> seconds. */
export interface UsageData {
  total: Record<string, number>;
  today: Record<string, number>;
  day: number;
}

/** One event from the guided walkthrough. */
export interface GuideStep {
  kind: string;
  step: number;
  say: string;
  action?: string;
  confidence?: number;
  target: ClickTarget | null;
  /** Exact physical point from the accessibility tree, when resolved. */
  dot?: DotPoint | null;
  x: number;
  y: number;
  w: number;
  h: number;
  /** false when the sentence was already spoken via streaming. */
  speak?: boolean;
}

/** One local misclick warning: which wrong zone was entered and what was said. */
export interface GuideWarn {
  zone: string;
  say: string;
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
/** Mirrors the Rust catalogue so the browser preview renders the real picker. */
const PREVIEW_LANGUAGES: Language[] = [
  { code: "en", english: "English", native: "English", voice: null },
  { code: "es", english: "Spanish", native: "Español", voice: "es_ES-davefx-medium.onnx" },
  { code: "hi", english: "Hindi", native: "हिन्दी", voice: "hi_IN-pratham-medium.onnx" },
  { code: "ur", english: "Urdu", native: "اردو", voice: "ur_PK-fasih-medium.onnx" },
];

const preview: {
  permissions: PermissionStatus[];
  settings: Settings;
} = {
  permissions: previewPermissions(),
  settings: {
    hotkey: null,
    input_device: "Default Microphone",
    onboarding_complete: false,
    voice_language: null,
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
    case "models_status":
      return [] as T;
    case "models_ready":
      return true as T;
    case "languages":
      return PREVIEW_LANGUAGES as T;
    case "voice_status":
      return PREVIEW_LANGUAGES.map((language) => [language.code, !language.voice]) as T;
    case "voice_download":
      return undefined as T;
    case "settings_set_language":
      preview.settings = {
        ...preview.settings,
        voice_language: (args?.code as string) ?? null,
      };
      return { ...preview.settings } as T;
    case "settings_reset":
      preview.settings = {
        hotkey: null,
        input_device: "Default Microphone",
        onboarding_complete: false,
        voice_language: null,
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
        answer: "Preview mode — OpenRouter runs in the desktop app.",
        advice: "Hold your hotkey in the Tauri window.",
        multi_step: false,
        action: "unknown",
        confidence: 0,
        target: null,
        dot: null,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      } as T;
    case "locate_target":
      return null as T;
    case "point_watch":
    case "point_unwatch":
      return undefined as T;
    case "transcribe_wav":
      return "" as T;
    case "usage_stats":
      return { total: {}, today: {}, day: 0 } as T;
    case "usage_question":
      return null as T;
    case "guide_start":
    case "guide_stop":
    case "guide_repeat":
    case "speak":
    case "stop_speaking":
      return undefined as T;
    case "guide_active":
      return false as T;
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
export const modelsStatus = () => invoke<[string, boolean][]>("models_status");
export const modelsReady = () => invoke<boolean>("models_ready");
export const hotkeyClear = () => invoke<void>("hotkey_clear");

// speech languages
export const languages = () => invoke<Language[]>("languages");
export const settingsSetLanguage = (code: string) =>
  invoke<Settings>("settings_set_language", { code });
/** Which languages have their voice downloaded, as [code, installed] pairs. */
export const voiceStatus = () => invoke<[string, boolean][]>("voice_status");
export const voiceDownload = (code: string) => invoke<void>("voice_download", { code });
export const onVoiceProgress = (cb: (progress: ModelProgress) => void): Promise<UnlistenFn> =>
  listen<ModelProgress>("models://voice", (event) => cb(event.payload));

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
export const askScreen = (
  question: string,
  windowId?: number | null,
  app?: string | null,
  history?: ChatTurn[],
) =>
  invoke<AskReply>("ask_screen", {
    question,
    windowId: windowId ?? null,
    appName: app ?? null,
    history: history ?? [],
  });

/**
 * Re-find a named control on the screen as it looks right now.
 *
 * `expect` is where the answer thought it was, in desktop fractions. Its
 * coordinates are stale, but it still says which region to search, which is what
 * stops a navbar full of same-named elements from being picked at random.
 */
export const locateTarget = (
  label: string,
  windowId?: number | null,
  expect?: { x: number; y: number; w: number; h: number } | null,
) =>
  invoke<LocatedTarget | null>("locate_target", {
    label,
    windowId: windowId ?? null,
    expect: expect ?? null,
  });

/** Watch for a real click inside the highlighted box. */
export const pointWatch = (rect: { x: number; y: number; w: number; h: number }) =>
  invoke<void>("point_watch", { rect });
export const pointUnwatch = () => invoke<void>("point_unwatch");
export const onPointClicked = (cb: () => void): Promise<UnlistenFn> =>
  listen<unknown>("point://clicked", () => cb());
export const transcribeWav = (wavBase64: string) =>
  invoke<string>("transcribe_wav", { wavBase64 });

export const usageStats = () => invoke<UsageData>("usage_stats");
export const usageQuestion = (question: string) =>
  invoke<string | null>("usage_question", { question });

export const guideStart = (
  task: string,
  windowId?: number | null,
  firstLabel?: string | null,
  action?: string | null,
  confidence?: number | null,
) =>
  invoke<void>("guide_start", {
    task,
    windowId: windowId ?? null,
    firstLabel: firstLabel ?? null,
    action: action ?? null,
    confidence: confidence ?? null,
  });
export const guideStop = () => invoke<void>("guide_stop");
export const guideRepeat = () => invoke<void>("guide_repeat");
export const guideActive = () => invoke<boolean>("guide_active");
export const onGuideStep = (cb: (step: GuideStep) => void): Promise<UnlistenFn> =>
  listen<GuideStep>("guide://step", (event) => cb(event.payload));
export interface GuideDiagnostic {
  step: number;
  phase: string;
  reason: string;
  action: string;
  confidence: number;
}

export const onGuideWarn = (cb: (warn: GuideWarn) => void): Promise<UnlistenFn> =>
  listen<GuideWarn>("guide://warn", (event) => cb(event.payload));
export const onGuideDiagnostic = (
  cb: (diagnostic: GuideDiagnostic) => void,
): Promise<UnlistenFn> => listen<GuideDiagnostic>("guide://diagnostic", (event) => cb(event.payload));

/** Speak text through the OS voice (used when the webview has no voices). */
export const speakText = (text: string) => invoke<void>("speak", { text });
export const stopSpeaking = () => invoke<void>("stop_speaking");

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
export const onModelProgress = (cb: (progress: ModelProgress) => void): Promise<UnlistenFn> =>
  listen<ModelProgress>("models://progress", (event) => cb(event.payload));

export { isTauri };
