import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type InboxDb } from './db.js';
import { InboxService } from './inbox-service.js';
import type { EnqueuePayload } from './types.js';

const CREATED_AT = new Date('2024-01-15T10:30:00.000Z');

const basePayload: EnqueuePayload = {
  monitorId: 'github-pr-review',
  urgency: 'normal',
  eventKind: 'notification',
  title: 'New PR review on my-repo#42',
  body: 'Review comments from @reviewer',
  snapshot: { pr: 42, comments: 3 },
  tags: ['github', 'review'],
};

describe('InboxService', () => {
  let db: InboxDb;
  let service: InboxService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(CREATED_AT);
    db = createDb(':memory:');
    service = new InboxService(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('enqueue', () => {
    it('creates an inbox item with queued state', () => {
      const id = service.enqueue(basePayload);
      const item = service.getById(id);

      expect(item).not.toBeNull();
      expect(item?.state).toBe('queued');
      expect(item?.monitorId).toBe('github-pr-review');
      expect(item?.urgency).toBe('normal');
      expect(item?.eventKind).toBe('notification');
      expect(item?.title).toBe('New PR review on my-repo#42');
      expect(item?.body).toBe('Review comments from @reviewer');
      expect(item?.snapshot).toEqual({ pr: 42, comments: 3 });
      expect(item?.tags).toEqual(['github', 'review']);
      expect(item?.createdAt).toEqual(CREATED_AT);
    });

    it('returns a ULID id', () => {
      const id = service.enqueue(basePayload);
      expect(id).toMatch(/^[0-9A-Z]{26}$/);
    });

    it('defaults body to empty string', () => {
      const { body: _, ...payloadWithoutBody } = basePayload;
      const id = service.enqueue(payloadWithoutBody);
      const item = service.getById(id);
      expect(item?.body).toBe('');
    });

    it('defaults snapshot to empty object', () => {
      const { snapshot: _, ...payloadWithoutSnapshot } = basePayload;
      const id = service.enqueue(payloadWithoutSnapshot);
      const item = service.getById(id);
      expect(item?.snapshot).toEqual({});
    });

    it('defaults tags to empty array', () => {
      const { tags: _, ...payloadWithoutTags } = basePayload;
      const id = service.enqueue(payloadWithoutTags);
      const item = service.getById(id);
      expect(item?.tags).toEqual([]);
    });
  });

  describe('state transitions', () => {
    let id: string;

    beforeEach(() => {
      id = service.enqueue(basePayload);
    });

    it('ack transitions from queued to acked', () => {
      service.ack(id);
      const item = service.getById(id);
      expect(item?.state).toBe('acked');
      expect(item?.ackedAt).toEqual(CREATED_AT);
    });

    it('start transitions to in-progress', () => {
      service.ack(id);
      service.start(id);
      const item = service.getById(id);
      expect(item?.state).toBe('in-progress');
    });

    it('complete transitions to completed', () => {
      service.ack(id);
      service.start(id);
      service.complete(id);
      const item = service.getById(id);
      expect(item?.state).toBe('completed');
      expect(item?.completedAt).toEqual(CREATED_AT);
    });

    it('fail transitions to failed and appends error to body', () => {
      service.ack(id);
      service.start(id);
      service.fail(id, 'Something went wrong');
      const item = service.getById(id);
      expect(item?.state).toBe('failed');
      expect(item?.body).toBe(
        'Review comments from @reviewer\n\n---\n\nError: Something went wrong',
      );
    });

    it('fail without error message preserves original body', () => {
      service.ack(id);
      service.start(id);
      service.fail(id);
      const item = service.getById(id);
      expect(item?.state).toBe('failed');
      expect(item?.body).toBe('Review comments from @reviewer');
    });

    it('fail on item with empty body sets error as body', () => {
      const { body: _, ...payloadWithoutBody } = basePayload;
      const emptyBodyId = service.enqueue(payloadWithoutBody);
      service.fail(emptyBodyId, 'Something broke');
      const item = service.getById(emptyBodyId);
      expect(item?.body).toBe('Error: Something broke');
    });

    it('archive transitions to archived', () => {
      service.ack(id);
      service.start(id);
      service.complete(id);
      service.archive(id);
      const item = service.getById(id);
      expect(item?.state).toBe('archived');
    });

    it('full lifecycle: queued → acked → in-progress → completed → archived', () => {
      expect(service.getById(id)?.state).toBe('queued');
      service.ack(id);
      expect(service.getById(id)?.state).toBe('acked');
      service.start(id);
      expect(service.getById(id)?.state).toBe('in-progress');
      service.complete(id);
      expect(service.getById(id)?.state).toBe('completed');
      service.archive(id);
      expect(service.getById(id)?.state).toBe('archived');
    });
  });

  describe('getById', () => {
    it('returns null for nonexistent id', () => {
      expect(service.getById('nonexistent')).toBeNull();
    });
  });

  describe('list', () => {
    let ids: string[];

    beforeEach(() => {
      ids = [
        service.enqueue({ ...basePayload, title: 'Item 1', urgency: 'high' }),
        service.enqueue({
          ...basePayload,
          title: 'Item 2',
          eventKind: 'mutation',
        }),
        service.enqueue({
          ...basePayload,
          title: 'Item 3',
          monitorId: 'other-monitor',
          tags: ['other'],
        }),
      ];
    });

    it('returns all items without filter', () => {
      const items = service.list();
      expect(items).toHaveLength(3);
    });

    it('filters by state', () => {
      service.ack(ids[0] ?? '');
      const items = service.list({ state: 'acked' });
      expect(items).toHaveLength(1);
      expect(items[0]?.title).toBe('Item 1');
    });

    it('filters by multiple states', () => {
      service.ack(ids[0] ?? '');
      service.ack(ids[1] ?? '');
      service.start(ids[1] ?? '');
      const items = service.list({ state: ['acked', 'in-progress'] });
      expect(items).toHaveLength(2);
    });

    it('filters by urgency', () => {
      const items = service.list({ urgency: 'high' });
      expect(items).toHaveLength(1);
      expect(items[0]?.title).toBe('Item 1');
    });

    it('filters by eventKind', () => {
      const items = service.list({ eventKind: 'mutation' });
      expect(items).toHaveLength(1);
      expect(items[0]?.title).toBe('Item 2');
    });

    it('filters by monitorId', () => {
      const items = service.list({ monitorId: 'other-monitor' });
      expect(items).toHaveLength(1);
      expect(items[0]?.title).toBe('Item 3');
    });

    it('filters by date range', () => {
      const before = new Date('2024-01-15T10:29:00.000Z');
      const after = new Date('2024-01-15T10:31:00.000Z');

      const itemsBefore = service.list({ until: before });
      expect(itemsBefore).toHaveLength(0);

      const itemsInRange = service.list({ since: before, until: after });
      expect(itemsInRange).toHaveLength(3);
    });

    it('filters by tags', () => {
      const items = service.list({ tags: ['github'] });
      expect(items).toHaveLength(2);
      expect(items.every((item) => item.tags.includes('github'))).toBe(true);
    });

    it('filters by multiple tags (AND logic)', () => {
      const items = service.list({ tags: ['github', 'review'] });
      expect(items).toHaveLength(2);

      const otherItems = service.list({ tags: ['other'] });
      expect(otherItems).toHaveLength(1);
      expect(otherItems[0]?.monitorId).toBe('other-monitor');

      const noMatch = service.list({ tags: ['github', 'other'] });
      expect(noMatch).toHaveLength(0);
    });

    it('returns items ordered by createdAt descending', () => {
      vi.setSystemTime(new Date('2024-01-15T11:00:00.000Z'));
      service.enqueue({ ...basePayload, title: 'Item 4' });

      const items = service.list();
      expect(items[0]?.title).toBe('Item 4');
    });
  });

  describe('onMutation callback', () => {
    it('calls onMutation on enqueue', () => {
      const callback = vi.fn();
      const svc = new InboxService(db, callback);
      svc.enqueue(basePayload);
      expect(callback).toHaveBeenCalledOnce();
    });

    it('calls onMutation on state transitions', () => {
      const callback = vi.fn();
      const svc = new InboxService(db, callback);
      const id = svc.enqueue(basePayload);
      callback.mockClear();

      svc.ack(id);
      expect(callback).toHaveBeenCalledOnce();

      callback.mockClear();
      svc.start(id);
      expect(callback).toHaveBeenCalledOnce();

      callback.mockClear();
      svc.complete(id);
      expect(callback).toHaveBeenCalledOnce();

      callback.mockClear();
      svc.archive(id);
      expect(callback).toHaveBeenCalledOnce();
    });

    it('calls onMutation on fail', () => {
      const callback = vi.fn();
      const svc = new InboxService(db, callback);
      const id = svc.enqueue(basePayload);
      callback.mockClear();

      svc.fail(id, 'error');
      expect(callback).toHaveBeenCalledOnce();
    });
  });
});
