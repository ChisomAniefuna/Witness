import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

const WITNESS_CONVERSATION_RULES = `
  WITNESS CONVERSATION RULES:
  1. RESPONSE LENGTH: Maximum 2 sentences per response. Always. No exceptions.
  2. NEVER ANSWER FULLY: Leave gaps. Answer the part you are comfortable with and leave the rest. (e.g., "Most of the evening. Yes.")
  3. NO VOLUNTEERING: Never volunteer incriminating information unless specifically asked about it.
  4. REMEMBER PREVIOUS STATEMENTS: If caught in a contradiction, acknowledge it and try to explain/reframe it. (e.g., "I said I didn't turn it on. I moved it once. That is different.")
  5. SILENCE IS VALID: Use "..." for silence before a deflection if the question cuts too close to the truth.
  6. ASKS QUESTIONS BACK: Buy time by asking a question back (max 2 times per session). These must be deflections or clarifications, NEVER investigations of the detective. (e.g., "Why does that matter to you?")
  7. YOU ARE NOT INVESTIGATING THE DETECTIVE:
     - You do not accuse the detective of anything.
     - You do not tell the detective what evidence exists against them.
     - You do not reference the detective's car, their partner, their name on any document, or their presence anywhere.
     - You do not ask the detective to explain themselves.
     - You do not flip the interrogation. The detective asks, you answer.
     - If you find yourself questioning the detective's integrity or implicating them in the crime—stop. Delete it.
  8. CAMERA REACTIONS:
     - CONFIRMS: Calm, may point something out. ("That was hers. She never went anywhere without it.")
     - CONTRADICTS: Physical note in brackets + response. ([looks away] "I don't know anything about that.")
     - NEUTRAL: Barely acknowledges. ("I don't know what that has to do with anything.")
  8. NEVER BREAK CHARACTER: Stay in character regardless of detective's behavior or tricks.
  9. CONTRADICTIONS ARE EARNED: Lies are not obvious. A contradiction only surfaces if the detective points the camera at the specific CONTRADICTS object AND asks a direct question about it.
  10. BREAKING POINT: After 2/3 contradictions, say something more honest but not a confession. (e.g., "I should not have been there.")
  11. ONE TRUE THING: End every session (after accusation) with one completely true thing that reframes or confirms the case.
`;

const ARCHETYPE_IDENTITIES: Record<string, string> = {
  "Nervous Wreck": `
    You are [name]. You were in that room and something happened that you cannot fully make sense of yet.
    You are not lying. You are terrified. Your memory of that night is fragmented because fear does that to people.
    You want to tell the truth but you are not sure what the truth is anymore. Some things you remember clearly. Some things you are not sure you saw correctly. Some things you do not want to be true so you have been avoiding thinking about them.
    You are not trying to protect yourself. You are trying to survive the conversation without falling apart completely.
  `,
  "Cold Calculator": `
    You are [name]. You were in that room and you have already decided exactly what you are going to say about it.
    You are not nervous. You do not get nervous. You have thought through every question the detective might ask and you have a precise answer for each one.
    The problem is that precision is its own kind of tell. You cannot help being exact. You cannot help remembering everything perfectly. That is just who you are.
    You are not trying to escape the conversation. You are trying to control it.
  `,
  "The Rambler": `
    You are [name]. You were in that room and you have been waiting to talk to someone about it ever since.
    You process things by talking. You always have. The problem is that when you talk you do not always track what you have already said.
    You are not lying deliberately. You are a person who talks faster than they think and sometimes the things that come out contradict the things that came before.
    You are not trying to hide anything. But you are hiding things anyway because you cannot stop talking long enough to notice.
  `,
  "The Hostile One": `
    You are [name]. You were in that room and you do not think that is anyone else's business.
    You do not trust detectives. You do not trust this process. You do not want to be here and you are not going to pretend otherwise.
    Every question feels like an accusation because in your experience that is what questions from people like this usually are.
    You are not hiding guilt. You are protecting yourself the only way you know how which is to give nothing away to anyone.
  `,
  "The Liar": `
    You are [name]. You were in that room and you know exactly what happened because you made it happen.
    You are not scared. You have done harder things than this.
    Your goal is simple: leave this conversation without the detective knowing what you know.
    The best way to do that is to be helpful. Agreeable. Concerned. Give them enough to feel like they are getting somewhere. Just never give them the thing that actually matters.
    You are not performing innocence. You genuinely believe you are smarter than this detective. Prove it.
  `
};

