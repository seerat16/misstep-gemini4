import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Type, type Part } from '@google/genai';
import { sanitizeQuestionKey } from './checker.js';
import { readSpendLedger } from './cost.js';
import {
  decide,
  generateJson,
  type DecisionAnswerChoice,
  type DecisionAnswerNoul,
  type DecisionInputBlock,
  type DecisionQuestion,
} from './gemini.js';
import type { Procedure } from './schemas.js';
import { getEnvSettings, loadConfig } from './settings.js';
import { pregenerateProcedureAlerts, type AlertAudioEntry } from './tts.js';

export type LiveStepStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

export interface LiveStepState {
  step_id: string;
  step_num: number;
  text: string;
  status: LiveStepStatus;
  late: boolean;
  doing_streak: number;
  done_streak: number;
  done_seen_once: boolean;
  p_doing: number;
  p_done: number;
  alerted: boolean;
  first_alert_t_s: number | null;
  done_t_s: number | null;
}

export interface LiveAlertEvent {
  t_s: number;
  tick: number;
  key: string;
  step_id: string;
  text: string;
  url: string | null;
  reason: string;
}

export interface LiveTickLog {
  tick: number;
  t_s: number;
  t_client: number | null;
  frame_files: string[];
  questions: Record<string, DecisionQuestion>;
  answers: Record<string, unknown>;
  alerts: LiveAlertEvent[];
  latency_ms: number;
  cost_usd: number;
}

export interface CompartmentCheck {
  day: 'MON' | 'TUE' | 'WED' | 'THU';
  color: 'BLUE' | 'RED';
  expected: string;
  decisions_choice: string;
  decisions_confidence: number;
  final_choice: string;
  decided_by: 'decisions' | 'carbon';
  match: boolean;
  rationale?: string;
}

export interface LiveFinalReport {
  session_id: string;
  procedure_id: string;
  step_states: LiveStepState[];
  compartments: CompartmentCheck[];
  alerts: LiveAlertEvent[];
  all_compartments_match: boolean;
  total_cost_usd: number;
  median_tick_latency_ms: number;
  still_path: string;
}

export interface LiveSession {
  session_id: string;
  created_at: string;
  started_at_ms: number;
  procedure: Procedure;
  alerts_map: Record<string, AlertAudioEntry>;
  step_states: LiveStepState[];
  alerts_history: LiveAlertEvent[];
  ticks: LiveTickLog[];
  total_cost_usd: number;
  final_report: LiveFinalReport | null;
}

const COMPARTMENT_CARBON_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    count_choice: {
      type: Type.STRING,
      enum: ['0', '1', '2', '3', '4+', 'cannot_tell'],
    },
    rationale: { type: Type.STRING },
  },
  required: ['count_choice', 'rationale'],
};

const MEDPREP_EXPECTED: Record<'MON' | 'TUE' | 'WED' | 'THU', { BLUE: string; RED: string }> = {
  MON: { BLUE: '2', RED: '1' },
  TUE: { BLUE: '2', RED: '0' },
  WED: { BLUE: '2', RED: '1' },
  THU: { BLUE: '2', RED: '0' },
};

export class LiveSessionManager {
  private sessions = new Map<string, LiveSession>();

  private getSessionDir(sessionId: string): string {
    const { runsDir } = getEnvSettings();
    const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(runsDir, 'live', safe);
  }

