#!/usr/bin/env node
/**
 * Quick Deepgram STT test.
 *
 * Usage:
 *   node scripts/test-deepgram.mjs [path-to-wav] [language-code]
 *
 * Examples:
 *   node scripts/test-deepgram.mjs                 # records 5s from mic
 *   node scripts/test-deepgram.mjs my-audio.wav    # test with existing file
 *   node scripts/test-deepgram.mjs my-audio.wav ar # test Arabic
 *
 * Reads DEEPGRAM_API_KEY from .env or .env.local in the project root.
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- Load key from .env.local or .env ---
function loadKey() {
  for (const name of [".env.local", ".env"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*DEEPGRAM_API_KEY\s*=\s*(.+?)\s*$/);
      if (m && m[1].trim()) return m[1].trim();
    }
  }
  return null;
}

const key = loadKey();
if (!key) {
  console.error("DEEPGRAM_API_KEY not found in .env or .env.local");
  process.exit(1);
}
console.log(`Found key: ${key.slice(0, 8)}...`);

// --- Get WAV file (arg or record 5s) ---
let wavPath = process.argv[2];
const language = process.argv[3] ?? "en";
let didRecord = false;

if (!wavPath) {
  wavPath = join(tmpdir(), "pointy_stt_test.wav");
  console.log("\nNo file provided — recording 5 seconds from your microphone...");
  console.log("Speak now!\n");

  // Write PS script to temp file to avoid any escaping issues
  const psPath = join(tmpdir(), "pointy_record.ps1");
  writeFileSync(psPath, [
    `$outPath = '${wavPath.replace(/\\/g, "\\\\").replace(/'/g, "''")}';`,
    `Add-Type -TypeDefinition @"`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `public static class WavRec {`,
    `    [DllImport("winmm.dll", CharSet = CharSet.Ansi)]`,
    `    public static extern int mciSendStringA(string s, System.Text.StringBuilder r, int n, IntPtr h);`,
    `}`,
    `"@`,
    `[WavRec]::mciSendStringA("open new type waveaudio alias rec", $null, 0, [IntPtr]::Zero) | Out-Null;`,
    `[WavRec]::mciSendStringA("set rec time format ms bitspersample 16 channels 1 samplespersec 16000 alignment 2 bytespersec 32000", $null, 0, [IntPtr]::Zero) | Out-Null;`,
    `[WavRec]::mciSendStringA("record rec", $null, 0, [IntPtr]::Zero) | Out-Null;`,
    `Start-Sleep -Seconds 5;`,
    `[WavRec]::mciSendStringA("stop rec", $null, 0, [IntPtr]::Zero) | Out-Null;`,
    `[WavRec]::mciSendStringA("save rec $outPath", $null, 0, [IntPtr]::Zero) | Out-Null;`,
    `[WavRec]::mciSendStringA("close rec", $null, 0, [IntPtr]::Zero) | Out-Null;`,
    `Write-Host "Recorded OK";`,
  ].join("\n"), "utf8");

  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", psPath],
    { stdio: "pipe", timeout: 15000 }
  );

  try { unlinkSync(psPath); } catch {}

  if (result.status === 0 && existsSync(wavPath)) {
    didRecord = true;
    console.log("Recorded successfully!\n");
  } else {
    const stderr = result.stderr?.toString() ?? "";
    const stdout = result.stdout?.toString() ?? "";
    console.error("Recording failed.");
    if (stderr) console.error(stderr.slice(0, 300));
    if (stdout) console.error(stdout.slice(0, 300));
    console.error("\nProvide a WAV file directly instead:");
    console.error("  node scripts/test-deepgram.mjs path/to/audio.wav");
    process.exit(1);
  }
}

if (!existsSync(wavPath)) {
  console.error(`File not found: ${wavPath}`);
  process.exit(1);
}

const wavBytes = readFileSync(wavPath);
console.log(`Sending ${(wavBytes.length / 1024).toFixed(1)} KB WAV to Deepgram (language=${language})...`);

// --- Call Deepgram ---
const url = `https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=${language}`;
const response = await fetch(url, {
  method: "POST",
  headers: {
    Authorization: `Token ${key}`,
    "Content-Type": "audio/wav",
  },
  body: wavBytes,
});

const bodyText = await response.text();

if (!response.ok) {
  console.error(`Deepgram error ${response.status}:`);
  console.error(bodyText.slice(0, 400));
  process.exit(1);
}

const json = JSON.parse(bodyText);
const alt = json?.results?.channels?.[0]?.alternatives?.[0];
const transcript = alt?.transcript ?? "";
const confidence = alt?.confidence ?? 0;
const detectedLang = json?.results?.channels?.[0]?.detected_language ?? "n/a";
const duration = json?.metadata?.duration?.toFixed(2) ?? "?";

console.log("\n--- Deepgram Result ---");
console.log(`Transcript    : "${transcript}"`);
console.log(`Confidence    : ${(confidence * 100).toFixed(1)}%`);
console.log(`Detected lang : ${detectedLang}`);
console.log(`Audio duration: ${duration}s`);

if (!transcript.trim()) {
  console.warn("\nEmpty transcript — mic may be muted, audio too quiet, or wrong device.");
} else {
  console.log("\nSTT working!");
}

// Cleanup auto-recorded file
if (didRecord && existsSync(wavPath)) {
  try { unlinkSync(wavPath); } catch {}
}
