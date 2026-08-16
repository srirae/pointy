import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "models");
mkdirSync(root, { recursive: true });
const manifestPath = join(root, ".checksums.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};

const assets = [
  {
    name: "ggml-base.en.bin",
    url: process.env.POINTY_WHISPER_URL ?? "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin?download=true",
    minBytes: 20 * 1024 * 1024,
  },
  {
    name: "piper.exe",
    url: process.env.POINTY_PIPER_URL ?? "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
    minBytes: 256 * 1024,
    zip: true,
  },
  {
    name: "en_US-lessac-medium.onnx",
    url: process.env.POINTY_PIPER_VOICE_URL ?? "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx?download=true",
    minBytes: 10 * 1024 * 1024,
  },
  {
    name: "en_US-lessac-medium.onnx.json",
    url: process.env.POINTY_PIPER_CONFIG_URL ?? "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json?download=true",
    minBytes: 100,
  },
];

function valid(asset) {
  const path = join(root, asset.name);
  if (!existsSync(path) || statSync(path).size < asset.minBytes) return false;
  const known = manifest[asset.name];
  return !known || known === sha256(path);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function removeFile(path) {
  try {
    await rm(path, { force: true });
  } catch {
    /* locked zip is harmless */
  }
}

async function removeDir(path) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return true;
    } catch (error) {
      // Windows Defender/antivirus briefly locks freshly extracted executables.
      // Back off and retry; a leftover extract dir is harmless on disk.
      if (attempt === 5) {
        console.warn(`[pointy-models] could not remove ${path}: ${error.message}`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  return false;
}

async function download(asset) {
  if (!asset.url) {
    console.warn(`[pointy-models] skipping ${asset.name}: no URL configured`);
    return false;
  }
  console.log(`[pointy-models] downloading ${asset.name}`);
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`${asset.name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const temp = join(root, `${asset.name}.download`);
  writeFileSync(temp, bytes);
  if (asset.zip) {
    const zip = join(root, `${asset.name}.zip`);
    await rename(temp, zip);
    const extract = join(root, ".piper-extract");
    await removeDir(extract);
    mkdirSync(extract, { recursive: true });
    const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${zip.replaceAll("'", "''")}' -DestinationPath '${extract.replaceAll("'", "''")}' -Force`], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("Could not extract Piper. Install Piper manually in models/.");
    const found = findFile(extract, "piper.exe");
    if (!found) throw new Error("Piper archive did not contain piper.exe");
    writeFileSync(join(root, asset.name), readFileSync(found));
    // Record the result before cleanup so a locked extract dir can never
    // make an already-valid piper.exe look like a failed install.
    manifest[asset.name] = sha256(join(root, asset.name));
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    await removeFile(zip);
    await removeDir(extract);
  } else {
    await rename(temp, join(root, asset.name));
  }
  manifest[asset.name] = sha256(join(root, asset.name));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return true;
}

function findFile(dir, wanted) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, wanted);
      if (found) return found;
    } else if (entry.name.toLowerCase() === wanted.toLowerCase()) return path;
  }
  return null;
}

if (process.env.POINTY_SKIP_MODEL_DOWNLOAD !== "1") {
  for (const asset of assets) {
    if (valid(asset)) {
      console.log(`[pointy-models] cached ${asset.name}`);
      continue;
    }
    try {
      await download(asset);
    } catch (error) {
      throw error;
    }
  }
}