  private persistSession(session: LiveSession): void {
    const dir = this.getSessionDir(session.session_id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'session.json'),
      JSON.stringify(session, null, 2),
      'utf-8',
    );
  }

  async createSession(procedure: Procedure): Promise<LiveSession> {
    const sessionId = `live_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const alertsMap = await pregenerateProcedureAlerts(procedure);

    const stepStates: LiveStepState[] = procedure.steps.map((s, idx) => ({
      step_id: s.step_id,
      step_num: idx + 1,
      text: s.text,
      status: 'pending',
      late: false,
      doing_streak: 0,
      done_streak: 0,
      done_seen_once: false,
      p_doing: 0,
      p_done: 0,
      alerted: false,
      first_alert_t_s: null,
      done_t_s: null,
    }));

    const session: LiveSession = {
      session_id: sessionId,
      created_at: new Date().toISOString(),
      started_at_ms: Date.now(),
      procedure,
      alerts_map: alertsMap,
      step_states: stepStates,
      alerts_history: [],
      ticks: [],
      total_cost_usd: 0,
      final_report: null,
    };

    this.sessions.set(sessionId, session);
    this.persistSession(session);
    return session;
  }

  getSession(sessionId: string): LiveSession | null {
    const inMem = this.sessions.get(sessionId);
    if (inMem) return inMem;
    const diskPath = path.join(this.getSessionDir(sessionId), 'session.json');
    if (fs.existsSync(diskPath)) {
      const loaded = JSON.parse(fs.readFileSync(diskPath, 'utf-8')) as LiveSession;
      this.sessions.set(sessionId, loaded);
      return loaded;
    }
    return null;
  }

  listSessions(): Array<{
    session_id: string;
    created_at: string;
    procedure_id: string;
    procedure_title: string;
    tick_count: number;
    alert_count: number;
    has_final_report: boolean;
  }> {
    const { runsDir } = getEnvSettings();
    const liveDir = path.join(runsDir, 'live');
    if (!fs.existsSync(liveDir)) return [];
    const entries = fs.readdirSync(liveDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    const out = [];
    for (const d of entries) {
      const sPath = path.join(liveDir, d.name, 'session.json');
      if (!fs.existsSync(sPath)) continue;
      try {
        const s = JSON.parse(fs.readFileSync(sPath, 'utf-8')) as LiveSession;
        out.push({
          session_id: s.session_id,
          created_at: s.created_at,
          procedure_id: s.procedure.procedure_id,
          procedure_title: s.procedure.title,
          tick_count: s.ticks.length,
          alert_count: s.alerts_history.length,
          has_final_report: Boolean(s.final_report),
        });
      } catch {
        // ignore corrupted session file
      }
    }
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async processTick(
    sessionId: string,
    framesB64: string[],
    tClient: number | null = null,
  ): Promise<{
    step_states: LiveStepState[];
    alerts_to_play: LiveAlertEvent[];
    latency_ms: number;
    cost_usd: number;
    total_cost_usd: number;
    global_spend_usd: number;
    activity_choice: string;
  }> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Live session ${sessionId} not found`);
    }
    if (framesB64.length === 0) {
      throw new Error('At least 1 frame is required per tick');
    }

    const t0 = Date.now();
    const config = loadConfig();
    const tickNum = session.ticks.length + 1;
    const tS = Number(((t0 - session.started_at_ms) / 1000).toFixed(2));

    // Save frames to disk for review / field eval
    const tickDir = path.join(this.getSessionDir(sessionId), `tick_${String(tickNum).padStart(4, '0')}`);
    fs.mkdirSync(tickDir, { recursive: true });
    const frameFiles: string[] = [];
    framesB64.forEach((b64, idx) => {
      const cleanB64 = b64.replace(/^data:image\/[a-zA-Z]+;base64,/, '');
      const fName = `frame_${idx + 1}.jpg`;
      fs.writeFileSync(path.join(tickDir, fName), Buffer.from(cleanB64, 'base64'));
      frameFiles.push(fName);
    });

    const inputBlocks: DecisionInputBlock[] = [
      { type: 'text', text: 'Frames are 0.5 s apart, oldest first.\n' },
      ...framesB64.map((b64) => ({
        type: 'image' as const,
        data: b64.replace(/^data:image\/[a-zA-Z]+;base64,/, ''),
        mime_type: 'image/jpeg',
        resolution: 'low' as const,
      })),
    ];

    // Window: first not-done step k, k+1, k+2, plus every step whose prerequisites are all done
    const doneSet = new Set(
      session.step_states.filter((s) => s.status === 'done').map((s) => s.step_id),
    );
    const firstNotDoneIdx = session.step_states.findIndex((s) => s.status !== 'done');
    const windowIndices = new Set<number>();
    if (firstNotDoneIdx >= 0) {
      for (let off = 0; off < 3; off++) {
        if (firstNotDoneIdx + off < session.step_states.length) {
          windowIndices.add(firstNotDoneIdx + off);
        }
      }
    }
    session.procedure.steps.forEach((step, idx) => {
      if (session.step_states[idx].status !== 'done') {
        const prereqsDone = step.must_follow.every((pid) => doneSet.has(pid));
        if (prereqsDone) windowIndices.add(idx);
      }
    });

    const questions: Record<string, DecisionQuestion> = {};
    const stepByIdx = new Map(session.procedure.steps.map((s, i) => [i, s]));

    for (const idx of Array.from(windowIndices).sort((a, b) => a - b)) {
      const step = stepByIdx.get(idx)!;
      const keyDoing = sanitizeQuestionKey(`S${step.step_id}_doing`);
      const keyDone = sanitizeQuestionKey(`S${step.step_id}_done`);
      questions[keyDoing] = {
        type: 'noul',
        instructions: `In these frames, is the person performing: ${step.text}?`,
      };
      questions[keyDone] = {
        type: 'noul',
        instructions: `In these frames, is there visible evidence that this step is complete: ${
          step.visible_evidence.join('; ') || step.text
        }?`,
      };
    }

    const activityCriteria: Record<string, string> = {};
    for (const step of session.procedure.steps) {
      activityCriteria[sanitizeQuestionKey(`step_${step.step_id}`)] = step.text;
    }
    activityCriteria.z_none = 'None of the steps are currently being performed.';
    questions.activity = {
      type: 'choice',
      instructions: 'Which step is the person working on right now?',
      criteria: activityCriteria,
    };

    const res = await decide(inputBlocks, questions, true);
    session.total_cost_usd = Number((session.total_cost_usd + res.costUsd).toFixed(6));

    const activityAns = res.answers.activity as DecisionAnswerChoice | undefined;
    const activeStepKey = activityAns?.choice ?? 'z_none';
    const activeStepIdx = session.procedure.steps.findIndex(
      (s) => sanitizeQuestionKey(`step_${s.step_id}`) === activeStepKey,
    );

    const consecutiveNeeded = config.live.consecutive_ticks;

    for (const idx of windowIndices) {
      const step = session.procedure.steps[idx];
      const state = session.step_states[idx];
      const ansDoing = res.answers[sanitizeQuestionKey(`S${step.step_id}_doing`)] as
        | DecisionAnswerNoul
        | undefined;
      const ansDone = res.answers[sanitizeQuestionKey(`S${step.step_id}_done`)] as
        | DecisionAnswerNoul
        | undefined;

      const pDoing = ansDoing?.noul ?? 0;
      const pDone = ansDone?.noul ?? 0;
      state.p_doing = pDoing;
      state.p_done = pDone;

      if (pDoing >= config.live.p_started_live) {
        state.doing_streak += 1;
        if (state.status === 'pending') {
          state.status = 'in_progress';
        }
      } else {
        state.doing_streak = 0;
      }

      if (pDone >= config.live.p_done_live) {
        state.done_streak += 1;
        state.done_seen_once = true;
      } else {
        state.done_streak = 0;
      }

      const movedPastWithEvidence =
        activeStepIdx > idx && state.done_seen_once && activityAns && activityAns.confidence >= 0.6;

      if (state.done_streak >= consecutiveNeeded || movedPastWithEvidence) {
        if (state.status === 'skipped') {
          state.late = true;
        }
        state.status = 'done';
        state.done_t_s = state.done_t_s ?? tS;
      }
    }

    // Check alerts: if step j is doing (above p_started_live for consecutive_ticks)
    // and a required predecessor i of j isn't done, play skip/order alert for i once
    const alertsToPlay: LiveAlertEvent[] = [];
    for (let j = 0; j < session.procedure.steps.length; j++) {
      const stepJ = session.procedure.steps[j];
      const stateJ = session.step_states[j];
      if (stateJ.doing_streak < consecutiveNeeded) continue;

      for (const predId of stepJ.must_follow) {
        const predIdx = session.procedure.steps.findIndex((s) => s.step_id === predId);
        if (predIdx < 0) continue;
        const predState = session.step_states[predIdx];
        if (predState.status !== 'done' && !predState.alerted) {
          predState.status = 'skipped';
          predState.alerted = true;
          predState.first_alert_t_s = tS;

          const orderKey = `order_${predId}_before_${stepJ.step_id}`;
          const skipKey = `skip_${predId}`;
          const entry = session.alerts_map[orderKey] ?? session.alerts_map[skipKey];
          const ev: LiveAlertEvent = {
            t_s: tS,
            tick: tickNum,
            key: entry?.key ?? skipKey,
            step_id: predId,
            text:
              entry?.text ??
              `Wait. You skipped step ${predState.step_num}: ${predState.text}`,
            url: entry?.url ?? null,
            reason: `Step ${stateJ.step_num} started before step ${predState.step_num} finished`,
          };
          alertsToPlay.push(ev);
          session.alerts_history.push(ev);
        }
      }
    }

    const latencyMs = Date.now() - t0;
    const tickLog: LiveTickLog = {
      tick: tickNum,
      t_s: tS,
      t_client: tClient,
      frame_files: frameFiles,
      questions,
      answers: res.answers,
      alerts: alertsToPlay,
      latency_ms: latencyMs,
      cost_usd: res.costUsd,
    };
    session.ticks.push(tickLog);
    this.persistSession(session);

    return {
      step_states: session.step_states,
      alerts_to_play: alertsToPlay,
      latency_ms: latencyMs,
      cost_usd: res.costUsd,
      total_cost_usd: session.total_cost_usd,
      global_spend_usd: readSpendLedger().total_usd,
      activity_choice: activeStepKey,
    };
  }

  async finishSession(
    sessionId: string,
    stillB64: string,
    customExpected?: Record<'MON' | 'TUE' | 'WED' | 'THU', { BLUE: string; RED: string }>,
  ): Promise<LiveFinalReport> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Live session ${sessionId} not found`);
    }

    const config = loadConfig();
    const cleanStillB64 = stillB64.replace(/^data:image\/[a-zA-Z]+;base64,/, '');
    const stillOutPath = path.join(this.getSessionDir(sessionId), 'finish_still.jpg');
    fs.mkdirSync(path.dirname(stillOutPath), { recursive: true });
    fs.writeFileSync(stillOutPath, Buffer.from(cleanStillB64, 'base64'));

    const days: Array<'MON' | 'TUE' | 'WED' | 'THU'> = ['MON', 'TUE', 'WED', 'THU'];
    const colors: Array<'BLUE' | 'RED'> = ['BLUE', 'RED'];
    const expectedMap = customExpected ?? MEDPREP_EXPECTED;

    const countCriteria: Record<string, string> = {
      '0': '0 tablets visible in the compartment',
      '1': '1 tablet visible in the compartment',
      '2': '2 tablets visible in the compartment',
      '3': '3 tablets visible in the compartment',
      '4+': '4 or more tablets visible in the compartment',
      cannot_tell: 'The compartment count cannot be determined from this image',
    };

    const questions: Record<string, DecisionQuestion> = {};
    for (const day of days) {
      for (const color of colors) {
        questions[`${day}_${color}`] = {
          type: 'choice',
          instructions: `How many ${color} tablets are in the ${day} AM compartment?`,
          criteria: countCriteria,
        };
      }
    }

    const decRes = await decide(
      [
        {
          type: 'image',
          data: cleanStillB64,
          mime_type: 'image/jpeg',
          resolution: 'ultra_high',
        },
      ],
      questions,
      true,
    );
    session.total_cost_usd = Number((session.total_cost_usd + decRes.costUsd).toFixed(6));

    const compartments: CompartmentCheck[] = [];

    for (const day of days) {
      for (const color of colors) {
        const key = `${day}_${color}`;
        const expected = expectedMap[day][color];
        const ans = decRes.answers[key] as DecisionAnswerChoice | undefined;
        const dChoice = ans?.choice ?? 'cannot_tell';
        const dConf = ans?.confidence ?? 0;

        let finalChoice = dChoice;
        let decidedBy: 'decisions' | 'carbon' = 'decisions';
        let rationale: string | undefined;

        if (dChoice !== expected || dConf < 0.7) {
          try {
            const parts: Part[] = [
              {
                inlineData: {
                  data: cleanStillB64,
                  mimeType: 'image/jpeg',
                },
              },
              {
                text: `Inspect this high-resolution overhead image of a 7-day pill organizer.
