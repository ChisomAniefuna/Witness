export interface SceneObject {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  flagged: boolean;
  description: string;
}

export interface ScanResult {
  objects: SceneObject[];
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
  speakingStyle: string;
}

export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
}

export interface ChatReply {
  reply: string;
  conversationHistory: ChatMessage[];
}

export interface Accusation {
  suspect: string;
  method: string;
  motive: string;
}

export interface Verdict {
  correct: boolean;
  verdict: string;
  explanation: string;
  score: number;
}

export interface CaseFileAnnotation {
  turn: number;
  text: string;
  verdict: 'lie' | 'truth' | 'partial';
  note: string;
}

export interface TimelineStep {
  step: number;
  time: string;
  event: string;
}

export interface CaseFile {
  annotations: CaseFileAnnotation[];
  timeline: TimelineStep[];
}

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

const request = async <T,>(
  path: string,
  payload: unknown,
  timeoutMs: number = 15000
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Request failed: ${response.status}`);
    }

    return response.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
};

export const scanScene = async (imageBase64: string): Promise<ScanResult> => {
  return request<ScanResult>('/api/scan', { imageBase64 });
};

export const generatePersona = async (
  objects: SceneObject[] | string[]
): Promise<WitnessPersona> => {
  if (objects.length === 0) {
    return request<WitnessPersona>('/api/persona', { objectLabels: [] });
  }

  if (typeof objects[0] === 'string') {
    return request<WitnessPersona>('/api/persona', { objectLabels: objects });
  }

  return request<WitnessPersona>('/api/persona', { sceneObjects: objects });
};

export const sendMessage = async (
  message: string,
  conversationHistory: ChatMessage[],
  witnessPersona: WitnessPersona,
  sceneObjects: SceneObject[]
): Promise<ChatReply> => {
  return request<ChatReply>('/api/chat', {
    message,
    conversationHistory,
    witnessPersona,
    sceneObjects
  });
};

export const submitAccusation = async (
  accusation: Accusation,
  witnessPersona: WitnessPersona,
  sceneObjects: SceneObject[]
): Promise<Verdict> => {
  return request<Verdict>('/api/verdict', {
    accusation,
    witnessPersona,
    sceneObjects
  });
};

export const getCaseFile = async (
  conversationHistory: ChatMessage[],
  witnessPersona: WitnessPersona
): Promise<CaseFile> => {
  return request<CaseFile>('/api/casefile', {
    conversationHistory,
    witnessPersona
  });
};
