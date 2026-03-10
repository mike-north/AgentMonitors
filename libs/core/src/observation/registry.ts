import type { ObservationSource } from './types.js';

/**
 * In-memory registry of observation source plugins.
 *
 * Discovery from `~/.config/agentmonitors/node_modules/` is handled
 * by the CLI at startup; this registry holds the resolved plugins.
 */
export class SourceRegistry {
  private readonly sources = new Map<string, ObservationSource>();

  register(source: ObservationSource): void {
    if (this.sources.has(source.name)) {
      throw new Error(
        `Observation source "${source.name}" is already registered`,
      );
    }
    this.sources.set(source.name, source);
  }

  get(name: string): ObservationSource | undefined {
    return this.sources.get(name);
  }

  has(name: string): boolean {
    return this.sources.has(name);
  }

  list(): ObservationSource[] {
    return [...this.sources.values()];
  }

  names(): string[] {
    return [...this.sources.keys()];
  }
}
