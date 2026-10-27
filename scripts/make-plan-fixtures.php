<?php
/**
 * Plan fixtures for the mod's tests (docs/REVAMP_PLAN.md Phase 0.1), from the planner's
 * golden cases: the optimised plan of every case and the draft of the *.fit cases as plan
 * files (zg-tt-plan/1), plus one pre-file share payload (the whole planner plan without
 * its chart data) as the legacy shape mods up to 0.6.4 read.
 *
 *   php scripts/make-plan-fixtures.php [--planner=/path/to/ZwiftGopher] [--out=test/fixtures]
 *
 * Needs the planner checkout (its harness runs the real engine); takes a minute or two.
 */
declare(strict_types=1);

$opts = getopt('', ['planner::', 'out::', 'case::']);
$planner = rtrim($opts['planner'] ?? dirname(__DIR__, 2) . '/ZwiftGopher', '/');
$out = rtrim($opts['out'] ?? dirname(__DIR__) . '/test/fixtures', '/');
$only = $opts['case'] ?? null;

$runner = $planner . '/scripts/diagnostics/tt_plan_runner.php';
if (!is_file($runner)) {
   fwrite(STDERR, "Planner harness not found: $runner\n");
   exit(1);
}
require $runner;

@mkdir("$out/plans", 0777, true);
@mkdir("$out/legacy", 0777, true);

$written = 0;
foreach (ttLoadCases()['cases'] as $entry) {
   $key = $entry['key'];
   if ($only !== null && $only !== $key) {
      continue;
   }
   unset($_SESSION['tt_planner']);
   $case = ttCase($key);
   $result = ttRunCase($case);
   if (!empty($result['errors'])) {
      fwrite(STDERR, "$key: " . implode('; ', array_map('strval', $result['errors'])) . "\n");
   }
   $paths = ['optimise'];
   if (str_ends_with($key, '.fit')) {
      $paths[] = 'generate';
   }
   foreach ($paths as $path) {
      $plan = $result['plans'][$path] ?? null;
      if (!is_array($plan)) {
         fwrite(STDERR, "$key: no $path plan\n");
         continue;
      }
      $file = TTPlanFile::fromPlan($plan);
      $file['created_at'] = '2026-10-27T00:00:00+00:00'; // stable fixtures
      $name = "$out/plans/$key.$path.json";
      file_put_contents($name, json_encode($file, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION) . "\n");
      $written++;
      fwrite(STDERR, sprintf("%-28s %3d intervals  %s\n", basename($name), count($file['intervals']), $file['summary']['time_text'] ?? ''));
   }
   if ($key === 'flat.fit') {
      // The legacy share payload: the planner plan as share-plan.php returned it before
      // 2026-10-27, minus the chart data (the mod dropped those keys before storing).
      $legacy = $result['plans']['optimise'];
      $dropped = [];
      // Drop the chart data (large arrays) but keep the objects around them, as the mod's
      // shared-plan-utils.mjs did when it stored a plan.
      $strip = function (array $node, string $path) use (&$strip, &$dropped): array {
         foreach ($node as $k => $v) {
            if (!is_array($v)) {
               continue;
            }
            if (strlen((string)json_encode($v)) > 20000) {
               if (array_is_list($v)) {
                  $dropped[] = "$path$k";
                  unset($node[$k]);
               } else {
                  $node[$k] = $strip($v, "$path$k.");
               }
            }
         }
         return $node;
      };
      $legacy = $strip($legacy, '');
      unset($legacy['schema']);
      $legacy['_fixture_note'] = 'Whole planner plan of flat.fit (optimise) as a pre-plan-file share code held it; dropped (chart data): ' . implode(', ', $dropped);
      file_put_contents("$out/legacy/flat.fit.optimise.json", json_encode($legacy, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION) . "\n");
      $written++;
   }
}
fwrite(STDERR, "Wrote $written fixtures under $out\n");
