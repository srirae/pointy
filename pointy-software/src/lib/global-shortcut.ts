import { isTauri } from "@/lib/tauri";

/** Map Pointy key tokens to `tauri-plugin-global-shortcut` accelerator strings. */
export function comboToShortcut(keys: string[]): string {
  return keys
    .map((key) => {
      switch (key) {
        case "Ctrl":
          return "Control";
        case "Win":
          return "Super";
        default:
          return key;
      }
    })
    .join("+");
}

/**
 * Register the combo with the OS via `@tauri-apps/plugin-global-shortcut`.
 * Returns true only when the OS accepted the shortcut.
 *
 * Modifier-only combos (Ctrl+Win) are valid for Pointy's keyboard hook but some
 * OS accelerators reject them — those still count as registered if `hotkey_save`
 * armed the hook. This helper reports OS registration separately.
 */
export async function registerGlobalHotkey(keys: string[]): Promise<boolean> {
  if (keys.length === 0) return false;
  if (!isTauri()) return true;

  const { register, unregisterAll } = await import("@tauri-apps/plugin-global-shortcut");
  const shortcut = comboToShortcut(keys);

  await unregisterAll().catch(() => {});
  await register(shortcut, () => {
    // Push-to-talk edges come from the Rust keyboard hook.
  });
  return true;
}

export async function unregisterGlobalHotkeys(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { unregisterAll } = await import("@tauri-apps/plugin-global-shortcut");
    await unregisterAll();
  } catch {
    // nothing registered
  }
}
