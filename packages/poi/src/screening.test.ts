import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import yazl from 'yazl';
import { OfacAddressList, parseOfacXml, parseOfacZip } from './ofac-list.js';
import { PublicAmlScreener } from './publicaml.js';
import { SwirlListProvider } from './list-provider.js';

const EVM = '0xd882cfc20f52f2599d84b8e8d58c7fb62cfe344b';
const BTC = '149w62rY42aZBox8fGcmqNsXUzSStKeq8C';
const LATEST_A = '<changes><dataAsOf>2026-10-28T00:00:00Z</dataAsOf></changes>';
const LATEST_B = '<changes><dataAsOf>2026-10-29T00:00:00Z</dataAsOf></changes>';

function xml(addresses = true): string {
  return `<?xml version="1.0"?><sanctionsData><publicationInfo><dataAsOf>2026-10-28T00:00:00Z</dataAsOf></publicationInfo><entities><entity><features>${addresses ? `
    <feature><type>Digital Currency Address - ETH</type><value>${EVM}</value></feature>
    <feature><type>Digital Currency Address - ETC</type><value>0x${EVM.slice(2).toUpperCase()}</value></feature>
    <feature><type>Digital Currency Address - XBT</type><value>${BTC}</value></feature>` : ''}
    <feature><type>Birthdate</type><value>1985-07-09</value></feature>
  </features></entity></entities></sanctionsData>`;
}

async function zipBuffer(source: string): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(source), 'SDN_ADVANCED.XML');
  zip.end();
  const chunks: Buffer[] = [];
  zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return new Promise((resolve, reject) => {
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

function response(body: string | Buffer): Response {
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: 200 });
}

describe('OFAC current-list parsing and cache lifecycle', () => {
  it('parses XML and ZIP, deduplicates addresses and rejects an empty list', async () => {
    const parsed = await parseOfacZip(await zipBuffer(xml()));
    expect(parsed.dataAsOf).toBe('2026-10-28T00:00:00Z');
    expect([...parsed.evmAddresses]).toEqual([EVM]);
    expect([...parsed.otherAddresses]).toEqual([BTC]);
    const { Readable } = await import('node:stream');
    const streamed = await parseOfacXml(Readable.from([xml()]));
    expect(streamed.evmAddresses.has(EVM)).toBe(true);
    await expect(parseOfacZip(await zipBuffer(xml(false)))).rejects.toThrow('no digital currency addresses');
  });

  it('parses the production Advanced XML reference and feature structure', async () => {
    const advanced = `<?xml version="1.0"?><Sanctions><DateOfIssue><Year>2026</Year><Month>10</Month><Day>21</Day></DateOfIssue>
      <ReferenceValueSets><FeatureTypeValues>
        <FeatureType ID="344">Digital Currency Address - XBT</FeatureType>
        <FeatureType ID="345">Digital Currency Address - ETH</FeatureType>
        <FeatureType ID="21">Email Address</FeatureType>
      </FeatureTypeValues></ReferenceValueSets>
      <DistinctParties><DistinctParty><Profile><Identity>
        <Feature ID="1" FeatureTypeID="345"><FeatureVersion><VersionDetail DetailTypeID="1432">${EVM}</VersionDetail></FeatureVersion></Feature>
        <Feature ID="2" FeatureTypeID="344"><FeatureVersion><VersionDetail DetailTypeID="1432">${BTC}</VersionDetail></FeatureVersion></Feature>
        <Feature ID="3" FeatureTypeID="21"><FeatureVersion><VersionDetail DetailTypeID="1432">unused@example.com</VersionDetail></FeatureVersion></Feature>
      </Identity></Profile></DistinctParty></DistinctParties></Sanctions>`;
    const parsed = await parseOfacZip(await zipBuffer(advanced));
    expect(parsed.dataAsOf).toBe('2026-10-21');
    expect([...parsed.evmAddresses]).toEqual([EVM]);
    expect([...parsed.otherAddresses]).toEqual([BTC]);
  });

  it('refreshes only on publication changes, applies removals, cleans temporary files and fails closed when stale', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'swirl-ofac-'));
    const cacheFile = path.join(directory, 'ofac-addresses.json');
    const temporary = `${cacheFile}.old.tmp`;
    const unrelated = `${cacheFile}.keep`;
    await writeFile(temporary, 'incomplete download');
    await writeFile(unrelated, 'unrelated user data');
    await utimes(temporary, new Date(0), new Date(0));
    let now = Date.parse('2026-10-28T00:00:00Z');
    let latest = LATEST_A;
    let sourceXml = xml();
    let downloads = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/changes/latest')) return response(latest);
      if (url.endsWith('/SDN_ADVANCED.ZIP')) {
        downloads++;
        return response(await zipBuffer(sourceXml));
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const list = new OfacAddressList({
      cacheFile, fetchImpl, now: () => now, refreshIntervalMs: 60_000, maxStaleMs: 60_000,
    });
    await list.start();
    expect(list.isSanctioned(`0x${EVM.slice(2).toUpperCase()}`)).toBe(true);
    expect(list.isSanctioned(BTC)).toBe(true);
    expect(list.isSanctioned('0x0000000000000000000000000000000000000000')).toBe(false);
    expect(downloads).toBe(1);
    expect(await stat(temporary).catch(() => undefined)).toBeUndefined();
    expect(await readFile(unrelated, 'utf8')).toBe('unrelated user data');

    now += 1_000;
    await list.refresh();
    expect(downloads).toBe(1);
    latest = LATEST_B;
    sourceXml = xml(false).replace('</features>', `<feature><type>Digital Currency Address - ETH</type><value>0x0000000000000000000000000000000000000001</value></feature></features>`);
    await list.refresh();
    expect(downloads).toBe(2);
    expect(list.isSanctioned(EVM)).toBe(false);
    expect(list.isSanctioned('0x0000000000000000000000000000000000000001')).toBe(true);
    expect((await readdir(directory)).sort()).toEqual(['ofac-addresses.json', 'ofac-addresses.json.keep']);

    now += 61_000;
    expect(() => list.isSanctioned(EVM)).toThrow('missing or stale');
    list.close();
  });

  it('does not start without a usable list when OFAC is unavailable', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'swirl-ofac-offline-'));
    const list = new OfacAddressList({
      cacheFile: path.join(directory, 'cache.json'),
      fetchImpl: async () => { throw new Error('offline'); },
      refreshIntervalMs: 60_000,
      maxStaleMs: 60_000,
    });
    await expect(list.start()).rejects.toThrow('offline');
    expect(() => list.isSanctioned(EVM)).toThrow('missing or stale');
    list.close();
  });
});

