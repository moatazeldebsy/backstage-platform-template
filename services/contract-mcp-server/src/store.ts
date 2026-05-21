import { parseSpec, extractPaths } from './generator.js';

export interface ContractEntry {
  version: string;
  specJson: string;
  timestamp: string;
  paths: string[];
}

const contracts = new Map<string, ContractEntry[]>();

export function register(serviceName: string, version: string, specString: string): ContractEntry {
  const parsed = parseSpec(specString);
  const paths = extractPaths(parsed);
  const entry: ContractEntry = {
    version,
    specJson: JSON.stringify(parsed),
    timestamp: new Date().toISOString(),
    paths,
  };
  const entries = contracts.get(serviceName) ?? [];
  const idx = entries.findIndex(e => e.version === version);
  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
  contracts.set(serviceName, entries);
  return entry;
}

export function getLatest(serviceName: string): ContractEntry | undefined {
  const entries = contracts.get(serviceName);
  return entries?.[entries.length - 1];
}

export function getByVersion(serviceName: string, version: string): ContractEntry | undefined {
  return contracts.get(serviceName)?.find(e => e.version === version);
}

export function listAll(): Array<{ serviceName: string; versions: string[]; latestVersion: string; registeredAt: string }> {
  const result: Array<{ serviceName: string; versions: string[]; latestVersion: string; registeredAt: string }> = [];
  for (const [serviceName, entries] of contracts) {
    const latest = entries[entries.length - 1];
    result.push({
      serviceName,
      versions: entries.map(e => e.version),
      latestVersion: latest?.version ?? 'none',
      registeredAt: latest?.timestamp ?? '',
    });
  }
  return result;
}
