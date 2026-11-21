import { readGoldJsonl } from '../datasets/cc4d.js';
import { buildSplits, summarizeSplit } from '../datasets/splits.js';

function main(): void {
  const split = buildSplits(20261121);
  const goldById = new Map(readGoldJsonl().map((g) => [g.recording_id, g]));

  const devSummary = summarizeSplit('dev', split.dev, goldById);
  const testSummary = summarizeSplit('test', split.test, goldById);

  console.log('Splits written to data/splits.json');
  console.table([
    {
      split: devSummary.split,
      recordings: devSummary.recordings,
      steps: devSummary.steps,
      error_steps: devSummary.error_steps,
      hours: devSummary.hours,
      low_n: devSummary.low_n_categories.join(', '),
    },
    {
      split: testSummary.split,
      recordings: testSummary.recordings,
      steps: testSummary.steps,
      error_steps: testSummary.error_steps,
      hours: testSummary.hours,
      low_n: testSummary.low_n_categories.join(', '),
    },
  ]);
}

main();
