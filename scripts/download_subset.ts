import fs from 'node:fs';
import path from 'node:path';
import { readSplits } from '../datasets/splits.js';
import { getEnvSettings } from '../misstep/settings.js';

async function downloadFileResumable(url: string, destPath: string): Promise<void> {
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
    return;
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
  const arrayBuf = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  if (res.status === 206 && existingSize > 0) {
    fs.appendFileSync(partPath, buf);
  } else {
    fs.writeFileSync(partPath, buf);
  }
  fs.renameSync(partPath, destPath);
}

async function main(): Promise<void> {
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
  const orderedIds = [...splits.dev, ...splits.test];

  let totalBytes = 0;
  for (const id of orderedIds) {
    const entry = links[id];
    const url = entry?.gopro_360p || entry?.data2d || entry?.gopro_2d || entry?.video_360p;
    if (!url) {
      console.warn(`No 360p GoPro link found for recording ${id}`);
      continue;
    }
    const outPath = path.join(dataDir, 'videos', `${id}.mp4`);
    console.log(`Downloading ${id} -> ${outPath}`);
    await downloadFileResumable(url, outPath);
    totalBytes += fs.statSync(outPath).size;
  }
  console.log(`Done. Total downloaded: ${(totalBytes / 1024 ** 3).toFixed(2)} GB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
