import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { SaxesParser } from 'saxes';
import yauzl from 'yauzl';

export const OFAC_DOWNLOAD_URL = 'https://sanctionslistservice.ofac.treas.gov/api/download/SDN_ADVANCED.ZIP';
export const OFAC_CHANGES_URL = 'https://sanctionslistservice.ofac.treas.gov/changes/latest';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_XML_BYTES = 512 * 1024 * 1024;

type OfacCache = {
  version: 1;
  sourceUrl: string;
  fingerprint: string;
  dataAsOf: string;
  checkedAt: string;
  downloadedAt: string;
  evmAddresses: string[];
  otherAddresses: string[];
};

export type ParsedOfacList = {
  dataAsOf: string;
  evmAddresses: Set<string>;
  otherAddresses: Set<string>;
};

export type OfacListOptions = {
  cacheFile: string;
  downloadUrl?: string;
  changesUrl?: string;
  refreshIntervalMs?: number;
  maxStaleMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onError?: (error: Error) => void;
};

function xmlName(name: string): string {
  return name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
}

function validCache(value: unknown): value is OfacCache {
  if (!value || typeof value !== 'object') return false;
  const cache = value as Partial<OfacCache>;
  return cache.version === 1 && typeof cache.sourceUrl === 'string'
    && typeof cache.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(cache.fingerprint)
    && typeof cache.dataAsOf === 'string' && typeof cache.checkedAt === 'string'
    && typeof cache.downloadedAt === 'string'
    && Number.isFinite(Date.parse(cache.checkedAt)) && Number.isFinite(Date.parse(cache.downloadedAt))
    && Array.isArray(cache.evmAddresses) && cache.evmAddresses.every((item) => typeof item === 'string' && /^0x[0-9a-f]{40}$/.test(item))
    && Array.isArray(cache.otherAddresses) && cache.otherAddresses.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 256);
}

export async function parseOfacXml(stream: Readable): Promise<ParsedOfacList> {
  const parser = new SaxesParser();
  const evmAddresses = new Set<string>();
  const otherAddresses = new Set<string>();
  const digitalCurrencyFeatureTypes = new Set<string>();
  let failure: Error | undefined;
  let insideFeature = false;
  let insideDateOfIssue = false;
  let capture: 'type' | 'value' | 'dataasof' | 'featuretype' | 'versiondetail' | 'year' | 'month' | 'day' | undefined;
  let text = '';
  let featureType = '';
  let featureTypeId = '';
  let featureTypeDefinitionId = '';
  let featureValue = '';
  let dataAsOf = '';
  let issueYear = '';
  let issueMonth = '';
  let issueDay = '';
  const addAddress = (value: string) => {
    if (!value) return;
    if (/^0x[0-9a-fA-F]{40}$/.test(value)) evmAddresses.add(value.toLowerCase());
    else otherAddresses.add(value);
  };

  parser.on('error', (error) => {
    failure = error;
  });
  parser.on('opentag', (node) => {
    const name = xmlName(node.name).toLowerCase();
    const attribute = (wanted: string) => Object.entries(node.attributes)
      .find(([key]) => xmlName(key).toLowerCase() === wanted)?.[1] ?? '';
    if (name === 'feature') {
      insideFeature = true;
      featureType = '';
      featureTypeId = attribute('featuretypeid');
      featureValue = '';
      return;
    }
    if (name === 'featuretype') {
      featureTypeDefinitionId = attribute('id');
      capture = 'featuretype';
    } else if (name === 'dateofissue') {
      insideDateOfIssue = true;
      issueYear = '';
      issueMonth = '';
      issueDay = '';
    } else if (insideFeature && (name === 'type' || name === 'value')) capture = name;
    else if (insideFeature && name === 'versiondetail' && digitalCurrencyFeatureTypes.has(featureTypeId)) capture = 'versiondetail';
    else if (!insideFeature && name === 'dataasof') capture = 'dataasof';
    else if (insideDateOfIssue && (name === 'year' || name === 'month' || name === 'day')) capture = name;
    if (capture) text = '';
  });
  parser.on('text', (chunk) => {
    if (capture) text += chunk;
  });
  parser.on('closetag', (node) => {
    const name = xmlName(node.name).toLowerCase();
    if (capture === name) {
      const value = text.trim();
      if (name === 'type') featureType = value;
      else if (name === 'value') featureValue = value;
      else if (name === 'dataasof') dataAsOf = value;
      else if (name === 'featuretype') {
        if (featureTypeDefinitionId && value.startsWith('Digital Currency Address - ')) {
          digitalCurrencyFeatureTypes.add(featureTypeDefinitionId);
        }
        featureTypeDefinitionId = '';
      } else if (name === 'versiondetail') addAddress(value);
      else if (name === 'year') issueYear = value;
      else if (name === 'month') issueMonth = value;
      else if (name === 'day') issueDay = value;
      capture = undefined;
      text = '';
    }
    if (name === 'dateofissue' && insideDateOfIssue) {
      if (issueYear && issueMonth && issueDay) {
        dataAsOf = `${issueYear}-${issueMonth.padStart(2, '0')}-${issueDay.padStart(2, '0')}`;
      }
      insideDateOfIssue = false;
    }
    if (name === 'feature' && insideFeature) {
      if (featureType.startsWith('Digital Currency Address - ')) addAddress(featureValue);
      insideFeature = false;
      featureType = '';
      featureTypeId = '';
      featureValue = '';
    }
  });

  for await (const chunk of stream) parser.write(chunk.toString());
  parser.close();
  if (failure) throw failure;
  if (!dataAsOf) throw new Error('OFAC XML is missing its publication date');
  if (evmAddresses.size + otherAddresses.size === 0) throw new Error('OFAC XML contains no digital currency addresses');
  return { dataAsOf, evmAddresses, otherAddresses };
}

