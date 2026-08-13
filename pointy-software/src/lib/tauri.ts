/**
 * Detect whether the UI is running inside the Tauri webview.
 * Vite-in-browser previews have no Rust bridge — every invoke must be gated.
 */
export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Window & {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}
