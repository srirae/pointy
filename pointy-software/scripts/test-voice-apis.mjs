#!/usr/bin/env node
/**
 * Diagnostic: hit Deepgram (STT) and Cartesia (TTS) with the exact request
 * shapes Pointy sends, and print status + body so failures are visible.
 *
 *   node scripts/test-voice-apis.mjs
 *
 * Reads keys from .env.local / .env in the project root. Prints nothing but
 * status codes, error bodies, and byte counts — never the keys themselves.
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadKeys() {
  const out = {};
  for (const name of [".env.local", ".env"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      const key = m[1];
      const value = m[2].trim().replace(/^["']|["']$/g, "");
      if (value && (key === "DEEPGRAM_API_KEY" || key === "CARTESIA_API_KEY")) {
        out[key] = value;
      }
    }
  }
  return out;
}

const keys = loadKeys();
for (const k of ["DEEPGRAM_API_KEY", "CARTESIA_API_KEY"]) {
  if (!keys[k]) {
    console.error(`MISSING ${k} in .env.local or .env`);
  } else {
    console.log(`${k}: set (len=${keys[k].length}, prefix=${keys[k].slice(0, 6)}…)`);
  }
}

// --- Build a 1s 440 Hz tone WAV (16kHz, 16-bit, mono) in memory ---
function toneWav() {
  const rate = 16000;
  const seconds = 1;
  const samples = rate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const v = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3 * 0x7fff;
    buffer.writeInt16LE(Math.round(v), 44 + i * 2);
  }
  return buffer;
}

// --- Deepgram STT ---
async function testDeepgram() {
  if (!keys.DEEPGRAM_API_KEY) return;
  console.log("\n=== Deepgram STT ===");
  const wav = toneWav();
  const url = "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=en";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${keys.DEEPGRAM_API_KEY}`,
        "Content-Type": "audio/wav",
      },
      body: wav,
    });
    const text = await res.text();
    console.log(`status: ${res.status}`);
    console.log(`body: ${text.slice(0, 500)}`);
  } catch (err) {
    console.error(`network error: ${err.message}`);
  }
}

// --- Cartesia TTS (exact payload from tts.rs) ---
async function testCartesia() {
  if (!keys.CARTESIA_API_KEY) return;
  console.log("\n=== Cartesia TTS ===");
  const payload = {
    transcript: "Hi there, it's awesome to meet you.",
    model_id: "sonic-3.5",
    voice: {
      mode: "id",
      id: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
    },
    output_format: {
      container: "wav",
      encoding: "pcm_s16le",
      sample_rate: 44100,
    },
  };
  try {
    const res = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keys.CARTESIA_API_KEY}`,
        "Cartesia-Version": "2025-04-16",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("audio") || ct.includes("application/octet-stream")) {
      const buf = Buffer.from(await res.arrayBuffer());
      console.log(`status: ${res.status}`);
      console.log(`audio bytes: ${buf.length} (${buf.slice(0, 4).toString("ascii") === "RIFF" ? "valid WAV" : "no RIFF header"})`);
      writeFileSync(join(root, "cartesia-test.wav"), buf);
      console.log(`wrote cartesia-test.wav`);
    } else {
      const text = await res.text();
      console.log(`status: ${res.status}`);
      console.log(`body: ${text.slice(0, 500)}`);
    }
  } catch (err) {
    console.error(`network error: ${err.message}`);
  }
}

await testDeepgram();
await testCartesia();
