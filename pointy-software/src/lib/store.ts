import { isTauri } from "@/lib/tauri";
import type { Combo } from "@/lib/pointy";
import type { StepId } from "@/components/onboarding/step-tabs";

export interface PersistedState {
  hasCompletedSetup: boolean;
  customHotkey: string[] | null;
  onboardingStep: StepId;
}

const DEFAULT_STATE: PersistedState = {
  hasCompletedSetup: false,
  customHotkey: null,
  onboardingStep: "welcome",
};

const FILE = "pointy.json";

let memory: PersistedState = { ...DEFAULT_STATE };

async function fileStore() {
  const { load } = await import("@tauri-apps/plugin-store");
  return load(FILE, { autoSave: true });
}

async function withStore<T>(fn: (store: Awaited<ReturnType<typeof fileStore>>) => Promise<T>): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    const store = await fileStore();
    return await fn(store);
  } catch {
    return null;
  }
}

/** Load saved setup. Falls back to in-memory state in browser preview. */
export async function loadPersisted(): Promise<PersistedState> {
  const fromDisk = await withStore(async (store) => {
    const hasCompletedSetup = (await store.get<boolean>("hasCompletedSetup")) ?? false;
    const customHotkey = (await store.get<string[]>("customHotkey")) ?? null;
    const onboardingStep = (await store.get<StepId>("onboardingStep")) ?? "welcome";
    return { hasCompletedSetup, customHotkey, onboardingStep } satisfies PersistedState;
  });
  if (fromDisk) {
    memory = fromDisk;
    return fromDisk;
  }
  return { ...memory };
}

export async function saveHotkey(keys: string[]): Promise<void> {
  memory.customHotkey = keys;
  await withStore(async (store) => {
    await store.set("customHotkey", keys);
    await store.save();
  });
}

export async function saveOnboardingStep(step: StepId): Promise<void> {
  memory.onboardingStep = step;
  await withStore(async (store) => {
    await store.set("onboardingStep", step);
    await store.save();
  });
}

export async function markSetupComplete(combo: Combo): Promise<void> {
  memory = {
    hasCompletedSetup: true,
    customHotkey: combo.keys,
    onboardingStep: "speak",
  };
  await withStore(async (store) => {
    await store.set("hasCompletedSetup", true);
    await store.set("customHotkey", combo.keys);
    await store.save();
  });
}

export async function wipeSetup(): Promise<void> {
  memory = { ...DEFAULT_STATE };
  await withStore(async (store) => {
    await store.clear();
    await store.save();
  });
}

export function comboFromPersisted(state: PersistedState): Combo | null {
  return state.customHotkey?.length ? { keys: state.customHotkey } : null;
}