describe('PublicAML v2 and combined production screening', () => {
  const shield = { transactionHash: '0x00', fromAddressLowercase: EVM, timestamp: 100 };
  const publicAmlBody = (legalStatus: unknown, score = 100) => JSON.stringify({
    entities: [{ wallet_address: EVM, axes: { legal_status: legalStatus }, risk: { score } }],
    not_found: [],
  });

  it('blocks direct sanctions and only uses risk scores when a threshold is configured', async () => {
    const sanctioned = new PublicAmlScreener({
      chain: 'ETH',
      fetchImpl: async () => response(publicAmlBody({ category: 'sanction', source: 'ofac:sdn_advanced', designation: { authority: 'OFAC' } })),
    });
    expect((await sanctioned.screen(EVM)).shouldAllow).toBe(false);

    const highRisk = new PublicAmlScreener({ chain: 'ETH', fetchImpl: async () => response(publicAmlBody(null, 90)) });
    expect((await highRisk.screen(EVM)).shouldAllow).toBe(true);
    const threshold = new PublicAmlScreener({ chain: 'ETH', blockScore: 70, fetchImpl: async () => response(publicAmlBody(null, 90)) });
    expect((await threshold.screen(EVM)).shouldAllow).toBe(false);
  });

  it('accepts a not-found result but rejects malformed and unavailable responses', async () => {
    const cleanAddress = '0x0000000000000000000000000000000000000001';
    const clean = new PublicAmlScreener({
      chain: 'ETH', fetchImpl: async () => response(JSON.stringify({ entities: [], not_found: [cleanAddress] })),
    });
    expect((await clean.screen(cleanAddress)).shouldAllow).toBe(true);
    const malformed = new PublicAmlScreener({ chain: 'ETH', fetchImpl: async () => response('{}') });
    await expect(malformed.screen(EVM)).rejects.toThrow('invalid response');
    const offline = new PublicAmlScreener({ chain: 'ETH', fetchImpl: async () => { throw new Error('offline'); } });
    await expect(offline.screen(EVM)).rejects.toThrow('screening unavailable');
  });

  it('keeps OFAC authoritative, fails closed when PublicAML is required and permits explicit optional fallback', async () => {
    const screen = vi.fn(async () => { throw new Error('PublicAML offline'); });
    const provider = new SwirlListProvider({
      mode: 'ofac',
      ofacList: { isSanctioned: () => false, stats: { ready: true } },
      publicAml: { screen },
      publicAmlRequired: true,
    });
    await expect(provider.shouldAllowShield(shield)).rejects.toThrow('PublicAML offline');
    const optional = new SwirlListProvider({
      mode: 'ofac',
      ofacList: { isSanctioned: () => false, stats: { ready: true } },
      publicAml: { screen },
      publicAmlRequired: false,
    });
    expect((await optional.shouldAllowShield(shield)).shouldAllow).toBe(true);

    const ofacBlocked = new SwirlListProvider({
      mode: 'ofac',
      ofacList: { isSanctioned: () => true, stats: { ready: true } },
      publicAml: { screen },
      publicAmlRequired: true,
    });
    expect((await ofacBlocked.shouldAllowShield(shield)).shouldAllow).toBe(false);
    expect(screen).toHaveBeenCalledTimes(2);
  });
});
