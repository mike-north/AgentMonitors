export type { MonitorFrontmatter, NotifyConfig } from './monitor-schema.js';

export interface MonitorDefinition {
  /** Monitor id — the folder name for `<id>/MONITOR.md`, or the filename stem for a flat `<id>.md`. */
  id: string;
  /** Human-readable display name; the frontmatter `name`, or the `id` when `name` is omitted. */
  displayName: string;
  /** Parsed and validated frontmatter */
  frontmatter: import('./monitor-schema.js').MonitorFrontmatter;
  /** Markdown body — handling instructions for the agent */
  instructions: string;
  /** Absolute path to the MONITOR.md file */
  filePath: string;
}

export type Urgency = 'low' | 'normal' | 'high';
export type NotifyStrategy = 'debounce' | 'throttle';
