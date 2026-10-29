import type { PublicAmlScreener } from './publicaml.js';
import type { ListDecision, ListProvider } from './types.js';

export class SwirlListProvider implements ListProvider {
  constructor(
    private readonly options: {
      mode: 'local-test' | 'ofac';
      blockedAddresses?: Iterable<string>;
      ofacList?: { isSanctioned(address: string): boolean; readonly stats?: unknown };
      publicAml?: Pick<PublicAmlScreener, 'screen'>;
      publicAmlRequired?: boolean;
    },
  ) {
    if (options.mode === 'ofac' && !options.ofacList) throw new Error('An OFAC address list is required');
    if (options.publicAmlRequired && !options.publicAml) throw new Error('PublicAML is required by the current configuration');
  }

  get stats() {
    return {
      mode: this.options.mode,
      ofac: this.options.ofacList?.stats,
      publicAml: this.options.publicAml ? { enabled: true, required: this.options.publicAmlRequired !== false } : { enabled: false },
    };
  }

  async shouldAllowShield(input: { transactionHash: string; fromAddressLowercase: string; timestamp: number }): Promise<ListDecision> {
    const blocked = new Set([...this.options.blockedAddresses ?? []].map((address) => address.toLowerCase()));
    const address = input.fromAddressLowercase;
    if (blocked.has(address)) return { shouldAllow: false, blockReason: 'Address is on the configured blocklist' };
    if (this.options.mode === 'local-test') return { shouldAllow: true };

    if (this.options.ofacList!.isSanctioned(address)) return { shouldAllow: false, blockReason: 'Address is on the OFAC SDN list' };
    if (this.options.publicAml) {
      try {
        return await this.options.publicAml.screen(address);
      } catch (error) {
        if (this.options.publicAmlRequired !== false) throw error;
      }
    }
    return { shouldAllow: true };
  }
}
