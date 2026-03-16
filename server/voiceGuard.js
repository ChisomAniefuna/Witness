const SIMILE_PATTERNS = [
  /\blike a\b/gi,
  /\blike an\b/gi,
  /\bas [^.,;!?]+ as\b/gi,
];

const BANNED_WORDS = [
  "haunted",
  "whisper",
  "whispers",
  "shadow",
  "shadows",
  "gothic",
  "noir",
  "specter",
  "phantom",
  "echo",
  "echoes",
  "melancholy",
  "dread",
  "doom",
  "fate",
  "glimmer",
  "shiver",
  "rattle",
  "rattled",
  "rattling",
];

const ADJECTIVES = [
  "dark",
  "cold",
  "silent",
  "broken",
  "bloodied",
  "bloody",
  "rusted",
  "cracked",
  "shattered",
  "dusty",
  "old",
  "new",
  "small",
  "large",
  "heavy",
  "light",
  "wet",
  "dry",
  "slick",
  "empty",
  "full",
  "stained",
  "torn",
  "frayed",
  "bent",
  "burned",
  "charred",
  "faded",
  "dull",
  "bright",
];

const ADJ_REGEX = new RegExp(`\\b(${ADJECTIVES.join("|")})\\b`, "gi");
const ADJ_STACK_REGEX = new RegExp(
  `\\b((?:${ADJECTIVES.join("|")})\\s+){2,}([a-zA-Z][\\w-]*)`,
  "gi"
);

function stripLiteraryLanguage(text) {
  let out = text;
  for (const pattern of SIMILE_PATTERNS) out = out.replace(pattern, "");
  for (const word of BANNED_WORDS) {
    out = out.replace(new RegExp(`\\b${word}\\b`, "gi"), "");
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

function trimAdjectiveStacks(text) {
  if (!text) return text;
  return text.replace(ADJ_STACK_REGEX, (match, group, noun) => {
    const words = group.trim().split(/\s+/);
    const lastAdj = words[words.length - 1] || "";
    return `${lastAdj} ${noun}`;
  });
}

function detectVoiceIssues(text, voice) {
  const issues = [];
  if (!text) return issues;

  if (SIMILE_PATTERNS.some((p) => p.test(text))) issues.push("VOICE_SIMILE");
  if (BANNED_WORDS.some((w) => new RegExp(`\\b${w}\\b`, "i").test(text))) {
    issues.push("VOICE_POETIC");
  }

  if (voice === "scene") {
    if (/\b(I|me|my|we|our|us)\b/i.test(text)) {
      issues.push("SCENE_FIRST_PERSON");
    }
  }

  if (voice === "witness") {
    if (/\b(the witness|the subject)\b/i.test(text)) {
      issues.push("WITNESS_THIRD_PERSON");
    }
  }

  return issues;
}

export function voiceGuard(text, voice = "witness") {
  const input = (text || "").trim();
  const issues = detectVoiceIssues(input, voice);
  let cleaned = stripLiteraryLanguage(input);
  cleaned = trimAdjectiveStacks(cleaned);
  cleaned = cleaned.replace(ADJ_REGEX, (m) => m.toLowerCase());
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  return { text: cleaned, issues };
}