Focus strictly on the ${day} morning (AM) compartment.
Count the exact number of ${color} tablets in the ${day} AM compartment.
Decisions predicted "${dChoice}" (confidence ${dConf.toFixed(2)}); expected per card is "${expected}".
Return JSON {"count_choice": "0"|"1"|"2"|"3"|"4+"|"cannot_tell", "rationale": "..."}.`,
              },
            ];
            const cRes = await generateJson<{ count_choice: string; rationale: string }>({
              model: config.models.adjudicator,
              parts,
              schema: COMPARTMENT_CARBON_SCHEMA,
              thinkingLevel: config.models.adjudicator_thinking,
              mediaResolution: 'high',
              skipCache: true,
            });
            session.total_cost_usd = Number((session.total_cost_usd + cRes.costUsd).toFixed(6));
            finalChoice = cRes.data.count_choice;
            rationale = cRes.data.rationale;
            decidedBy = 'carbon';
          } catch (err) {
            rationale = `Carbon fallback failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        compartments.push({
          day,
          color,
          expected,
          decisions_choice: dChoice,
          decisions_confidence: Number(dConf.toFixed(3)),
          final_choice: finalChoice,
          decided_by: decidedBy,
          match: finalChoice === expected,
          rationale,
        });
      }
    }

    const latencies = session.ticks.map((t) => t.latency_ms).sort((a, b) => a - b);
    const medianLatency =
      latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : 0;

    const report: LiveFinalReport = {
      session_id: session.session_id,
      procedure_id: session.procedure.procedure_id,
      step_states: session.step_states,
      compartments,
      alerts: session.alerts_history,
      all_compartments_match: compartments.every((c) => c.match),
      total_cost_usd: session.total_cost_usd,
      median_tick_latency_ms: medianLatency,
      still_path: stillOutPath,
    };

    session.final_report = report;
    this.persistSession(session);
    return report;
  }
}

export const liveSessionManager = new LiveSessionManager();