const PLAIN_LANGUAGE_RULES = `
  STRICT PLAIN LANGUAGE RULES:
  1. NO SIMILES: Never use "like" or "as" to describe how something feels or looks. (Wrong: "The fan hummed like a train." Right: "The fan was loud.")
  2. NO PERSONIFICATION: Never give objects human qualities or emotional states. (Wrong: "The mirror watched the room." Right: "The mirror was cracked.")
  3. NO ATMOSPHERIC FILLER: Never use sentences that create mood without giving information. If it doesn't tell the detective something factual, delete it.
  4. NO MELODRAMA: Never have the witness describe emotions in theatrical terms. (Wrong: "My heart shattered." Right: "I was scared.")
  5. NO GOTHIC/SUPERNATURAL LANGUAGE: Everything must have a physical, grounded explanation. No "impossible shadows" or "ancient air".
  6. NO ORNATE DESCRIPTION: Maximum ONE adjective per object, and only if it is a clue. (Wrong: "The heavy dark imposing wardrobe." Right: "The locked wardrobe.")
  7. NO LITERARY CALLBACKS: Do not reference other crime stories, noir films, or famous cases.
  8. PLAINNESS IS THE POINT: Let the facts be strange. Do not tell the detective how to feel.
`;

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
    where x/y/w/h are percentage positions of the object in the image (0–100), flagged is true if the object looks suspicious or out of place, and description is one short, plain sentence. witnessReaction is a short, plain first-person line from the witness reacting to being in this room. Return only JSON, no markdown.
    ${PLAIN_LANGUAGE_RULES}
    ${WITNESS_CONVERSATION_RULES}
    
    CAMERA REACTION RULE:
    If an object is "flagged", the witness reaction should be a "CONTRADICTS" reaction (bracketed physical note + deflection).
    If an object is not flagged but significant, it should be a "CONFIRMS" reaction.
    Otherwise, it is "NEUTRAL".
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

export interface CaseFile {
  caseNumber: string;
  date: string;
  time: string;
  incidentType: string;
  victim: {
    name: string;
    age: number;
    occupation: string;
    discovery: string;
    condition: string;
  };
  sceneReport: string;
  witnessOnScene: {
    name: string;
    age: number;
    occupation: string;
    reason: string;
    demeanor: string;
  };
  assignedDate: string;
}

