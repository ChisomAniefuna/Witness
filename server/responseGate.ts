const DIRECTIVE_PATTERNS: RegExp[] = [
  /\bcheck\b/i,
  /\blook\b/i,
  /\bfind\b/i,
  /\bsearch\b/i,
  /\bgo to\b/i,
  /\bhead to\b/i,
  /\bwhy haven't\b/i,
  /\bwhy dont you\b/i,
  /\bwhy don't you\b/i,
  /\byou should\b/i,
  /\byou need to\b/i,
  /\bmake sure you\b/i,
];

const STOPWORDS = new Set([
  "the",
  "and",
  "that",
  "this",
  "with",
  "have",
  "just",
  "your",
  "you",
  "for",
  "from",
  "they",
  "them",
  "what",
  "when",
  "where",
  "why",
  "how",
  "about",
  "there",
  "their",
  "been",
  "then",
  "were",
  "are",
  "was",
  "is",
  "not",
  "but",
]);

export function countSentences(text: string): number {
  if (!text) return 0;
  const matches = text.match(/[^.!?]+[.!?]+/g);
  if (matches) return matches.length;
  return text.trim().length > 0 ? 1 : 0;
}

export function enforceMaxSentences(text: string, maxSentences = 2): string {
  if (!text) return text;
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  if (sentences.length <= maxSentences) return text.trim();
  return sentences.slice(0, maxSentences).join(" ").trim();
}

function hasDirective(text: string): boolean {
  if (!text) return false;
  return DIRECTIVE_PATTERNS.some((p) => p.test(text));
}

function extractKeywords(text: string): string[] {
  if (!text) return [];
  const words = text.toLowerCase().match(/[a-z]{4,}/g) || [];
  return words.filter((w) => !STOPWORDS.has(w));
}

function hasScopeOverlap(
  responseText: string,
  lastUserMessage: string,
  objectLabels: string[]
): boolean {
  const responseLower = (responseText || "").toLowerCase();
  const labels = (objectLabels || []).map((o) => o.toLowerCase());
  if (labels.some((label) => responseLower.includes(label))) return true;
  const keywords = extractKeywords(lastUserMessage);
  if (keywords.length === 0) return true;
  return keywords.some((k) => responseLower.includes(k));
}

export function responseGate({
  text,
  lastUserMessage,
  state,
  objectLabels,
}: {
  text: string;
  lastUserMessage: string;
  state: { lastSpeaker?: string } | null;
  objectLabels: string[];
}) {
  const issues: string[] = [];
  const sentenceCount = countSentences(text);

  if (state?.lastSpeaker === "witness") issues.push("WRONG_TURN");
  if (sentenceCount > 2) issues.push("TOO_LONG");
  if (hasDirective(text)) issues.push("DIRECTED_DETECTIVE");
  if (!hasScopeOverlap(text, lastUserMessage, objectLabels)) {
    issues.push("SCOPE_DRIFT");
  }

  return {
    ok: issues.length === 0,
    issues,
    text: enforceMaxSentences(text, 2),
  };
}
