const DEFAULT_STATE = {
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

const sessions = new Map();

export function getSessionState(key) {
  if (!sessions.has(key)) {
    sessions.set(key, { ...DEFAULT_STATE });
  }
  return sessions.get(key);
}

export function updateSessionState(key, patch) {
  const current = getSessionState(key);
  sessions.set(key, { ...current, ...patch, updatedAt: Date.now() });
  return sessions.get(key);
}

export function markSpeaker(key, speaker) {
  return updateSessionState(key, { lastSpeaker: speaker });
}

export function incrementContradictions(key) {
  const state = getSessionState(key);
  return updateSessionState(key, {
    contradictionsFound: (state.contradictionsFound || 0) + 1,
  });
}

export function recordQuestion(key, text) {
  if (!text || !text.includes("?")) return getSessionState(key);
  const state = getSessionState(key);
  return updateSessionState(key, {
    questionsAskedBack: (state.questionsAskedBack || 0) + 1,
  });
}
