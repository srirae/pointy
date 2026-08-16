import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "Pointy_Current_State.md");
const outputPath = path.join(here, "Pointy_Current_State_Report.pdf");
const markdown = fs.readFileSync(sourcePath, "utf8");

const PAGE_W = 612;
const PAGE_H = 792;
const LEFT =  fifty(48);
const RIGHT = 48;
const TOP = 730;
const BOTTOM = 58;
const BODY_SIZE = 9.2;
const BODY_LEADING = 13;

function fifty(value) {
  return value;
}

function ascii(text) {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2192/g, "->")
    .replace(/\u2265/g, ">=")
    .replace(/\u00A0/g, " ")
    .replace(/[^\x09-\x7E]/g, "?");
}

function escapePdf(text) {
  return ascii(text).replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function wrap(text, size, maxWidth) {
  const words = ascii(text).split(/\s+/).filter(Boolean);
  const maxChars = Math.max(20, Math.floor(maxWidth / (size * 0.49)));
  const lines = [];
  let current = "";
  for (const word of words) {
    if (word.length > maxChars) {
      if (current) {
        lines.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += maxChars) lines.push(word.slice(i, i + maxChars));
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function textCommand(text, x, y, size, font = "F1", color = "0.12 0.18 0.23") {
  return `BT /${font} ${size} Tf ${color} rg 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapePdf(text)}) Tj ET`;
}

function ruleCommand(y) {
  return `0.86 0.89 0.91 RG 0.6 w 48 ${y.toFixed(2)} m 564 ${y.toFixed(2)} l S`;
}

function newPage(number) {
  const commands = [
    "q 0.05 0.29 0.32 rg 0 760 612 32 re f Q",
    textCommand("POINTY  /  CURRENT STATE", 48, 772, 8, "F2", "1 1 1"),
    textCommand(String(number), 550, 772, 8, "F2", "1 1 1"),
  ];
  return { commands, y: TOP };
}

const pages = [];
let page = newPage(1);
let inCode = false;
let firstTitle = true;

function ensure(linesNeeded = 1) {
  if (page.y - linesNeeded * BODY_LEADING < BOTTOM) {
    pages.push(page);
    page = newPage(pages.length + 1);
  }
}

function addText(text, options = {}) {
  const size = options.size ?? BODY_SIZE;
  const leading = options.leading ?? (size >= 15 ? 22 : size >= 11 ? 17 : BODY_LEADING);
  const font = options.font ?? "F1";
  const color = options.color ?? "0.12 0.18 0.23";
  const indent = options.indent ?? 0;
  const maxWidth = PAGE_W - LEFT - RIGHT - indent;
  const lines = wrap(text, size, maxWidth);
  for (const line of lines) {
    ensure(leading / BODY_LEADING);
    page.commands.push(textCommand(line, LEFT + indent, page.y, size, font, color));
    page.y -= leading;
  }
}

function addSpace(amount = 7) {
  page.y -= amount;
  if (page.y < BOTTOM) {
    pages.push(page);
    page = newPage(pages.length + 1);
  }
}

for (const rawLine of markdown.split(/\r?\n/)) {
  const line = rawLine.trimEnd();
  if (line.trim().startsWith("```")) {
    inCode = !inCode;
    addSpace(3);
    continue;
  }
  if (inCode) {
    addText(line || " ", { size: 8.1, leading: 11, indent: 14, color: "0.20 0.25 0.29" });
    continue;
  }
  if (!line.trim()) {
    addSpace(6);
    continue;
  }
  if (line.startsWith("### ")) {
    addSpace(5);
    addText(line.slice(4), { size: 11.5, leading: 15, font: "F2", color: "0.05 0.29 0.32" });
    continue;
  }
  if (line.startsWith("## ")) {
    addSpace(8);
    addText(line.slice(3), { size: 15, leading: 20, font: "F2", color: "0.05 0.29 0.32" });
    page.commands.push(ruleCommand(page.y + 5));
    page.y -= 7;
    continue;
  }
  if (line.startsWith("# ")) {
    if (!firstTitle) addSpace(8);
    addText(line.slice(2), { size: 20, leading: 25, font: "F2", color: "0.05 0.29 0.32" });
    firstTitle = false;
    continue;
  }
  if (line.startsWith("> ")) {
    addText(line.slice(2), { size: 10, leading: 15, indent: 14, font: "F2", color: "0.42 0.28 0.08" });
    continue;
  }
  if (/^[-*] /.test(line)) {
    const bullet = line.replace(/^[-*] /, "");
    addText(`- ${bullet}`, { indent: 8 });
    continue;
  }
  addText(line);
}

pages.push(page);

const objects = [];
objects.push("<< /Type /Catalog /Pages 2 0 R >>");
objects.push(null); // pages object is filled after page IDs are known
objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

const pageIds = [];
for (const current of pages) {
  const pageId = objects.length + 1;
  const contentId = pageId + 1;
  pageIds.push({ pageId, contentId });
  const content = current.commands.join("\n");
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`);
  objects.push(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
}
objects[1] = `<< /Type /Pages /Kids [${pageIds.map(({ pageId }) => `${pageId} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
const offsets = [0];
for (let i = 0; i < objects.length; i++) {
  offsets.push(Buffer.byteLength(pdf, "latin1"));
  pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}
const xrefOffset = Buffer.byteLength(pdf, "latin1");
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (let i = 1; i <= objects.length; i++) {
  pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
fs.writeFileSync(outputPath, Buffer.from(pdf, "latin1"));
console.log(`Wrote ${outputPath} (${pages.length} pages)`);
