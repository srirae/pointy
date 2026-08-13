/**
 * NVIDIA NIM (OpenAI-compatible) client for the Word onboarding sandbox.
 * Key comes from VITE_NVIDIA_API_KEY — never commit real keys.
 */

export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type PointerTargetId =
  | "file"
  | "home"
  | "insert"
  | "share"
  | "bold"
  | "italic"
  | "styles"
  | "comments"
  | "layout"
  | "review";

export type NimPointerReply = {
  answer: string;
  advice: string;
  target: PointerTargetId | null;
};

const NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NIM_MODEL = "meta/llama-3.3-70b-instruct";

const TARGETS: PointerTargetId[] = [
  "file",
  "home",
  "insert",
  "share",
  "bold",
  "italic",
  "styles",
  "comments",
  "layout",
  "review",
];

const SYSTEM = `You help a user who is stuck inside Microsoft Word.
You can only point at these UI targets: ${TARGETS.join(", ")}.

Respond with ONLY valid JSON (no markdown):
{"answer":"short helpful answer","advice":"one line of practical advice","target":"one of the targets or null"}

Map questions sensibly:
- export / save as / pdf → file
- share / send / collaborate → share
- bold / strong text → bold
- italic → italic
- heading / styles / normal → styles
- comment / feedback → comments
- insert image / table / link → insert
- margins / orientation / page setup → layout
- track changes / review → review
- ribbons / home tab → home
If unclear, target null and still answer helpfully.`;

export function hasNimKey(): boolean {
  return Boolean(import.meta.env.VITE_NVIDIA_API_KEY?.trim());
}

export async function askNim(
  history: ChatMessage[],
  question: string,
): Promise<NimPointerReply> {
  const key = import.meta.env.VITE_NVIDIA_API_KEY?.trim();
  if (!key) {
    return offlineReply(question);
  }

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM },
      ...history.slice(-8),
      { role: "user", content: question },
    ];

    const response = await fetch(NIM_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: NIM_MODEL,
        messages,
        temperature: 0.2,
        top_p: 0.7,
        max_tokens: 400,
        stream: false,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn("NIM error", response.status, detail);
      return offlineReply(question);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return offlineReply(question);
    return parseReply(content, question);
  } catch (error) {
    console.warn("NIM request failed", error);
    return offlineReply(question);
  }
}

function parseReply(raw: string, question: string): NimPointerReply {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return offlineReply(question);
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<NimPointerReply>;
    const target =
      typeof parsed.target === "string" && TARGETS.includes(parsed.target as PointerTargetId)
        ? (parsed.target as PointerTargetId)
        : null;
    return {
      answer: String(parsed.answer ?? "").trim() || offlineReply(question).answer,
      advice: String(parsed.advice ?? "").trim() || offlineReply(question).advice,
      target,
    };
  } catch {
    return offlineReply(question);
  }
}

/** Deterministic demo answers when no key / NIM is unreachable. */
export function offlineReply(question: string): NimPointerReply {
  const q = question.toLowerCase();

  if (/(share|send|collaborat)/.test(q)) {
    return {
      answer: "Use Share in the top-right of the Word window.",
      advice: "That’s the fastest way to send a link or invite people.",
      target: "share",
    };
  }
  if (/(export|pdf|save as)/.test(q)) {
    return {
      answer: "Open the File menu — Export / Save As lives there.",
      advice: "File is always the top-left entry for document-level actions.",
      target: "file",
    };
  }
  if (/bold|strong/.test(q)) {
    return {
      answer: "Select your text, then click Bold on the Home ribbon.",
      advice: "Or press Ctrl+B — same command.",
      target: "bold",
    };
  }
  if (/italic/.test(q)) {
    return {
      answer: "Highlight the words, then click Italic on the Home ribbon.",
      advice: "Ctrl+I toggles italic without leaving the keyboard.",
      target: "italic",
    };
  }
  if (/(heading|style|title|normal)/.test(q)) {
    return {
      answer: "On the Home ribbon, open Styles and pick Heading 1 (or another style).",
      advice: "Styles keep the whole document consistent.",
      target: "styles",
    };
  }
  if (/comment|feedback/.test(q)) {
    return {
      answer: "Open the Review tab, then click New Comment.",
      advice: "Comments sit in the margin so the draft stays clean.",
      target: "comments",
    };
  }
  if (/(insert|image|table|link|picture)/.test(q)) {
    return {
      answer: "Switch to the Insert tab — pictures, tables, and links are there.",
      advice: "Insert is for adding things; Home is for formatting what’s already there.",
      target: "insert",
    };
  }
  if (/(margin|layout|orient|page setup)/.test(q)) {
    return {
      answer: "Open Layout for margins, orientation, and page size.",
      advice: "Page setup almost never lives under Home.",
      target: "layout",
    };
  }
  if (/(track change|review|suggest)/.test(q)) {
    return {
      answer: "Go to Review to track changes and manage comments.",
      advice: "Review is the editing-collaboration hub in Word.",
      target: "review",
    };
  }

  return {
    answer:
      "Ask about something on this Word screen — Share, File, Bold, Styles, Insert, Layout, or Review.",
    advice: "I’ll answer in the glass chat and point at the control inside Word.",
    target: null,
  };
}
