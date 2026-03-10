export interface HookState {
  /** Timestamp of last state update */
  updatedAt: string;
  /** Summary counts by state */
  counts: {
    queued: number;
    acked: number;
    'in-progress': number;
    failed: number;
  };
  /** High-urgency items that need immediate attention */
  urgent: UrgentItem[];
}

export interface UrgentItem {
  id: string;
  monitorId: string;
  title: string;
  createdAt: string;
}
