import type { ListDecision } from './types.js';

export type PublicAmlOptions = {
  chain: 'ETH' | 'BSC' | 'BTC' | 'TRON';
  fetchTimeoutMs?: number;
  blockScore?: number;
  fetchImpl?: typeof fetch;
};

type PublicAmlEntity = {
  wallet_address?: string;
  axes?: {
    legal_status?: {
      category?: string;
      source?: string;
      designation?: { authority?: string; list?: string };
    };
  };
  risk?: { score?: number };
};

export class PublicAmlScreener {
  private readonly fetchTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PublicAmlOptions) {
    if (options.blockScore !== undefined && (!Number.isFinite(options.blockScore) || options.blockScore < 0 || options.blockScore > 100)) {
      throw new Error('PUBLICAML_BLOCK_SCORE must be between 0 and 100');
    }
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 8_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async screen(address: string): Promise<ListDecision & { riskScore?: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const response = await this.fetchImpl('https://intelapi.publicaml.org/v2/enrich', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'SWIRL-PPOI/1.0' },
        body: JSON.stringify({
          addresses: [{ wallet_address: address, chain: this.options.chain }],
          include: ['aml_score', 'category'],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`PublicAML returned HTTP ${response.status}`);
      const data = await response.json() as { entities?: PublicAmlEntity[]; not_found?: unknown[] };
      if (!Array.isArray(data.entities) || !Array.isArray(data.not_found)) throw new Error('PublicAML returned an invalid response');
      const entity = data.entities.find((item) => item.wallet_address?.toLowerCase() === address.toLowerCase());
      if (!entity) {
        if (data.not_found.length > 0) return { shouldAllow: true };
        throw new Error('PublicAML returned no screening decision');
      }
      const legal = entity.axes?.legal_status;
      if (legal?.category === 'sanction' && legal.source) {
        const authority = legal.designation?.authority ? ` (${legal.designation.authority})` : '';
        return { shouldAllow: false, blockReason: `Address is sanctioned${authority}`, riskScore: entity.risk?.score };
      }
      const score = entity.risk?.score;
      if (this.options.blockScore !== undefined) {
        if (typeof score !== 'number' || !Number.isFinite(score)) throw new Error('PublicAML returned no usable risk score');
        if (score >= this.options.blockScore) {
          return { shouldAllow: false, blockReason: `PublicAML risk score ${score} meets the configured block threshold`, riskScore: score };
        }
      }
      return { shouldAllow: true, riskScore: score };
    } catch (error) {
      throw new Error(`PublicAML screening unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
