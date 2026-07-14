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
        `"${dirPath}" is a file, not a directory. Pass the directory containing MONITOR.md files. To test a single monitor file, use: agentmonitors monitor test '${dirPath}'`,
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

/**
 * Validate that a path exists and is a single file (not a directory).
 * Reports an error (text or JSON) and sets exit code 1 on failure. Symmetric
 * counterpart to {@link requireDirectory}: `validate` takes a directory and
 * redirects a file argument to `monitor test`; `monitor test` takes a single
 * `MONITOR.md` file and redirects a directory argument to `validate` (issue
 * #338, item 6) rather than surfacing a raw `EISDIR` read error.
 *
 * @returns `true` if the path is a valid file, `false` otherwise.
 */
export function requireFile(filePath: string, json: boolean): boolean {
  if (!existsSync(filePath)) {
    reportError(`Monitor file not found: ${filePath}`, json);
    return false;
  }
  try {
    if (statSync(filePath).isDirectory()) {
      reportError(
        `"${filePath}" is a directory, not a file. Pass a single MONITOR.md file. To validate a whole directory, use: agentmonitors validate '${filePath}'`,
        json,
      );
      return false;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reportError(`Cannot access "${filePath}": ${msg}`, json);
    return false;
  }
  return true;
}
