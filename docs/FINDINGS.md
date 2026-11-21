# FINDINGS (verified by real file inspection & SDK implementation)

## SDK & API Integration (`@google/genai` TypeScript SDK)
- **Runtime**: Node.js 22 + TypeScript (`tsx`) + `ffmpeg` / `ffprobe`
- **Structured output (`generateJson`)**: `ai.models.generateContent({ model, contents, config: { responseMimeType: 'application/json', responseSchema, thinkingConfig, mediaResolution } })`. No `temperature`, `topP`, `topK`, or `thinkingBudget` parameters (Gemini 4 returns 400 on sampling params).
- **Thinking levels**: `ThinkingLevel.LOW | MEDIUM | HIGH | XHIGH` (`minimal` is omitted for Gemini 4 compatibility).
- **v1beta endpoints (`createDecisionsClient`)**: Live smoke tests verified that `gemini-decision-1`, `gemini-3.8-flash-tts` (`speechConfig`), and `antigravity-preview-09-2026` (`environment: 'remote'`) ALL require `apiVersion: 'v1beta'` on the `GoogleGenAI` client.
- **Decisions API (`gemini-decision-1`)**: Verified live 6-frame call (~652 ms). Input blocks use `snake_case` (`mime_type`, `resolution: 'low' | 'medium' | 'high' | 'ultra_high'`); question keys match `[A-Za-z0-9_-]{1,64}`; returns 0 output tokens and calibrated `noul`, `choice`, and `score` fields.
- **TTS (`gemini-3.8-flash-tts`)**: Verified live on `v1beta` (`134,428` bytes WAV for `"Wait. You skipped step four."`). Unary `generateContent` returns a complete RIFF/WAV (24 kHz mono 16-bit PCM with 44-byte header) directly in `candidates[0].content.parts[0].inlineData.data`.
- **Antigravity (`antigravity-preview-09-2026`)**: Verified live on `v1beta` returning `status: 'requires_action'` for custom function tool `get_number()`. Invoked via `ai.interactions.create` without `response_format`.

## Dataset & Split Design (`datasets/cc4d.ts`, `datasets/splits.ts`)
- **Annotation files used**:
  - `data/cc4d_annotations/annotation_json/activity_idx_step_idx.json` (recipe step sequences deduplicated in first-seen order)
  - `data/cc4d_annotations/annotation_json/step_idx_description.json`
  - `data/cc4d_annotations/annotation_json/error_annotations.json` (384 recording entries array) + `step_annotations.json`
  - `data/cc4d_annotations/metadata/video_information.csv` (`duration(sec)`)
  - `data/cc4d_downloader/metadata/download_links.json` (`gopro_360p` links)
- **Category strings (`error_category_idx.json`)**: `Preparation Error`, `Measurement Error`, `Order Error`, `Timing Error`, `Technique Error`, `Temperature Error`, `Missing Step`, `Other`.
- **Missing step representation**: Entries in `error_annotations.json` with `tag: "Missing Step"` have `start_time: -1, end_time: -1` and `modified_description: "Skipped this step"`. Steps performed multiple times are collapsed into one evaluation unit (`has_error = any(...)`, `categories = union`).
- **Task graph format (`task_graphs/*.json`)**: Object with `"steps"` (including `"0": "START"` and terminal `"END"`) and `"edges": [[from, to], ...]`, matched via recipe name slug (`activity_step_description.csv`), filtering synthetic START/END nodes.
- **Generated splits (`data/splits.json`, seed `20261121`, 384 gold recordings in `data/gold.jsonl`)**:
  - `dev`: 16 recordings, 210 steps, 59 error steps, 2.90 hours (`low_n`: `temperature`, `other`)
  - `test`: 40 recordings (6 held-out disjoint recipes), 453 steps, 169 error steps, 6.47 hours (`low_n`: `other`)
- **Subset bias note**: `pickBalanced` prioritizes recordings `<= 900s` (15 minutes) to fit processing latency and token budgets cleanly.