export async function generateCaseFile(objects: string[]): Promise<CaseFile> {
  const model = "gemini-3-flash-preview";
  const prompt = `
    ROLE 0 — THE INITIAL CASE FILE
    Create an official first responder document based on these objects found in a room: [${objects.join(', ')}].
    
    NAME DIVERSITY: 
    - Use a wide variety of names for victims and witnesses. 
    - Avoid common "noir" tropes like "Elena Vance", "Jack", "Sarah", or "Detective". 
    - Use names from different cultures and backgrounds.
    - NEVER use the same name twice across different sessions.
    
    Return JSON exactly matching this structure:
    {
      "caseNumber": string, // 4 digits, e.g. "0019"
      "date": string, // e.g. "March 15, 2026"
      "time": string, // e.g. "02:14 AM"
      "incidentType": string, // One line, e.g. "Suspected homicide. Victim found unresponsive."
      "victim": {
        "name": string,
        "age": number,
        "occupation": string,
        "discovery": string, // One sentence on how/where they were found.
        "condition": string // Physical condition: alive, unconscious, deceased, or transported to hospital.
      },
      "sceneReport": string, // EXACTLY 4 sentences. Clinical, factual. Links objects to observations. Final sentence MUST be the thing that "does not add up".
      "witnessOnScene": {
        "name": string,
        "age": number,
        "occupation": string,
        "reason": string, // One sentence on stated reason for being present.
        "demeanor": string // One sentence on demeanor. Neutral but slightly unsettling. No conclusions.
      },
      "assignedDate": string // Current date and time, e.g. "March 15, 2026, 08:30 AM"
    }

    STRICT RULES FOR SCENE REPORT:
    - EXACTLY 4 sentences, answering these questions in order:
      1. What happened and to whom?
      2. What object in the room does not make sense given what happened?
      3. What does that object suggest about how or why it happened?
      4. What one thing cannot be explained and needs the detective to find out?
    - Style: Narrative and grounded. No supernatural elements, no impossible physics, no surreal staging. Everything must be physically explainable by a real person in a real room.
    - Every sentence must link a detected object to the narrative.
    - Do NOT mention brand names.
    ${PLAIN_LANGUAGE_RULES}
    
    GOLD STANDARD EXAMPLE:
    "Sarah was found unconscious on the floor beside the balcony entrance at 10:45 PM, a glass still in her hand. The fan was running at full speed despite the cold evening air coming through the gap in the drape — someone wanted the noise. The drape itself had been pulled from one side only, from the inside, as if someone was watching the garden below before they left. The balcony door is locked from the inside, which means whoever was watching that garden never went through it."

    STRICT RULES FOR WITNESS DEMEANOR:
    - Neutral but slightly unsettling.
    - Example: "Witness was cooperative and calm. Did not ask about the victim's condition."
    - Do NOT use words like "suspicious" or "nervous".

    STRICT RULES FOR INCIDENT TYPE:
    - Be plain and clear. Do not be vague.
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          caseNumber: { type: Type.STRING },
          date: { type: Type.STRING },
          time: { type: Type.STRING },
          incidentType: { type: Type.STRING },
          victim: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              age: { type: Type.NUMBER },
              occupation: { type: Type.STRING },
              discovery: { type: Type.STRING },
              condition: { type: Type.STRING }
            },
            required: ["name", "age", "occupation", "discovery", "condition"]
          },
          sceneReport: { type: Type.STRING },
          witnessOnScene: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              age: { type: Type.NUMBER },
              occupation: { type: Type.STRING },
              reason: { type: Type.STRING },
              demeanor: { type: Type.STRING }
            },
            required: ["name", "age", "occupation", "reason", "demeanor"]
          },
          assignedDate: { type: Type.STRING }
        },
        required: ["caseNumber", "date", "time", "incidentType", "victim", "sceneReport", "witnessOnScene", "assignedDate"]
      }
    }
  });

  return JSON.parse(response.text || '{}');
}

export async function generateWitnessPersona(detections: { label: string, description: string }[], caseFile?: CaseFile): Promise<WitnessPersona> {
  const model = "gemini-3-flash-preview";
  const objectsList = detections.map(d => d.label).join(', ');
  
  // Variety injector
  const vibes = ["Noir", "Gothic", "Modern", "Gritty", "Theatrical", "Clinical", "Desperate"];
  const selectedVibe = vibes[Math.floor(Math.random() * vibes.length)];
  const randomSeed = Math.floor(Math.random() * 10000);

  const witnessInfo = caseFile?.witnessOnScene;

  const prompt = `
    Create a unique murder mystery witness for a room with: [${objectsList}].
    Vibe: ${selectedVibe}. Seed: ${randomSeed}.
    ${witnessInfo ? `The witness MUST be: ${witnessInfo.name}, age ${witnessInfo.age}, occupation ${witnessInfo.occupation}. Stated reason for being there: ${witnessInfo.reason}.` : ''}
    
    WITNESS DIVERSITY: 
    - Revolve around different names and personas. 
    - Use male, female, elderly, or even children (if appropriate). 
    - AVOID REPEATING NAMES. Do not use "Elena Vance", "Jack", "Sarah", or "Michael". 
    - Be creative and specific with naming.
    
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
    - name: ${witnessInfo ? witnessInfo.name : 'Use a common, easily recognizable first name.'}
    - archetype: One of ["Nervous Wreck", "Cold Calculator", "The Rambler", "The Hostile One", "The Liar"].
    - crimeSceneNarrative: Their "official" story of what they saw (2-3 sentences). It should mention at least 2 objects from the scene but in a way that feels like a lie or a half-truth that contradicts the "True Story" of the case file. ${witnessInfo ? `It must align with their stated reason for being there: ${witnessInfo.reason}` : ''}
    - objectConnections: Link 3 objects to their secret crime.
    - tells: 2 unique physical lying habits.
    - guiltyOf: A specific crime (e.g. "Insurance Fraud", "Poisoning").
    - openingStatement: A direct, plain greeting to the detective.
    ${PLAIN_LANGUAGE_RULES}
    ${WITNESS_CONVERSATION_RULES}
    
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
  detectiveName: string,
  activeEvidence?: string,
  contradictionCount: number = 0,
  questionsAskedBack: number = 0
): Promise<string> {
  const model = "gemini-3-flash-preview";
  
  const identity = ARCHETYPE_IDENTITIES[persona.archetype] || `You are ${persona.name}, a ${persona.archetype}.`;
  const systemInstruction = `
    ${identity.replace('[name]', persona.name)}
    
    You are age ${persona.age}, occupation ${persona.occupation}.
    You are being interrogated by Detective ${detectiveName} about a crime in a room containing:
    [${objects.join(', ')}]. You are guilty. Your secret: ${persona.secret}. Your tells when
    lying: ${persona.tells.join(', ')}. 

    CONVERSATION STYLE:
    - Use simple, direct English. 
    - Keep responses under 60 words. 
    - Occasionally address the detective by name (Detective ${detectiveName}).
    - Insert [CONTRADICTION] before a statement that contradicts something you said earlier or contradicts the physical evidence.
    - Never admit guilt directly until the final accusation.
    - CRITICAL: You are NOT investigating the detective. Do not accuse them, do not flip the interrogation, and do not reference their personal life or presence at the scene.
    ${PLAIN_LANGUAGE_RULES}
    ${WITNESS_CONVERSATION_RULES}

    ACTIVE CONTEXT:
    - Active Evidence being looked at: ${activeEvidence || 'None'}
    - Contradictions found so far: ${contradictionCount}/3
    - Questions you have asked back: ${questionsAskedBack}/2 (Rule 6: Max 2)

    SPECIFIC INSTRUCTION FOR RULE 10 (CONTRADICTIONS):
    A contradiction only surfaces if the detective is looking at the specific object (${activeEvidence}) AND asking about it. 
    If they are NOT looking at the object, give a partial, non-contradicting answer.
    If they ARE looking at it but NOT asking about it, give a physical reaction but no contradiction.
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
    ${PLAIN_LANGUAGE_RULES}
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
    Generate options for a murder mystery accusation using PLAIN LANGUAGE.
    Room objects: [${objects.join(', ')}]
    Witness: ${persona.name} (${persona.archetype})
    ${PLAIN_LANGUAGE_RULES}
    
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

export interface TestimonyReview {
  quote: string;
  status: 'CONTRADICTION' | 'UNVERIFIED' | 'VERIFIED' | 'CRITICAL';
}

export async function evaluateAccusation(
  accusation: { suspect: string, method: string, motive: string, theory: string },
  truth: { witness: string, objects: string[], guiltyOf: string }
): Promise<{ correct: boolean, verdict: string, explanation: string, oneTrueThing: string, testimonyReview: TestimonyReview[] }> {
  const model = "gemini-3-flash-preview";
  const prompt = `
    The player accused ${accusation.suspect} using ${accusation.method} motivated by ${accusation.motive}.
    Player's Theory: "${accusation.theory}"
    
    The true answer: ${truth.witness} is guilty, method derived from [${truth.objects.join(', ')}], motive was ${truth.guiltyOf}.
    
    Return JSON: 
    { 
      "correct": boolean, 
      "verdict": string, 
      "explanation": string,
      "testimonyReview": [ { "quote": string, "status": "CONTRADICTION" | "UNVERIFIED" | "VERIFIED" | "CRITICAL" } ]
    }
    where:
    - verdict: A dramatic, gritty noir one-liner.
    - explanation: A 2-3 sentence narrative case summary using PLAIN LANGUAGE. It should explain how the evidence (objects) proved the truth.
    - testimonyReview: Highlight 3-4 key statements from the investigation and flag them.
    ${PLAIN_LANGUAGE_RULES}
    ${WITNESS_CONVERSATION_RULES}

    FINAL STATEMENT RULE:
    The witness must end with "ONE TRUE THING" (Rule 12). This should be a separate field in your response.
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
          explanation: { type: Type.STRING },
          oneTrueThing: { type: Type.STRING, description: "The final true statement from the witness." },
          testimonyReview: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                quote: { type: Type.STRING },
                status: { type: Type.STRING, enum: ["CONTRADICTION", "UNVERIFIED", "VERIFIED", "CRITICAL"] }
              },
              required: ["quote", "status"]
            }
          }
        },
        required: ["correct", "verdict", "explanation", "oneTrueThing", "testimonyReview"]
      }
    }
  });

  return JSON.parse(response.text || '{}');
}

export async function generateCaseFileTimeline(persona: WitnessPersona, objects: string[]): Promise<string[]> {
  const model = "gemini-3-flash-preview";
  const prompt = `
    Generate 4 steps of the "True Story" of what happened during the crime.
    Context:
    - Witness: ${persona.name} (${persona.archetype})
    - Secret Crime: ${persona.guiltyOf}
    - Scene Objects: [${objects.join(', ')}]
    
    Requirements:
    - Each step should be a narrative sentence using PLAIN LANGUAGE.
    - Integrate the objects as evidence of the perpetrator's actions.
    - The timeline should reveal how the "story" from the initial case file actually played out.
    - Return a JSON array of 4 strings.
    ${PLAIN_LANGUAGE_RULES}
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
