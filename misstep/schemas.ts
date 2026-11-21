import { z } from 'zod';
import { Type, type Schema } from '@google/genai';

export const ErrorCategoryEnum = z.enum([
  'missing_step',
  'order',
  'measurement',
  'technique',
  'preparation',
  'timing',
  'temperature',
  'other',
]);
export type ErrorCategory = z.infer<typeof ErrorCategoryEnum>;

export const ALL_ERROR_CATEGORIES: ErrorCategory[] = [
  'missing_step',
  'order',
  'measurement',
  'technique',
  'preparation',
  'timing',
  'temperature',
  'other',
];

export const QuantitySchema = z.object({
  item: z.string(),
  amount: z.string(),
  unit: z.string(),
});
export type Quantity = z.infer<typeof QuantitySchema>;

export const VisualCheckSchema = z.object({
  check_id: z.string(),
  text: z.string(),
  category: ErrorCategoryEnum,
});
export type VisualCheck = z.infer<typeof VisualCheckSchema>;

export const StepSchema = z.object({
  step_id: z.string(),
  text: z.string(),
  visible_evidence: z.array(z.string()),
  quantity: QuantitySchema.nullable().optional(),
  checks: z.array(VisualCheckSchema).default([]),
  must_follow: z.array(z.string()).default([]),
  optional: z.boolean().default(false),
  checkable: z.boolean().default(true),
});
export type Step = z.infer<typeof StepSchema>;

export const ProcedureSchema = z.object({
  procedure_id: z.string(),
  title: z.string(),
  source: z.enum(['cc4d', 'medprep', 'upload']),
  steps: z.array(StepSchema),
});
export type Procedure = z.infer<typeof ProcedureSchema>;

export const StepWindowSchema = z.object({
  step_id: z.string(),
  found: z.boolean(),
  start_s: z.number().nullable().optional(),
  end_s: z.number().nullable().optional(),
  note: z.string().default(''),
});
export type StepWindow = z.infer<typeof StepWindowSchema>;

export const StepCheckSchema = z.object({
  step_id: z.string(),
  p_done_full: z.number(),
  p_done_clip: z.number().nullable().optional(),
  measurement_probs: z.record(z.string(), z.number()).nullable().optional(),
  check_p_true: z.record(z.string(), z.number()).default({}),
});
export type StepCheck = z.infer<typeof StepCheckSchema>;

export const EvidenceSchema = z.object({
  t_s: z.number().nullable().optional(),
  text: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const StepVerdictSchema = z.object({
  step_id: z.string(),
  status: z.enum(['ok', 'error', 'uncertain', 'not_checkable']),
  categories: z.array(ErrorCategoryEnum).default([]),
  p_error: z.number().min(0).max(1),
  decided_by: z.enum(['rules', 'carbon']).default('rules'),
  evidence: z.array(EvidenceSchema).default([]),
});
export type StepVerdict = z.infer<typeof StepVerdictSchema>;

export const RunResultSchema = z.object({
  run_id: z.string(),
  system: z.string(),
  config_version: z.string(),
  recording_id: z.string().nullable().optional(),
  procedure_id: z.string(),
  windows: z.array(StepWindowSchema).default([]),
  checks: z.array(StepCheckSchema).default([]),
  verdicts: z.array(StepVerdictSchema),
  cost_usd: z.number(),
  latency_s: z.number(),
  errors: z.array(z.string()).default([]),
});
export type RunResult = z.infer<typeof RunResultSchema>;

export const GoldStepSchema = z.object({
  step_id: z.string(),
  has_error: z.boolean(),
  categories: z.array(ErrorCategoryEnum).default([]),
  start_s: z.number().nullable().optional(),
  end_s: z.number().nullable().optional(),
  description: z.string().default(''),
});
export type GoldStep = z.infer<typeof GoldStepSchema>;

export const GoldRecordingSchema = z.object({
  recording_id: z.string(),
  activity_id: z.string(),
  is_error: z.boolean(),
  duration_s: z.number(),
  steps: z.array(GoldStepSchema),
});
export type GoldRecording = z.infer<typeof GoldRecordingSchema>;

export const AdjudicatorVerdictSchema = z.object({
  verdict: z.enum(['error', 'ok', 'cannot_tell']),
  categories: z.array(ErrorCategoryEnum).default([]),
  rationale: z.string(),
  evidence_s: z.number().nullable().optional(),
});
export type AdjudicatorVerdict = z.infer<typeof AdjudicatorVerdictSchema>;

export const BaselineStepPredictionSchema = z.object({
  step_id: z.string(),
  has_error: z.boolean(),
  categories: z.array(ErrorCategoryEnum).default([]),
  confidence: z.number().min(0).max(1),
  evidence_s: z.number().nullable().optional(),
});
export type BaselineStepPrediction = z.infer<typeof BaselineStepPredictionSchema>;

// Gemini structured output JSON schemas using @google/genai Type enum
export const PROCEDURE_GEMINI_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    procedure_id: { type: Type.STRING },
    title: { type: Type.STRING },
    source: { type: Type.STRING, enum: ['cc4d', 'medprep', 'upload'] },
    steps: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          step_id: { type: Type.STRING },
          text: { type: Type.STRING },
          visible_evidence: { type: Type.ARRAY, items: { type: Type.STRING } },
          quantity: {
            type: Type.OBJECT,
            nullable: true,
            properties: {
              item: { type: Type.STRING },
              amount: { type: Type.STRING },
              unit: { type: Type.STRING },
            },
            required: ['item', 'amount', 'unit'],
          },
          checks: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                check_id: { type: Type.STRING },
                text: { type: Type.STRING },
                category: {
                  type: Type.STRING,
                  enum: ALL_ERROR_CATEGORIES,
                },
              },
              required: ['check_id', 'text', 'category'],
            },
          },
          must_follow: { type: Type.ARRAY, items: { type: Type.STRING } },
          optional: { type: Type.BOOLEAN },
          checkable: { type: Type.BOOLEAN },
        },
        required: ['step_id', 'text', 'visible_evidence', 'checks', 'must_follow', 'optional', 'checkable'],
      },
    },
  },
  required: ['procedure_id', 'title', 'source', 'steps'],
};

export const LOCALIZER_GEMINI_SCHEMA: Schema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      step_id: { type: Type.STRING },
      found: { type: Type.BOOLEAN },
      start_s: { type: Type.NUMBER, nullable: true },
      end_s: { type: Type.NUMBER, nullable: true },
      note: { type: Type.STRING },
    },
    required: ['step_id', 'found'],
  },
};

export const ADJUDICATOR_GEMINI_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    verdict: { type: Type.STRING, enum: ['error', 'ok', 'cannot_tell'] },
    categories: {
      type: Type.ARRAY,
      items: { type: Type.STRING, enum: ALL_ERROR_CATEGORIES },
    },
    rationale: { type: Type.STRING },
    evidence_s: { type: Type.NUMBER, nullable: true },
  },
  required: ['verdict', 'categories', 'rationale'],
};

export const BASELINE_GEMINI_SCHEMA: Schema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      step_id: { type: Type.STRING },
      has_error: { type: Type.BOOLEAN },
      categories: {
        type: Type.ARRAY,
        items: { type: Type.STRING, enum: ALL_ERROR_CATEGORIES },
      },
      confidence: { type: Type.NUMBER },
      evidence_s: { type: Type.NUMBER, nullable: true },
    },
    required: ['step_id', 'has_error', 'categories', 'confidence'],
  },
};
