import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

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
  const model = "gemini-3-flash-preview";
  
  const prompt = `
    You are a forensic scene analyst. The player has pointed their camera at a real room. Analyse the image and return a JSON object with:
    { "objects": [ { "label": string, "x": number, "y": number, "w": number, "h": number, "flagged": boolean, "description": string } ],
      "witnessReaction": string }
    where x/y/w/h are percentage positions of the object in the image (0–100), flagged is true if the object looks suspicious or out of place, and description is one atmospheric sentence. witnessReaction is a short nervous first-person line from the witness reacting to being in this room. Return only JSON, no markdown.
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: base64Image.split(',')[1] || base64Image
            }
          }
        ]
      }
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          witnessReaction: { type: Type.STRING },
          objects: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                label: { type: Type.STRING },
                x: { type: Type.NUMBER },
                y: { type: Type.NUMBER },
                w: { type: Type.NUMBER },
                h: { type: Type.NUMBER },
                flagged: { type: Type.BOOLEAN },
                description: { type: Type.STRING }
              },
              required: ["label", "x", "y", "w", "h", "flagged", "description"]
            }
          }
        },
        required: ["witnessReaction", "objects"]
      }
    }
  });

  return JSON.parse(response.text || '{}');
}

export async function generateWitnessPersona(objects: string[]): Promise<WitnessPersona> {
  const model = "gemini-3-flash-preview";
  const prompt = `
    You are generating a murder mystery witness for a room that contains:
    [${objects.join(', ')}]. Generate a JSON persona:
    { "name": string, "archetype": string, "age": number, "occupation": string, "tells": string[], "openingStatement": string,
      "guiltyOf": string, "secret": string }
    The witness is guilty. openingStatement is what they say when first
    approached — nervous, vague. tells are 2–3 physical habits they have
    when lying. guiltyOf and secret are their true motive and what they
    are hiding. Return only JSON.
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          archetype: { type: Type.STRING },
          age: { type: Type.NUMBER },
          occupation: { type: Type.STRING },
          tells: { type: Type.ARRAY, items: { type: Type.STRING } },
          openingStatement: { type: Type.STRING },
          guiltyOf: { type: Type.STRING },
          secret: { type: Type.STRING }
        },
        required: ["name", "archetype", "age", "occupation", "tells", "openingStatement", "guiltyOf", "secret"]
      }
    }
  });

  return JSON.parse(response.text || '{}');
}

export async function getInterrogationResponse(
  messages: { role: 'user' | 'witness', text: string }[],
  persona: WitnessPersona,
  objects: string[]
): Promise<string> {
  const model = "gemini-3-flash-preview";
  
  const systemInstruction = `
    You are ${persona.name}, a ${persona.archetype}, age ${persona.age}, occupation ${persona.occupation}.
    You are being interrogated about a crime in a room containing:
    [${objects.join(', ')}]. You are guilty. Your secret: ${persona.secret}. Your tells when
    lying: ${persona.tells.join(', ')}. Respond in character — nervous, evasive, occasionally
    slipping. Keep responses under 80 words. Occasionally insert
    [CONTRADICTION] before a statement that contradicts something said
    earlier. Never admit guilt directly.
  `;

  const response = await ai.models.generateContent({
    model,
    contents: messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }]
    })),
    config: {
      systemInstruction
    }
  });

  return response.text || "I... I don't know what to say.";
}

export async function detectContradiction(messages: { role: 'user' | 'witness', text: string }[]): Promise<{ contradiction: boolean, quote: string }> {
  const model = "gemini-3-flash-preview";
  const lastMessages = messages.slice(-6);
  const prompt = `
    Analyze the conversation history. Does the last witness statement contradict anything said earlier?
    Return JSON: { "contradiction": boolean, "quote": string }
    If true, provide the specific contradicting quote from the last message.
    
    History:
    ${lastMessages.map(m => `${m.role.toUpperCase()}: ${m.text}`).join('\n')}
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          contradiction: { type: Type.BOOLEAN },
          quote: { type: Type.STRING }
        },
        required: ["contradiction", "quote"]
      }
    }
  });

  return JSON.parse(response.text || '{"contradiction": false, "quote": ""}');
}

export async function checkSafety(message: string): Promise<{ safe: boolean, reason: string }> {
  const model = "gemini-3-flash-preview";
  const prompt = `
    Does this message contain distress, threats, or inappropriate content? Return JSON: { "safe": boolean, "reason": string }
    Message: "${message}"
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          safe: { type: Type.BOOLEAN },
          reason: { type: Type.STRING }
        },
        required: ["safe", "reason"]
      }
    }
  });

  return JSON.parse(response.text || '{"safe": true, "reason": ""}');
}

export async function getEngagementResponse(persona: WitnessPersona): Promise<string> {
  const model = "gemini-3-flash-preview";
  const prompt = `
    You are ${persona.name}, a ${persona.archetype}. The detective is being quiet or unhelpful.
    Introduce a surprising new plot element, a sudden memory, or a sharp question back to the detective to keep the interrogation moving.
    Keep it under 50 words and stay in character.
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
  });

  return response.text || "Why aren't you saying anything? The silence is deafening.";
}

export async function getAccusationOptions(objects: string[], persona: WitnessPersona): Promise<{ suspects: string[], methods: string[], motives: string[] }> {
  const model = "gemini-3-flash-preview";
  const prompt = `
    Generate options for a murder mystery accusation.
    Room objects: [${objects.join(', ')}]
    Witness: ${persona.name} (${persona.archetype})
    
    Return JSON:
    {
      "suspects": [string, string], // 2 additional suspects besides the witness
      "methods": [string, string, string], // 3 methods based on objects
      "motives": [string, string, string] // 3 motives including the witness's true motive
    }
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          suspects: { type: Type.ARRAY, items: { type: Type.STRING } },
          methods: { type: Type.ARRAY, items: { type: Type.STRING } },
          motives: { type: Type.ARRAY, items: { type: Type.STRING } }
        },
        required: ["suspects", "methods", "motives"]
      }
    }
  });

  return JSON.parse(response.text || '{}');
}

export async function evaluateAccusation(
  accusation: { suspect: string, method: string, motive: string },
  truth: { witness: string, objects: string[], guiltyOf: string }
): Promise<{ correct: boolean, verdict: string, explanation: string }> {
  const model = "gemini-3-flash-preview";
  const prompt = `
    The player accused ${accusation.suspect} using ${accusation.method} motivated by ${accusation.motive}.
    The true answer: ${truth.witness} is guilty, method derived from [${truth.objects.join(', ')}], motive was ${truth.guiltyOf}.
    
    Return JSON: { "correct": boolean, "verdict": string, "explanation": string }
    where verdict is a dramatic one-liner and explanation is a 2-sentence case summary.
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          correct: { type: Type.BOOLEAN },
          verdict: { type: Type.STRING },
          explanation: { type: Type.STRING }
        },
        required: ["correct", "verdict", "explanation"]
      }
    }
  });

  return JSON.parse(response.text || '{}');
}

export async function generateCaseFileTimeline(persona: WitnessPersona, objects: string[]): Promise<string[]> {
  const model = "gemini-3-flash-preview";
  const prompt = `
    Generate 4 steps of what actually happened during the crime based on the witness persona (${persona.name}, ${persona.archetype}, guilty of ${persona.guiltyOf}) and the scene objects ([${objects.join(', ')}]).
    Return a JSON array of 4 strings.
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: { type: Type.STRING }
      }
    }
  });

  const text = response.text || '[]';
  return JSON.parse(text);
}