export async function parseOfacZip(buffer: Buffer): Promise<ParsedOfacList> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error('Could not open OFAC ZIP'));
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      zip.on('error', fail);
      zip.on('entry', (entry) => {
        if (!entry.fileName.toUpperCase().endsWith('.XML')) {
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > MAX_XML_BYTES) return fail(new Error('OFAC XML exceeds the safety limit'));
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError ?? new Error('Could not read OFAC XML'));
          stream.on('error', fail);
          parseOfacXml(stream).then((result) => {
            if (settled) return;
            settled = true;
            zip.close();
            resolve(result);
          }).catch(fail);
        });
      });
      zip.on('end', () => fail(new Error('OFAC ZIP contains no XML document')));
      zip.readEntry();
    });
  });
}

export class OfacAddressList {
  private readonly downloadUrl: string;
  private readonly changesUrl: string;
  private readonly refreshIntervalMs: number;
  private readonly maxStaleMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly onError: (error: Error) => void;
  private cache?: OfacCache;
  private refreshPromise?: Promise<void>;
  private timer?: NodeJS.Timeout;

  constructor(private readonly options: OfacListOptions) {
    this.downloadUrl = options.downloadUrl ?? OFAC_DOWNLOAD_URL;
    this.changesUrl = options.changesUrl ?? OFAC_CHANGES_URL;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DAY_MS;
    this.maxStaleMs = options.maxStaleMs ?? DAY_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? ((error) => console.error('OFAC list refresh failed', error));
    if (this.refreshIntervalMs < 60_000 || this.maxStaleMs < this.refreshIntervalMs) {
      throw new Error('OFAC maxStaleMs must be at least refreshIntervalMs (minimum one minute)');
    }
  }

  private fresh(cache = this.cache): cache is OfacCache {
    return Boolean(cache && this.now() - Date.parse(cache.checkedAt) <= this.maxStaleMs);
  }

