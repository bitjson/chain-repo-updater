#!/usr/bin/env bun
/**
 * chain-repo-updater.ts
 *
 * A minimal TS + Bun script that:
 *  - Initializes Git + Git LFS
 *  - Stores blockchain blocks in nested folders: blocks/<100k>/<1k>/<HEIGHT_HASH>.block
 *  - Syncs from last known block (minus 11 for reorg handling)
 *  - Polls `getbestblockhash` every minute to detect new blocks
 *  - Commits & optionally pushes each sync
 */

import { parseArgs } from 'util';
import { spawn, sleep } from 'bun';
import { mkdirSync, readdirSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

interface CliOptions {
  help?: boolean;
  cli?: string; // e.g. "bitcoin-cli -datadir=/my/data"
  verbose?: boolean;
  'no-push'?: boolean;
}

const parsed = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean' },
    cli: { type: 'string' },
    verbose: { type: 'boolean' },
    'no-push': { type: 'boolean' },
  },
});
const opts = parsed.values as CliOptions;
const positionals = parsed.positionals || [];

if (opts.help) {
  console.log(`
Usage:
  bun run chain-repo-updater.ts [OPTIONS] <repo-path>

  Options:
    --cli="CMD"      (default "bitcoin-cli")
    --verbose        (more logs)
    --no-push        (do not push to remote)
    --help           (show this message)

Example:
  bun run chain-repo-updater.ts --cli="bitcoin-cli -datadir=/my/data" /storage/bch-mainnet
`);
  process.exit(0);
}

const repoPath = positionals[positionals.length - 1];
if (!repoPath || typeof repoPath !== 'string') {
  console.error('Error: missing final <repo-path> argument.');
  process.exit(1);
}

const verbose = !!opts.verbose;
const noPush = !!opts['no-push'];
const cliRaw = opts.cli || 'bitcoin-cli';

function parseCliString(cliStr: string): {
  cliPath: string;
  defaultArgs: string[];
} {
  const parts = cliStr.trim().split(/\s+/);
  if (!parts.length) {
    return { cliPath: 'bitcoin-cli', defaultArgs: [] };
  }
  const [cliPath, ...defaultArgs] = parts;
  return { cliPath, defaultArgs };
}
const { cliPath, defaultArgs } = parseCliString(cliRaw);
const cli = [cliPath, ...defaultArgs];

if (verbose) {
  console.log('Parsed CLI:', cli);
}

