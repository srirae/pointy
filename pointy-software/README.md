# Tauri + SvelteKit + TypeScript

This template should help get you started developing with Tauri, SvelteKit and TypeScript in Vite.

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer).

## Development (Windows)

Run the desktop app with:

```bash
pnpm install
pnpm tauri dev
```

### Smart App Control blocks the debug build

On Windows 11 with **Smart App Control** set to **On**, the unsigned debug binary
(`target\debug\pointy-software.exe`) is blocked at launch with:

```text
An Application Control policy has blocked this file. (os error 4551)
```

This is a kernel-level security feature and cannot be bypassed from code — the
only fix is to turn it off once:

**Windows Security → App & browser control → Smart App Control settings → Off.**

(It can only be turned off, not re-enabled, without a Windows reset.) Most
machines ship with Smart App Control in "Evaluation" or "Off", so this only
bites contributors who have it explicitly On. To check quickly:

```bash
powershell -NoProfile -Command "(Get-MpComputerStatus).SmartAppControlState"
```

End users are not affected by this: release builds should be code-signed, and
Smart App Control does not block properly signed applications.
