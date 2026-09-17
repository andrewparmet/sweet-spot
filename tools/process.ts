import { spawnSync } from 'node:child_process';

interface RunOptions {
  readonly capture?: boolean;
  readonly cwd: string;
}

export function run(command: string, args: readonly string[], options: RunOptions): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture ? ['inherit', 'pipe', 'inherit'] : 'inherit'
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed with exit code ${result.status ?? 'unknown'}.`);
  }
  return options.capture ? result.stdout : '';
}