  get stats() {
    return {
      source: 'OFAC SDN_ADVANCED',
      ready: this.fresh(),
      checkedAt: this.cache?.checkedAt,
      downloadedAt: this.cache?.downloadedAt,
      dataAsOf: this.cache?.dataAsOf,
      evmAddresses: this.cache?.evmAddresses.length ?? 0,
      otherAddresses: this.cache?.otherAddresses.length ?? 0,
      refreshIntervalMs: this.refreshIntervalMs,
      maxStaleMs: this.maxStaleMs,
    };
  }

  private async loadCache(): Promise<void> {
    try {
      const raw = await readFile(this.options.cacheFile, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!validCache(parsed) || parsed.sourceUrl !== this.downloadUrl) throw new Error('Invalid OFAC address cache');
      this.cache = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(error instanceof Error ? error : new Error('Could not load OFAC cache'));
    }
  }

  private async saveCache(): Promise<void> {
    if (!this.cache) return;
    const file = this.options.cacheFile;
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(this.cache), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async cleanupTemporaryFiles(): Promise<void> {
    const file = this.options.cacheFile;
    const directory = path.dirname(file);
    const prefix = `${path.basename(file)}.`;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) return;
      const target = path.join(directory, entry.name);
      const info = await stat(target).catch(() => undefined);
      if (info && this.now() - info.mtimeMs > this.refreshIntervalMs) await unlink(target).catch(() => undefined);
    }));
  }

  private async fetchBuffer(url: string, maximumBytes: number): Promise<Buffer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal, headers: { 'user-agent': 'SWIRL-PPOI/1.0' } });
      if (!response.ok) throw new Error(`OFAC returned HTTP ${response.status} for ${url}`);
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > maximumBytes) throw new Error('OFAC response exceeds the safety limit');
      if (!response.body) throw new Error('OFAC returned an empty response body');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Buffer>) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > maximumBytes) throw new Error('OFAC response exceeds the safety limit');
        chunks.push(buffer);
      }
      return Buffer.concat(chunks, size);
    } finally {
      clearTimeout(timeout);
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const latest = await this.fetchBuffer(this.changesUrl, 4 * 1024 * 1024);
      const fingerprint = createHash('sha256').update(latest).digest('hex');
      const checkedAt = new Date(this.now()).toISOString();
      if (this.cache && this.cache.fingerprint === fingerprint) {
        this.cache = { ...this.cache, checkedAt };
        await this.saveCache();
        return;
      }
      const archive = await this.fetchBuffer(this.downloadUrl, MAX_DOWNLOAD_BYTES);
      const parsed = await parseOfacZip(archive);
      const next: OfacCache = {
        version: 1,
        sourceUrl: this.downloadUrl,
        fingerprint,
        dataAsOf: parsed.dataAsOf,
        checkedAt,
        downloadedAt: checkedAt,
        evmAddresses: [...parsed.evmAddresses].sort(),
        otherAddresses: [...parsed.otherAddresses].sort(),
      };
      this.cache = next;
      await this.saveCache();
    })();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  async start(): Promise<void> {
    await this.loadCache();
    await this.cleanupTemporaryFiles();
    try {
      await this.refresh();
    } catch (error) {
      if (!this.fresh()) throw error;
      this.onError(error instanceof Error ? error : new Error('OFAC refresh failed'));
    }
    if (!this.fresh()) throw new Error('No fresh OFAC address list is available');
    this.timer = setInterval(() => {
      this.refresh().catch((error) => this.onError(error instanceof Error ? error : new Error('OFAC refresh failed')));
    }, this.refreshIntervalMs);
    this.timer.unref();
  }

  isSanctioned(address: string): boolean {
    const cache = this.cache;
    if (!this.fresh(cache)) throw new Error('OFAC address list is missing or stale');
    if (/^0x[0-9a-fA-F]{40}$/.test(address)) return cache.evmAddresses.includes(address.toLowerCase());
    return cache.otherAddresses.includes(address);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
