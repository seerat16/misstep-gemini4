import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { getEnvSettings } from './settings.js';

const execFileAsync = promisify(execFile);

export interface VideoProbe {
  duration_s: number;
  width: number;
  height: number;
  fps: number;
}

export async function probe(videoPath: string): Promise<VideoProbe> {
  const abs = path.resolve(videoPath);
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=width,height,r_frame_rate,codec_type',
      '-of',
      'json',
      abs,
    ]);
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        r_frame_rate?: string;
      }>;
    };
    const vStream = (parsed.streams ?? []).find((s) => s.codec_type === 'video') ?? parsed.streams?.[0];
    let fps = 30;
    if (vStream?.r_frame_rate) {
      const [num, den] = vStream.r_frame_rate.split('/').map(Number);
      if (num && den) fps = Number((num / den).toFixed(3));
      else if (num) fps = num;
    }
    return {
      duration_s: Number(parsed.format?.duration ?? 0),
      width: Number(vStream?.width ?? 0),
      height: Number(vStream?.height ?? 0),
      fps,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return { duration_s: 60, width: 640, height: 360, fps: 30 };
    }
    throw err;
  }
}

export async function clip(
  videoPath: string,
  startS: number,
  endS: number,
  outPath: string,
  padS = 2.0,
  durationS?: number,
): Promise<string> {
  const absOut = path.resolve(outPath);
  if (fs.existsSync(absOut) && fs.statSync(absOut).size > 0) {
    return absOut;
  }
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  const totalDur = durationS ?? (await probe(videoPath)).duration_s;
  const ss = Math.max(0, startS - padS);
  const to = Math.min(totalDur || endS + padS, endS + padS);
  const safeTo = Math.max(ss + 0.5, to);

  await execFileAsync('ffmpeg', [
    '-y',
    '-ss',
    ss.toFixed(3),
    '-to',
    safeTo.toFixed(3),
    '-i',
    path.resolve(videoPath),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '28',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    absOut,
  ]);
  return absOut;
}

export function getClipCachePath(
  recordingId: string,
  stepId: string,
  startS: number,
  endS: number,
): string {
  const { cacheDir } = getEnvSettings();
  const safeRec = recordingId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeStep = stepId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(
    cacheDir,
    'clips',
    safeRec,
    `${safeStep}_${startS.toFixed(1)}_${endS.toFixed(1)}.mp4`,
  );
}

export async function still(
  videoPath: string,
  tS: number,
  outPath: string,
  width?: number,
): Promise<string> {
  const absOut = path.resolve(outPath);
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  const args = ['-y', '-ss', Math.max(0, tS).toFixed(3), '-i', path.resolve(videoPath), '-frames:v', '1'];
  if (width) {
    args.push('-vf', `scale=${width}:-2`);
  }
  args.push('-q:v', '2', absOut);
  await execFileAsync('ffmpeg', args);
  return absOut;
}

export async function frames(videoPath: string, fps: number, outDir: string): Promise<string[]> {
  const absDir = path.resolve(outDir);
  fs.mkdirSync(absDir, { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    path.resolve(videoPath),
    '-vf',
    `fps=${fps}`,
    '-q:v',
    '3',
    path.join(absDir, 'frame_%04d.jpg'),
  ]);
  return fs
    .readdirSync(absDir)
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .map((f) => path.join(absDir, f));
}

export async function applyStressTransform(
  inputPath: string,
  outPath: string,
  transform: '240p' | '144p' | 'low_light' | 'occlusion' | 'speed_2x',
): Promise<string> {
  const absOut = path.resolve(outPath);
  if (fs.existsSync(absOut) && fs.statSync(absOut).size > 0) {
    return absOut;
  }
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  const args = ['-y', '-i', path.resolve(inputPath)];

  switch (transform) {
    case '240p':
      args.push('-vf', 'scale=-2:240', '-c:a', 'copy');
      break;
    case '144p':
      args.push('-vf', 'scale=-2:144', '-c:a', 'copy');
      break;
    case 'low_light':
      args.push('-vf', 'eq=brightness=-0.25:contrast=0.8', '-c:a', 'copy');
      break;
    case 'occlusion':
      args.push(
        '-vf',
        'drawbox=x=iw*0.3:y=ih*0.3:w=iw*0.3:h=ih*0.3:color=black:t=fill',
        '-c:a',
        'copy',
      );
      break;
    case 'speed_2x':
      args.push('-vf', 'setpts=0.5*PTS', '-af', 'atempo=2.0');
      break;
  }
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', absOut);
  await execFileAsync('ffmpeg', args);
  return absOut;
}
