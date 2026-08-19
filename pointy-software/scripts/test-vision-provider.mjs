#!/usr/bin/env node
/**
 * Diagnostic: send one screenshot question to the configured vision providers
 * (Gemini, OpenRouter) using the exact payload shape from nim.rs, and print the
 * raw model response so "could not read a clear answer" failures are visible.
 *
 *   node scripts/test-vision-provider.mjs [path-to-image]
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadKey(names) {
  for (const name of [".env.local", ".env"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m && names.includes(m[1]) && m[2].trim()) return m[2].trim();
    }
  }
  return null;
}

const imagePath = process.argv[2];
if (!imagePath || !existsSync(imagePath)) {
  console.error("Usage: node scripts/test-vision-provider.mjs path/to/image.png");
  process.exit(1);
}

const imageBuf = readFileSync(imagePath);
const dataUrl = `data:image/png;base64,${imageBuf.toString("base64")}`;

const question = "can you open a new tab and open youtube";

const SYSTEM = `You are Pointy, a screen guide. Respond with ONLY valid JSON (no markdown fences, no extra text):
{"answer":"1-2 short sentences.","advice":"one short next step","multi_step":false,"action":"click","confidence":0.92,"target":{"label":"New tab","x":0.43,"y":0.03,"w":0.03,"h":0.02}}`;

async function testOpenAI(url, key, model, jsonMode, label) {
  console.log(`\n=== ${label} (${model}) ===`);
  const payload = {
    model,
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: `The user asked: ${question}\n\nThis screenshot is what they are looking at right now. JSON only.` },
        ],
      },
    ],
    temperature: 0.2,
    top_p: 0.7,
    max_tokens: 512,
    stream: false,
  };
  if (jsonMode) payload.response_format = { type: "json_object" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    console.log(`status: ${res.status}`);
    console.log(body.slice(0, 1400));
  } catch (err) {
    console.error(`network error: ${err.message}`);
  }
}

const geminiKey = loadKey(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
const orKey = loadKey(["OPEN_ROUTER_API_KEY", "OPENROUTER_API_KEY"]);

if (geminiKey) {
  await testOpenAI(
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    geminiKey,
    "gemini-3.6-flash",
    false,
    "Gemini",
  );
} else {
  console.log("\n=== Gemini === (no key)");
}

if (orKey) {
  await testOpenAI(
    "https://openrouter.ai/api/v1/chat/completions",
    orKey,
    "google/gemma-4-26b-a4b-it:free",
    true,
    "OpenRouter",
  );
} else {
  console.log("\n=== OpenRouter === (no key)");
}
