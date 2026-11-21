import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';

export interface PipelineConfig {
  version: string;
  models: {
    compiler: string;
    compiler_thinking: 'low' | 'medium' | 'high' | 'xhigh';
    localizer: string;
    localizer_thinking: 'low' | 'medium' | 'high' | 'xhigh';
    localizer_processing: 'agentic' | 'static';
    localizer_fps: number;
    decider: string;
    adjudicator: string;
    adjudicator_thinking: 'low' | 'medium' | 'high';
    tts: string;
    tts_voice: string;
  };
  media: {
    full_video_resolution: 'low' | 'medium' | 'high';
    clip_resolution: 'low' | 'medium' | 'high';
    measurement_resolution: 'low' | 'medium' | 'high';
    clip_pad_s: number;
    clip_max_s: number;
  };
  thresholds: {
    missing_p_done_max: number;
    present_p_done_min: number;
    order_tolerance_s: number;
    measurement_error_min: number;
    check_false_min: number;
    uncertain_band: [number, number];
  };
  adjudicator: {
    enabled: boolean;
    max_calls_per_video: number;
    can_veto_errors: boolean;
    can_create_errors_from_ok: boolean;
  };
  questions: {
    done_full: string;
    done_clip: string;
    measurement: string;
    measurement_options: {
      less: string;
      correct: string;
      more: string;
      cannot_tell: string;
    };
    check: string;
  };
  live: {
    tick_s: number;
    frames_per_tick: number;
    frame_interval_ms: number;
    frame_width_px: number;
    p_done_live: number;
    p_started_live: number;
    consecutive_ticks: number;
  };
}

export interface EnvSettings {
  geminiApiKey: string;
  maxUsd: number;
  concurrency: number;
  dataDir: string;
  cacheDir: string;
  runsDir: string;
  configPath: string;
}

export function getEnvSettings(): EnvSettings {
  return {
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    maxUsd: Number(process.env.MISSTEP_MAX_USD || '60'),
    concurrency: Math.max(1, Number(process.env.MISSTEP_CONCURRENCY || '6')),
    dataDir: path.resolve(process.env.MISSTEP_DATA_DIR || './data'),
    cacheDir: path.resolve(process.env.MISSTEP_CACHE_DIR || './cache'),
    runsDir: path.resolve(process.env.MISSTEP_RUNS_DIR || './runs'),
    configPath: path.resolve(process.env.MISSTEP_CONFIG || './configs/pipeline_v1.yaml'),
  };
}

let cachedConfig: { path: string; config: PipelineConfig } | null = null;

export function loadConfig(configPath?: string): PipelineConfig {
  const targetPath = path.resolve(configPath || getEnvSettings().configPath);
  if (cachedConfig && cachedConfig.path === targetPath) {
    return cachedConfig.config;
  }
  const raw = fs.readFileSync(targetPath, 'utf-8');
  const parsed = yaml.load(raw) as PipelineConfig;
  cachedConfig = { path: targetPath, config: parsed };
  return parsed;
}

export function clearConfigCache(): void {
  cachedConfig = null;
}

export function parseConfigYaml(yamlText: string): PipelineConfig {
  return yaml.load(yamlText) as PipelineConfig;
}

export function dumpConfigYaml(config: PipelineConfig): string {
  return yaml.dump(config, { lineWidth: 100, noRefs: true });
}
