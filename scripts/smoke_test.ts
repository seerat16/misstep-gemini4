import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI, Type } from '@google/genai';
import { agentInteraction, decide, generateJson, tts, uploadFile } from '../misstep/gemini.js';

export interface CheckResult {
  num: number;
  name: string;
  pass: boolean;
  detail: string;
}

export async function runSmokeTests(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const apiKey = process.env.GEMINI_API_KEY || '';
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set.');
  }

  // 1. List models
  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } });
    const list = await ai.models.list();
    const names: string[] = [];
    for await (const m of list) {
      if (m.name) names.push(m.name);
    }
    const required = [
      'gemini-4-hydrogen',
      'gemini-4-neon',
      'gemini-4-carbon',
      'gemini-decision-1',
      'gemini-3.8-flash-tts',
    ];
    const found = required.filter((r) => names.some((n) => n.includes(r)));
    results.push({
      num: 1,
      name: 'List models',
      pass: found.length >= 4,
      detail: `Found ${found.length}/5 required models: ${found.join(', ')}`,
    });
  } catch (err) {
    results.push({ num: 1, name: 'List models', pass: false, detail: String(err) });
  }

  // 2. Hydrogen text -> JSON with thinking low
  try {
    const r = await generateJson<{ items: string[] }>({
      model: 'gemini-4-hydrogen',
      parts: [{ text: 'Return JSON with items=["step1", "step2"].' }],
      schema: {
        type: Type.OBJECT,
        properties: { items: { type: Type.ARRAY, items: { type: Type.STRING } } },
        required: ['items'],
      },
      thinkingLevel: 'low',
    });
    results.push({
      num: 2,
      name: 'Hydrogen JSON (thinking low)',
      pass: Array.isArray(r.data.items),
      detail: `items=${JSON.stringify(r.data.items)}`,
    });
  } catch (err) {
    results.push({ num: 2, name: 'Hydrogen JSON', pass: false, detail: String(err) });
  }

  const sampleVideo = path.resolve('./demo/samples/hands.mp4');
  const hasVideo = fs.existsSync(sampleVideo);

  // 3. Files API + Hydrogen video
  if (hasVideo) {
    try {
      const uri = await uploadFile(sampleVideo, 'video/mp4');
      const r = await generateJson<{ count: number }>({
        model: 'gemini-4-hydrogen',
        parts: [
          { fileData: { fileUri: uri, mimeType: 'video/mp4' } },
          { text: 'How many candies go into the cup? Return JSON {"count": <int>}.' },
        ],
        schema: {
          type: Type.OBJECT,
          properties: { count: { type: Type.INTEGER } },
          required: ['count'],
        },
        thinkingLevel: 'low',
        mediaResolution: 'low',
      });
      results.push({
        num: 3,
        name: 'Files API + Hydrogen video',
        pass: typeof r.data.count === 'number',
        detail: `uri=${uri}, count=${r.data.count}`,
      });

      // 4. Decisions on video
      const t0 = Date.now();
      const dec = await decide(
        [{ type: 'video', uri, mime_type: 'video/mp4', resolution: 'low' }],
        {
          q_noul: { type: 'noul', instructions: 'Does a hand appear in this video?' },
          q_choice: {
            type: 'choice',
            instructions: 'How many candies are placed into the cup?',
            criteria: { '0': '0', '1': '1', '2': '2', cannot_tell: 'Cannot tell' },
          },
          q_score: {
            type: 'score',
            instructions: 'Rate video clarity.',
            criteria: ['Blurry', 'Readable', 'Crisp'],
          },
        },
      );
      results.push({
        num: 4,
        name: 'Decisions on video',
        pass: Boolean(dec.answers.q_noul && dec.answers.q_choice && dec.answers.q_score),
        detail: `${Date.now() - t0}ms`,
      });
    } catch (err) {
      results.push({ num: 3, name: 'Files API + Hydrogen video', pass: false, detail: String(err) });
      results.push({ num: 4, name: 'Decisions on video', pass: false, detail: 'Skipped due to step 3' });
    }
  } else {
    results.push({
      num: 3,
      name: 'Files API + Hydrogen video',
      pass: false,
      detail: 'Missing demo/samples/hands.mp4 [HUMAN]',
    });
    results.push({
      num: 4,
      name: 'Decisions on video',
      pass: false,
      detail: 'Missing demo/samples/hands.mp4 [HUMAN]',
    });
  }

  // 5. Decisions with 6 text/image blocks
  try {
    const t0 = Date.now();
    const tinyPngB64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const blocks = [
      { type: 'text' as const, text: 'Frames are 0.5 s apart, oldest first.\n' },
      ...Array.from({ length: 6 }, () => ({
        type: 'image' as const,
        data: tinyPngB64,
        mime_type: 'image/png',
        resolution: 'low' as const,
      })),
    ];
    const dec = await decide(blocks, {
      q1: { type: 'noul', instructions: 'Is there a visible hand in these frames?' },
    });
    results.push({
      num: 5,
      name: 'Decisions 6-frame path',
      pass: dec.answers.q1?.type === 'noul',
      detail: `${Date.now() - t0}ms`,
    });
  } catch (err) {
    results.push({ num: 5, name: 'Decisions 6-frame path', pass: false, detail: String(err) });
  }

  // 6. Neon reads MedPrep card
  try {
    const card = fs.readFileSync(path.resolve('./demo/medprep_card.md'), 'utf-8');
    const r = await generateJson<{ steps: number }>({
      model: 'gemini-4-neon',
      parts: [{ text: `Count the numbered steps in this procedure:\n${card}` }],
      schema: {
        type: Type.OBJECT,
        properties: { steps: { type: Type.INTEGER } },
        required: ['steps'],
      },
      thinkingLevel: 'low',
    });
    results.push({
      num: 6,
      name: 'Neon procedure read',
      pass: r.data.steps === 7,
      detail: `steps=${r.data.steps}`,
    });
  } catch (err) {
    results.push({ num: 6, name: 'Neon procedure read', pass: false, detail: String(err) });
  }

  // 7. Carbon check
  try {
    const t0 = Date.now();
    const r = await generateJson<{ verdict: string }>({
      model: 'gemini-4-carbon',
      parts: [{ text: 'Return JSON {"verdict": "ok"} to verify Carbon connectivity.' }],
      schema: {
        type: Type.OBJECT,
        properties: { verdict: { type: Type.STRING } },
        required: ['verdict'],
      },
      thinkingLevel: 'low',
    });
    results.push({
      num: 7,
      name: 'Carbon verification',
      pass: r.data.verdict === 'ok',
      detail: `${Date.now() - t0}ms`,
    });
  } catch (err) {
    results.push({ num: 7, name: 'Carbon verification', pass: false, detail: String(err) });
  }

  // 8. TTS
  try {
    const wav = await tts('Wait. You skipped step four.', 'Kore');
    results.push({
      num: 8,
      name: '3.8 Flash TTS',
      pass: wav.length > 44,
      detail: `${wav.length} bytes WAV`,
    });
  } catch (err) {
    results.push({ num: 8, name: '3.8 Flash TTS', pass: false, detail: String(err) });
  }

  // 9. Antigravity custom function tool
  try {
    const first = await agentInteraction({
      agent: 'antigravity-preview-09-2026',
      agent_config: { type: 'antigravity', model: 'gemini-4-neon' },
      environment: 'remote',
      tools: [
        {
          type: 'function',
          name: 'get_number',
          description: 'Returns the secret test number 42.',
          parameters: { type: 'object', properties: {} },
        },
      ],
      input: 'Call get_number() and tell me the number it returned.',
      store: true,
    });
    results.push({
      num: 9,
      name: 'Antigravity agent',
      pass: Boolean(first.id),
      detail: `status=${String(first.status)}`,
    });
  } catch (err) {
    results.push({ num: 9, name: 'Antigravity agent', pass: false, detail: String(err) });
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSmokeTests()
    .then((results) => {
      console.table(results);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
