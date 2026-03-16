export type SessionState = {
  lastSpeaker: "detective" | "witness";
  contradictionsFound: number;
  questionsAskedBack: number;
  trueThingSaid: boolean;
  accusationMade: boolean;
  breakingPointFired: boolean;
  verdictCorrect: boolean | null;
  oneTrueThingLine: string;
  witnessName: string;
  mysteryContext: string;
  sessionHistory: string[];
  archetype: string;
  updatedAt: number;
};

const DEFAULT_STATE: SessionState = {
  lastSpeaker: "detective",
  contradictionsFound: 0,
  questionsAskedBack: 0,
  trueThingSaid: false,
  accusationMade: false,
  breakingPointFired: false,
  verdictCorrect: null,
  oneTrueThingLine: "",
  witnessName: "",
  mysteryContext: "",
  sessionHistory: [],
  archetype: "UNKNOWN",
  updatedAt: Date.now(),
};

const sessions = new Map<string, SessionState>();

export function getSessionState(key: string): SessionState {
  if (!sessions.has(key)) {
    sessions.set(key, { ...DEFAULT_STATE });
  }
  return sessions.get(key)!;
}

export function updateSessionState(key: string, patch: Partial<SessionState>) {
  const current = getSessionState(key);
  sessions.set(key, { ...current, ...patch, updatedAt: Date.now() });
  return sessions.get(key)!;
}

export function markSpeaker(key: string, speaker: SessionState["lastSpeaker"]) {
  return updateSessionState(key, { lastSpeaker: speaker });
}

export function incrementContradictions(key: string) {
  const state = getSessionState(key);
  return updateSessionState(key, {
    contradictionsFound: (state.contradictionsFound || 0) + 1,
  });
}

export function recordQuestion(key: string, text: string) {
  if (!text || !text.includes("?")) return getSessionState(key);
  const state = getSessionState(key);
  return updateSessionState(key, {
    questionsAskedBack: (state.questionsAskedBack || 0) + 1,
  });
}
