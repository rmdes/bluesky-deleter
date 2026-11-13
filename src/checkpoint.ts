import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface Progress {
  /** Where the next listRecords page starts; absent before the first page. */
  cursor?: string;
  scanned: number;
  matched: number;
}

export interface Checkpoints {
  load(key: string): Progress | undefined;
  save(key: string, progress: Progress): void;
  clear(key: string): void;
}

type State = Record<string, Progress>;

/** Sweep progress persisted as one JSON file, keyed by account + target domains. */
export function fileCheckpoints(path: string): Checkpoints {
  const read = (): State => {
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as State;
    } catch (cause) {
      throw new Error(`Checkpoint file ${path} is unreadable; delete it to start over`, { cause });
    }
  };

  // Write-then-rename so a crash mid-write can never leave a truncated file.
  const write = (state: State): void => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, path);
  };

  return {
    load: (key) => read()[key],
    save: (key, progress) => write({ ...read(), [key]: progress }),
    clear: (key) => {
      const { [key]: _removed, ...rest } = read();
      write(rest);
    },
  };
}
