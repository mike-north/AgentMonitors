export type { MonitorFrontmatter, NotifyConfig } from './monitor-schema.js';

export interface MonitorDefinition {
  /** Folder name — machine identifier within scope */
  id: string;
  /** Parsed and validated frontmatter */
  frontmatter: import('./monitor-schema.js').MonitorFrontmatter;
  /** Markdown body — handling instructions for the agent */
  instructions: string;
  /** Absolute path to the MONITOR.md file */
  filePath: string;
}

export type Urgency = 'low' | 'normal' | 'high';
export type EventKind = 'mutation' | 'notification' | 'alert';
export type NotifyStrategy = 'debounce' | 'throttle';
