import type {
  JsonSchema,
  ObservationContext,
  ObservationResult,
  ObservationSource,
} from '@agentmonitors/core';

interface ScopeConfig {
  cron: string;
  timezone: string | undefined;
  label: string | undefined;
}

function parseScopeConfig(config: Record<string, unknown>): ScopeConfig {
  const cron = config['cron'];
  if (typeof cron !== 'string') {
    throw new Error('scope.cron must be a string');
  }
  return {
    cron,
    timezone:
      typeof config['timezone'] === 'string' ? config['timezone'] : undefined,
    label: typeof config['label'] === 'string' ? config['label'] : undefined,
  };
}

const scopeSchema: JsonSchema = {
  type: 'object',
  properties: {
    cron: {
      type: 'string',
      description: 'Cron expression (e.g., "0 9 * * 1-5" for weekdays at 9am)',
    },
    timezone: {
      type: 'string',
      description: 'IANA timezone (e.g., "America/New_York")',
    },
    label: {
      type: 'string',
      description: 'Human-readable label for the schedule',
    },
  },
  required: ['cron'],
};

const source: ObservationSource = {
  name: 'schedule',
  scopeSchema,

  observe(
    config: Record<string, unknown>,
    context: ObservationContext = { now: new Date() },
  ): Promise<ObservationResult> {
    const { cron, timezone, label } = parseScopeConfig(config);

    // For now, the schedule source always fires when observe() is called.
    // The actual cron scheduling (deciding WHEN to call observe()) is handled
    // by the monitor engine, not the source plugin itself.
    return Promise.resolve({
      observations: [
        {
          title: label ?? `Scheduled trigger: ${cron}`,
          summary: label ?? `Scheduled trigger: ${cron}`,
          payload: {
            cron,
            timezone: timezone ?? 'UTC',
          },
          objectKey: cron,
          queryScope: { cron, timezone: timezone ?? 'UTC' },
          snapshot: {
            cron,
            timezone: timezone ?? 'UTC',
            triggeredAt: context.now.toISOString(),
          },
        },
      ],
    });
  },
};

export default source;
