const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";

export interface SceneAnalysis {
  objects: {
    label: string;
    x: number;
    y: number;
    w: number;
    h: number;
    flagged: boolean;
    description: string;
  }[];
  witnessReaction: string;
}

export interface WitnessPersona {
  name: string;
  archetype: string;
  age: number;
  occupation: string;
  tells: string[];
  openingStatement: string;
  guiltyOf: string;
  secret: string;
}

export async function analyzeScene(base64Image: string): Promise<SceneAnalysis> {
  const res = await fetch(`${API_BASE}/api/scene-analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: base64Image }),
  });
  if (!res.ok) {
    throw new Error("Scene analysis failed");
  }
  return res.json();
}

export async function generateWitnessPersona(objects: string[]): Promise<WitnessPersona> {
  const res = await fetch(`${API_BASE}/api/witness-persona`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ objects }),
  });
  if (!res.ok) {
    throw new Error("Witness persona failed");
  }
  return res.json();
}

export async function getInterrogationResponse(
  messages: { role: 'user' | 'witness', text: string }[],
  persona: WitnessPersona,
  objects: string[]
): Promise<string> {
  const res = await fetch(`${API_BASE}/api/interrogation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, persona, objects }),
  });
  if (!res.ok) {
    throw new Error("Interrogation failed");
  }
  const data = await res.json();
  return data.text;
}

export async function detectContradiction(messages: { role: 'user' | 'witness', text: string }[]): Promise<{ contradiction: boolean, quote: string }> {
  const res = await fetch(`${API_BASE}/api/contradiction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) {
    throw new Error("Contradiction check failed");
  }
  return res.json();
}

export async function checkSafety(message: string): Promise<{ safe: boolean, reason: string }> {
  const res = await fetch(`${API_BASE}/api/safety`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    throw new Error("Safety check failed");
  }
  return res.json();
}

export async function getEngagementResponse(persona: WitnessPersona): Promise<string> {
  const res = await fetch(`${API_BASE}/api/engagement`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ persona }),
  });
  if (!res.ok) {
    throw new Error("Engagement failed");
  }
  const data = await res.json();
  return data.text;
}

export async function getAccusationOptions(objects: string[], persona: WitnessPersona): Promise<{ suspects: string[], methods: string[], motives: string[] }> {
  const res = await fetch(`${API_BASE}/api/accusation-options`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ objects, persona }),
  });
  if (!res.ok) {
    throw new Error("Accusation options failed");
  }
  return res.json();
}

export async function evaluateAccusation(
  accusation: { suspect: string, method: string, motive: string },
  truth: { witness: string, objects: string[], guiltyOf: string }
): Promise<{ correct: boolean, verdict: string, explanation: string }> {
  const res = await fetch(`${API_BASE}/api/evaluate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accusation, truth }),
  });
  if (!res.ok) {
    throw new Error("Evaluate accusation failed");
  }
  return res.json();
}

export async function generateCaseFileTimeline(persona: WitnessPersona, objects: string[]): Promise<string[]> {
  const res = await fetch(`${API_BASE}/api/casefile-timeline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ persona, objects }),
  });
  if (!res.ok) {
    throw new Error("Casefile timeline failed");
  }
  return res.json();
}
