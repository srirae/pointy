# Pointy Implementation Guide: Cursor Prompts

This guide is updated to perfectly match the "Pointy" style experience: frosted glass, a minimalist guide-dot, strict onboarding, persistent settings (Dashboard), and hold-to-wake audio detection using Nvidia NIM.

## Phase 1: Strict Onboarding & Persistent Dashboard

**Goal:** An onboarding flow that enforces hotkey selection and microphone permission, saving progress so the user sees a Dashboard on subsequent launches.

### 🛠️ Manual Work
1. Ensure your Tauri project is running.
2. Add the store plugin to save settings permanently: `npm run tauri plugin add store`.
3. Add the global shortcut plugin: `npm run tauri plugin add global-shortcut`.
4. **Crucial Permissions Fix:** In Tauri v2, you must explicitly allow plugins. Open `src-tauri/capabilities/default.json` and add `"global-shortcut:default"` to the `"permissions"` array to prevent the `global-shortcut.register not allowed` error.

### 💬 Cursor Prompt 1: Persistent Onboarding & Dashboard
Copy and paste this into Cursor:

```text
I am building a Tauri + React desktop app. I need a robust onboarding flow and a persistent dashboard.

Requirements:
1. Use `@tauri-apps/plugin-store` to manage persistent state (e.g., `hasCompletedSetup`, `customHotkey`).
2. **On App Launch**: Check the store. If `hasCompletedSetup` is false, show the `Onboarding` screen. If true, show the `Dashboard` screen.
3. **Onboarding Screen**:
   - Ask the user to define a custom hotkey (e.g., Ctrl + Win).
   - **Crucial Bug Fix**: The "Continue" button MUST be completely disabled. It can only become enabled IF a valid hotkey has been successfully registered via `@tauri-apps/plugin-global-shortcut` AND microphone permissions have been successfully requested and granted by the browser.
   - Once successfully registered and mic is allowed, save `hasCompletedSetup: true` and the `customHotkey` to the Tauri store.
4. **Dashboard Screen**:
   - Displays "You're all set."
   - Shows the current active hotkey ("Hold [Ctrl] [Win] to wake Pointy").
   - Provides a "Run setup again" button to wipe the store state and return to Onboarding.
   - Provides an interface to change the hotkey directly from this dashboard.
5. **Styling**: Match a premium, minimalistic aesthetic with soft gradients and rounded UI elements.
```

---

## Phase 2: Hold-to-Wake, Screen Capture & The Guide-Dot

**Goal:** Implement the core mechanic. Holding the keys wakes a transparent frosted glass overlay and immediately starts listening to audio (indicated by a pulsing guide-dot).

### 🛠️ Manual Work
1. Add a Rust crate for screen capture in `src-tauri/Cargo.toml` (e.g., `xcap`).
2. You need to configure the Tauri window in `tauri.conf.json` to be transparent (`"transparent": true`) and frameless (`"decorations": false`) for the overlay effect.

### 💬 Cursor Prompt 2: The Core "Pointy" Mechanic
Copy and paste this into Cursor:

```text
Now let's build the core "Hold-to-Wake" mechanic.

Requirements:
1. Write a Rust command `capture_screen` that captures the primary monitor and returns a base64 string.
2. In the React app, listen for the global hotkey registered in the store. 
3. **Hold-to-Wake Logic**:
   - We need to detect when the hotkey is *pressed down* and when it is *released*.
   - **On Key Down**: 
     - Trigger `capture_screen` in the background.
     - Summon a full-screen, transparent, frameless Tauri window overlay.
     - The background of this window should be a subtle frosted glass effect (`backdrop-blur`).
     - In the center of the screen, show the "Guide-Dot": a minimalistic, dark, pill-shaped UI containing a single orange dot that pulses rhythmically.
     - Immediately start recording audio using the Web `MediaRecorder` API or `SpeechRecognition` API.
   - **On Key Up** (User releases the hotkey):
     - Stop audio recording.
     - Stop the pulsing animation on the Guide-Dot and change it to a "loading" or "processing" state (e.g., a spinning border).
     - Prepare the captured screenshot and the transcribed audio text for the AI.
4. Ensure the window is completely invisible/hidden when the hotkey is not being held.
```

---

## Phase 3: Nvidia NIM AI Integration

**Goal:** Send the captured screen and spoken text to Nvidia NIM and display the result gracefully on the frosted glass.

### 🛠️ Manual Work
1. Ensure your `.env` has `NVIDIA_API_KEY` (no `VITE_` prefix — that would inline the key into the shipped bundle).

### 💬 Cursor Prompt 3: AI Processing & Display
Copy and paste this into Cursor:

```text
Let's connect the captured data to Nvidia NIM and display the answer.

Requirements:
1. When the user releases the hotkey (from Phase 2), take the transcribed audio text and the base64 screenshot.
2. Send both to the Nvidia NIM Vision API (e.g., `meta/llama-3.2-90b-vision-instruct`).
3. **UI Update**: 
   - While waiting for the API, the Guide-Dot should show a loading animation.
   - When the response arrives, gracefully expand the dark pill shape (Guide-Dot) into a larger, beautifully formatted text container to display the AI's response using Markdown.
   - Do NOT build a "chat wall". The UI should only show the current question's answer on the frosted glass.
4. If the user holds the hotkey again, completely reset the UI back to the initial pulsing Guide-Dot, take a new screenshot, and start a fresh audio recording.
```

---

## Phase 4: Refinement and Bug Squashing

**Goal:** Ensure the hotkeys work flawlessly and the audio doesn't fail.

### 💬 Cursor Prompt 4: Stability & Polish
Copy and paste this into Cursor:

```text
Let's fix edge cases and ensure the app is incredibly stable.

Requirements:
1. **Audio Recording Fallback**: If the user's mic fails to record or transcribes nothing, the UI should gracefully fallback to showing a text input field inside the expanded pill shape, allowing them to type their question instead.
2. **Hotkey Edge Cases**: Ensure that if the app is unfocused or running in the background, the global hotkey STILL triggers the overlay and audio recording perfectly.
3. **Window Management**: Ensure the frosted glass Tauri window always appears on top of all other applications (`alwaysOnTop: true`) when activated, and loses focus/hides when dismissed (e.g., by clicking outside the pill or pressing Escape).
4. Add subtle enter/exit animations (framer-motion or CSS transitions) for the overlay and the Guide-Dot so it feels snappy and premium.
```
