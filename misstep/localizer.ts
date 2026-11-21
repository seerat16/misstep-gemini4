import type { Part } from '@google/genai';
import { generateJson } from './gemini.js';
import { LOCALIZER_PROMPT, fillTemplate } from './prompts.js';
import {
  LOCALIZER_GEMINI_SCHEMA,
  StepWindowSchema,
  type Procedure,
  type StepWindow,
} from './schemas.js';
import type { PipelineConfig } from './settings.js';

export async function localize(
  videoUri: string,
  procedure: Procedure,
  durationS: number,
  config: PipelineConfig,
): Promise<{ windows: StepWindow[]; costUsd: number; notes: string[] }> {
  const stepsText = procedure.steps
    .map(
      (s) =>
        `- [${s.step_id}] ${s.text}\n  Visible evidence: ${s.visible_evidence.join('; ')}`,
    )
    .join('\n');

  const prompt = fillTemplate(LOCALIZER_PROMPT, {
    steps_with_ids_and_evidence: stepsText,
  });

  const videoPart: Record<string, unknown> = {
    fileData: {
      fileUri: videoUri,
      mimeType: 'video/mp4',
    },
  };

  if (config.models.localizer_processing === 'agentic') {
    videoPart.videoMetadata = {
      fps: config.models.localizer_fps,
    };
  } else {
    videoPart.videoMetadata = {
      fps: config.models.localizer_fps,
    };
  }

  const notes: string[] = [];
  let res;
  try {
    res = await generateJson<Array<Partial<StepWindow>>>({
      model: config.models.localizer,
      parts: [videoPart as unknown as Part, { text: prompt }],
      schema: LOCALIZER_GEMINI_SCHEMA,
      thinkingLevel: config.models.localizer_thinking,
      mediaResolution: config.media.full_video_resolution,
    });
  } catch (err) {
    notes.push(`localizer_fallback: ${err instanceof Error ? err.message : String(err)}`);
    res = await generateJson<Array<Partial<StepWindow>>>({
      model: config.models.localizer,
      parts: [
        {
          fileData: {
            fileUri: videoUri,
            mimeType: 'video/mp4',
          },
        } as Part,
        { text: prompt },
      ],
      schema: LOCALIZER_GEMINI_SCHEMA,
      thinkingLevel: config.models.localizer_thinking,
      mediaResolution: 'low',
    });
  }

  const byId = new Map<string, StepWindow>();
  for (const raw of res.data ?? []) {
    if (!raw.step_id || byId.has(raw.step_id)) continue;
    let found = Boolean(raw.found);
    let startS = typeof raw.start_s === 'number' && Number.isFinite(raw.start_s) ? raw.start_s : null;
    let endS = typeof raw.end_s === 'number' && Number.isFinite(raw.end_s) ? raw.end_s : null;
    let note = raw.note ?? '';

    if (found && startS !== null && endS === null) {
      endS = Math.min(durationS > 0 ? durationS : startS + 20, startS + 20);
      note = `${note} [synthesized end_s=+20s]`.trim();
    }

    if (found && startS !== null && endS !== null) {
      startS = Math.max(0, Math.min(durationS, startS));
      endS = Math.max(0, Math.min(durationS, endS));
      if (endS <= startS) {
        found = false;
        startS = null;
        endS = null;
        note = `${note} [dropped: invalid start>=end]`.trim();
      } else if (durationS > 0 && endS - startS > durationS * 0.5) {
        // PLAN Phase 3 task 3: drop windows longer than 50% of video
        found = false;
        startS = null;
        endS = null;
        note = `${note} [dropped: window > 50% of video duration]`.trim();
      }
    } else {
      found = false;
      startS = null;
      endS = null;
    }

    byId.set(
      raw.step_id,
      StepWindowSchema.parse({
        step_id: raw.step_id,
        found,
        start_s: startS,
        end_s: endS,
        note,
      }),
    );
  }

  // Ensure every procedure step appears exactly once
  const windows: StepWindow[] = procedure.steps.map((step) => {
    return (
      byId.get(step.step_id) ?? {
        step_id: step.step_id,
        found: false,
        start_s: null,
        end_s: null,
        note: 'missing from localizer response',
      }
    );
  });

  return { windows, costUsd: res.costUsd, notes };
}