async function runCmd(cmdArray: string[], allowFail = false): Promise<string> {
  if (verbose) console.log('> ', cmdArray.join(' '));
  const proc = spawn(cmdArray, { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (!allowFail && code !== 0) {
    throw new Error(`Command failed:\n${cmdArray.join(' ')}\n${err || out}`);
  }
  return out.trim();
}

/** Directory structure: blocks/<100k>/<1k>/<HEIGHT_HASH>.block */
function buildBlockPath(height: number, hash: string) {
  const top = Math.floor(height / 100000) * 100000;
  const sub = Math.floor(height / 1000) * 1000;
  const topStr = top ? `${top / 1000}k` : '0';
  const subStr = sub ? String(sub) : '0';
  return join('blocks', topStr, subStr, `${height}_${hash}.block`);
}

/** Find the highest block in the blocks/ folder */
function findLastHeight(): number {
  const blocksDir = join(repoPath, 'blocks');
  if (!existsSync(blocksDir)) return -1;

  const topDirs = readdirSync(blocksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => (d.name === '0' ? 0 : parseInt(d.name) * 1000))
    .sort((a, b) => a - b);
  if (!topDirs.length) return -1;

  const lastTop = topDirs[topDirs.length - 1];
  const lastTopStr = lastTop ? `${lastTop / 1000}k` : '0';

  const subDirs = readdirSync(join(blocksDir, lastTopStr), {
    withFileTypes: true,
  })
    .filter((d) => d.isDirectory())
    .map((d) => parseInt(d.name))
    .sort((a, b) => a - b);
  if (!subDirs.length) return -1;

  const lastSub = subDirs[subDirs.length - 1].toString();
  const files = readdirSync(join(blocksDir, lastTopStr, lastSub))
    .filter((f) => f.endsWith('.block'))
    .map((f) => parseInt(f.split('_')[0]))
    .sort((a, b) => a - b);
  return files.length ? files[files.length - 1] : -1;
}

/**
 * Fetch a single block in hex, store it, return the block's hash as a string.
 * If out of range, throw RangeError so the caller can handle it.
 */
async function fetchBlock(height: number): Promise<string> {
  const hash = await runCmd([...cli, 'getblockhash', String(height)], true);
  if (hash.length === 0) {
    // stdout was empty
    throw new RangeError(`Block ${height} out of range`);
  }
  const dest = join(repoPath, buildBlockPath(height, hash));
  const dir = dest.slice(0, dest.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });

  // Remove stale
  readdirSync(dir)
    .filter(
      (f) => f.startsWith(`${height}_`) && f !== `${height}_${hash}.block`
    )
    .forEach((stale) => {
      rmSync(join(dir, stale));
      console.log('Removed stale block:', stale);
    });

  // If missing, fetch & write
  if (!existsSync(dest)) {
    const blockHex = await runCmd([...cli, 'getblock', hash, '0']);
    const blockBin = Buffer.from(blockHex, 'hex');
    writeFileSync(dest, blockBin);
    console.log(`Saved block ${height} => ${dest}`);
  }
  return hash;
}

/**
 * Sync from 'start' to chain tip, returning the last successful { height, hash }.
 * If everything is out of range from the start, we'll return null or {height:-1,hash:''}.
 */
async function syncFrom(
  start: number
): Promise<{ height: number; hash: string } | null> {
  let h = Math.max(0, start);
  let lastHash = '';
  let lastHeight = -1;
  if (verbose) console.log(`Syncing from height: ${h}`);
  while (true) {
    try {
      const fetchedHash = await fetchBlock(h);
      lastHeight = h;
      lastHash = fetchedHash;
      h++;
    } catch (e) {
      if (e instanceof RangeError) {
        if (verbose) console.log(`Reached tip, last height: ${lastHeight}`);
        // we reached chain tip
        // if we never fetched anything, return null
        return lastHeight < 0 ? null : { height: lastHeight, hash: lastHash };
      }
      throw e; // unknown error
    }
  }
}

/** Perform sync from last known - 11, then commit & push */
async function performSync() {
  if (verbose) console.log('Performing sync...');
  const lastLocal = findLastHeight();
  if (verbose) console.log(`Last height: ${lastLocal}`);
  const resume = Math.max(0, lastLocal - 11);
  const result = await syncFrom(resume);
  if (!result) {
    if (verbose) console.log('No new blocks synced.');
    return;
  }
  const { height, hash } = result;
  console.log(`Sync completed at block ${height}. Committing to git...`);
  await runCmd(['git', 'add', 'blocks']);
  await runCmd(
    ['git', 'commit', '-m', `Synced to block ${height} (${hash})`],
    true
  );
  if (!noPush) {
    await runCmd(['git', 'push'], true);
  }
}

(async function main() {
  try {
    process.chdir(repoPath);
  } catch {
    console.error(`Error: Cannot cd into ${repoPath}`);
    process.exit(1);
  }

  let isGit = true;
  try {
    await runCmd(['git', 'rev-parse', '--is-inside-work-tree']);
  } catch {
    isGit = false;
  }
  if (!isGit) {
    await runCmd(['git', 'init']);
    await runCmd(['git', 'config', '--local', 'http.version', 'HTTP/1.1']);
    mkdirSync('blocks', { recursive: true });
    await runCmd(['git', 'lfs', 'install', '--local'], true);
    await runCmd(['git', 'lfs', 'track', '*.block'], true);
    await runCmd(['git', 'add', '.'], true);
    if (verbose) console.log('Initialized Git + LFS');
  } else {
    mkdirSync('blocks', { recursive: true });
  }

  console.log('Beginning sync...');
  await performSync();

  let lastTip = await runCmd([...cli, 'getbestblockhash']);
  console.log('Polling for bestblockhash every 60s. Press Ctrl-C to stop.');

  while (true) {
    await sleep(60_000);
    let currTip = await runCmd([...cli, 'getbestblockhash'], true);
    if (currTip !== lastTip) {
      if (verbose) {
        console.log(
          `Chain tip changed: ${lastTip} => ${currTip} => resyncing...`
        );
      }
      await performSync();
      lastTip = currTip;
    } else if (verbose) {
      console.log('No tip change.');
    }
  }
})();
