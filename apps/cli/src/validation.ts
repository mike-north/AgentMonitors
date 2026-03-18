import { existsSync, statSync } from 'node:fs';
import { reportError } from './output.js';

/**
 * Validate that a path exists and is a directory.
 * Reports an error (text or JSON) and sets exit code 1 on failure.
 *
 * @returns `true` if the path is a valid directory, `false` otherwise.
 */
export function requireDirectory(dirPath: string, json: boolean): boolean {
  if (!existsSync(dirPath)) {
    reportError(`path "${dirPath}" does not exist`, json);
    return false;
  }
  try {
    if (!statSync(dirPath).isDirectory()) {
      reportError(
        `"${dirPath}" is a file, not a directory. Pass the directory containing MONITOR.md files.`,
        json,
      );
      return false;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reportError(`Cannot access "${dirPath}": ${msg}`, json);
    return false;
  }
  return true;
}
