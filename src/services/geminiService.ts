import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";

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
  crimeSceneNarrative: string;
  objectConnections: { object: string, significance: string }[];
  avatarUrl?: string;
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
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
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

export async function generateWitnessPersona(detections: { label: string, description: string }[]): Promise<WitnessPersona> {
  const model = "gemini-3-flash-preview";
  const objectsList = detections.map(d => d.label).join(', ');
  
  // Variety injector
  const vibes = ["Noir", "Gothic", "Modern", "Gritty", "Theatrical", "Clinical", "Desperate"];
  const selectedVibe = vibes[Math.floor(Math.random() * vibes.length)];
  const randomSeed = Math.floor(Math.random() * 10000);

  const prompt = `
    Create a unique murder mystery witness for a room with: [${objectsList}].
    Vibe: ${selectedVibe}. Seed: ${randomSeed}.
    The witness is secretly guilty of a crime related to these objects.
    
    Return JSON:
    { 
      "name": string, 
      "archetype": string, 
      "age": number, 
      "occupation": string, 
      "tells": string[], 
      "openingStatement": string,
      "guiltyOf": string, 
      "secret": string,
      "crimeSceneNarrative": string,
      "objectConnections": [ { "object": string, "significance": string } ]
    }
    
    Requirements:
    - name: Use a common, easily recognizable and pronounceable first name (e.g., Jack, Sarah, Michael, Emily, David, Jessica, Thomas, Linda, Robert, Susan). Avoid complex, obscure, or hard-to-pronounce names.
    - crimeSceneNarrative: 2-3 atmospheric sentences of their "official" story.
    - objectConnections: Link 3 objects to their secret crime.
    - tells: 2 unique physical lying habits.
    - guiltyOf: A specific crime (e.g. "Insurance Fraud", "Poisoning").
    
    Return ONLY raw JSON.
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
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
          secret: { type: Type.STRING },
          crimeSceneNarrative: { type: Type.STRING },
          objectConnections: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                object: { type: Type.STRING },
                significance: { type: Type.STRING }
              },
              required: ["object", "significance"]
            }
          }
        },
        required: ["name", "archetype", "age", "occupation", "tells", "openingStatement", "guiltyOf", "secret", "crimeSceneNarrative", "objectConnections"]
      }
    }
  });

  const persona: WitnessPersona = JSON.parse(response.text || '{}');

  // Generate Avatar
  try {
    const imagePrompt = `A cinematic, atmospheric portrait of a murder mystery witness. 
      Name: ${persona.name}. Archetype: ${persona.archetype}. Occupation: ${persona.occupation}. 
      Vibe: ${selectedVibe}. The lighting is moody and dramatic. 
      High quality, detailed face, expressive eyes.`;
    
    const imageResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash-image",
      contents: [{ parts: [{ text: imagePrompt }] }],
      config: {
        imageConfig: {
          aspectRatio: "1:1",
        }
      }
    });

    for (const part of imageResponse.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        persona.avatarUrl = `data:image/png;base64,${part.inlineData.data}`;
        break;
      }
    }
  } catch (err) {
    console.error("Image generation failed:", err);
    // Fallback to a seeded picsum image if generation fails
    persona.avatarUrl = `https://picsum.photos/seed/${persona.name}/400/400`;
  }

  return persona;
}

export async function getInterrogationResponse(
  messages: { role: 'user' | 'witness', text: string }[],
  persona: WitnessPersona,
  objects: string[],
  detectiveName: string
): Promise<string> {
  const model = "gemini-3-flash-preview";
  
  const systemInstruction = `
    You are ${persona.name}, a ${persona.archetype}, age ${persona.age}, occupation ${persona.occupation}.
    You are being interrogated by Detective ${detectiveName} about a crime in a room containing:
    [${objects.join(', ')}]. You are guilty. Your secret: ${persona.secret}. Your tells when
    lying: ${persona.tells.join(', ')}. Respond in character — nervous, evasive, occasionally
    slipping. Keep responses under 80 words. Occasionally address the detective by name (Detective ${detectiveName}).
    Occasionally insert [CONTRADICTION] before a statement that contradicts something said
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
