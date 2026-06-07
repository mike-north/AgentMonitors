import type { InboxItemState } from './schema.js';

export type { InboxItemState } from './schema.js';

export interface InboxItem {
  id: string;
  monitorId: string;
  state: InboxItemState;
  urgency: 'low' | 'normal' | 'high';
  title: string;
  body: string;
  snapshot: unknown;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  ackedAt: Date | null;
  completedAt: Date | null;
}

export interface EnqueuePayload {
  monitorId: string;
  urgency: 'low' | 'normal' | 'high';
  title: string;
  body?: string;
  snapshot?: unknown;
  tags?: string[];
}

export interface InboxFilter {
  state?: InboxItemState | InboxItemState[];
  urgency?: 'low' | 'normal' | 'high';
  tags?: string[];
  monitorId?: string;
  since?: Date;
  until?: Date;
}
