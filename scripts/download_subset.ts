import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readSplits } from '../datasets/splits.js';
import { getEnvSettings } from '../misstep/settings.js';

async function downloadFileResumable(url: string, destPath: string): Promise<number> {
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 100_000) {
    return fs.statSync(destPath).size;
  }
  const partPath = `${destPath}.part`;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const existingSize = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;

  const headers: Record<string, string> = {};
  if (existingSize > 0) {
    headers.Range = `bytes=${existingSize}-`;
  }

  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  if (!res.body) {
    throw new Error(`Empty response body for ${url}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    throw new Error(`Received HTML instead of video for ${url}`);
  }

  const flags = res.status === 206 && existingSize > 0 ? 'a' : 'w';
  const writeStream = fs.createWriteStream(partPath, { flags });
  await pipeline(Readable.fromWeb(res.body as never), writeStream);

  const finalSize = fs.statSync(partPath).size;
  if (finalSize < 50_000) {
    throw new Error(`Downloaded file too small (${finalSize} bytes) for ${url}`);
  }
  fs.renameSync(partPath, destPath);
  return finalSize;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const splitIdx = argv.indexOf('--split');
  const splitArg = splitIdx >= 0 ? argv[splitIdx + 1] : 'all';
  const concIdx = argv.indexOf('--concurrency');
  const concurrency = Math.max(1, concIdx >= 0 ? Number(argv[concIdx + 1]) : 3);

  const { dataDir } = getEnvSettings();
  const linksPath = path.join(dataDir, 'cc4d_downloader', 'metadata', 'download_links.json');
  if (!fs.existsSync(linksPath)) {
    console.error(`Missing ${linksPath}. Clone CaptainCook4D/downloader first.`);
    process.exit(1);
  }
  const links = JSON.parse(fs.readFileSync(linksPath, 'utf-8')) as Record<
    string,
    Record<string, string>
  >;
  const splits = readSplits();
  const orderedIds =
    splitArg === 'dev'
      ? splits.dev
      : splitArg === 'test'
        ? splits.test
        : [...splits.dev, ...splits.test];

  let totalBytes = 0;
  let completed = 0;
  const queue = [...orderedIds];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) break;
      const entry = links[id];
      const url = entry?.gopro_360p || entry?.data2d || entry?.gopro_2d || entry?.video_360p;
      if (!url) {
        console.warn(`No 360p GoPro link found for recording ${id}`);
        continue;
      }
      const outPath = path.join(dataDir, 'videos', `${id}.mp4`);
      try {
        const bytes = await downloadFileResumable(url, outPath);
        totalBytes += bytes;
        completed += 1;
        console.log(
          `[${completed}/${orderedIds.length}] ${id}.mp4 (${(bytes / 1024 / 1024).toFixed(1)} MB)`,
        );
      } catch (err) {
        console.error(`Failed ${id}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(
    `Done (${splitArg}). ${completed}/${orderedIds.length} files, total: ${(totalBytes / 1024 ** 3).toFixed(2)} GB`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
