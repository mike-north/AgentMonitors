export interface HookState {
  /** Timestamp of last state update */
  updatedAt: string;
  /** Session-aware hook-state payload for daemon mode */
  sessionId?: string;
  unread?: {
    high: number;
    normal: number;
    low: number;
    total: number;
  };
  hasPendingHigh?: boolean;
  hasPendingNormal?: boolean;
  hasPendingLow?: boolean;
  latestHighTitles?: string[];
  /** Summary counts by state for legacy inbox bridge mode */
  counts?: {
    queued: number;
    acked: number;
    'in-progress': number;
    failed: number;
  };
  /** High-urgency items that need immediate attention */
  urgent?: UrgentItem[];
}

export interface UrgentItem {
  id: string;
  monitorId: string;
  title: string;
  createdAt: string;
}
