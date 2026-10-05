#!/usr/bin/env node
import { CliApp } from './cli/index.js';
import type { CliIo } from './cli/index.js';

export async function main(argv: string[], io?: Partial<CliIo>): Promise<number> {
  return CliApp.create(io).run(argv);
}

if (CliApp.isEntryPoint(import.meta.url)) {
  CliApp.ignoreBrokenPipes(process.stdout);
  CliApp.ignoreBrokenPipes(process.stderr);
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.exitCode = CliApp.crash(err, process.stderr);
    },
  );
}
