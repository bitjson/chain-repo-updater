#!/usr/bin/env bun
/**
 * chain-repo-updater.ts
 *
 * A minimal TS + Bun script that:
 *  - Initializes Git + Git LFS
 *  - Stores blockchain blocks in nested folders: blocks/<100k>/<1k>/<HEIGHT_HASH>.block
 *  - Syncs from last known block (minus ~11 for short reorg handling)
 *  - Subscribes to ZMQ "hashblock" to stay current
 *  - Commits & optionally pushes each sync
 */

import { parseArgs } from 'util';
import { spawn } from 'bun';
import { mkdirSync, readdirSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Subscriber } from 'zeromq';

interface CliOptions {
  help?: boolean;
  mainnet?: boolean;
  testnet3?: boolean;
  testnet4?: boolean;
  chipnet?: boolean;
  'zmq-port'?: string;
  'zmq-host'?: string;
  cli?: string;
  verbose?: boolean;
  'no-push'?: boolean;
}

type NetFlag = 'mainnet' | 'testnet3' | 'testnet4' | 'chipnet';

const parsed = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean' },
    mainnet: { type: 'boolean' },
    testnet3: { type: 'boolean' },
    testnet4: { type: 'boolean' },
    chipnet: { type: 'boolean' },
    'zmq-port': { type: 'string' },
    'zmq-host': { type: 'string' },
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

  Must specify either:
    --mainnet | --testnet3 | --testnet4 | --chipnet
  OR explicitly set --zmq-port=N

  Other options:
    --zmq-host=HOST (default 127.0.0.1)
    --cli="CMD"     (default "bitcoin-cli")
    --verbose
    --no-push
    --help

Example:
  bun run chain-repo-updater.ts --mainnet --cli="bitcoin-cli" /data/bch-mainnet
`);
  process.exit(0);
}

/** List of possible network flags, typed as const so we can safely use .find(...) */
const netFlags = ['mainnet', 'testnet3', 'testnet4', 'chipnet'] as const;
const chosenFlag: NetFlag | undefined = netFlags.find((flag) => opts[flag]);

if (!chosenFlag && !opts['zmq-port']) {
  console.error(
    'Error: must specify --mainnet|--testnet3|--testnet4|--chipnet or --zmq-port=N'
  );
  process.exit(1);
}

const repoPath = positionals[positionals.length - 1];
if (!repoPath || typeof repoPath !== 'string') {
  console.error('Error: missing final <repo-path> argument.');
  process.exit(1);
}

const defaultPorts: Record<NetFlag, string> = {
  mainnet: '28332',
  testnet3: '18332',
  testnet4: '28334',
  chipnet: '38332',
};

const verbose = !!opts.verbose;
const noPush = !!opts['no-push'];
const cliCmd = opts.cli || 'bitcoin-cli';
const zmqHost = opts['zmq-host'] || '127.0.0.1';
const zmqPort =
  opts['zmq-port'] || (chosenFlag ? defaultPorts[chosenFlag] : '28332');

/** Helper to run a command and return stdout */
async function runCmd(
  cmd: string,
  args: string[],
  allowFail = false
): Promise<string> {
  if (verbose) console.log('>', cmd, ...args);
  const proc = spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (!allowFail && code !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}\n${err || out}`);
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

/** Download a block in hex, convert to binary, handle stale files if the hash changed */
async function fetchBlock(height: number) {
  const hashOut = await runCmd(cliCmd, ['getblockhash', String(height)], true);
  if (/out of range|error code: -8/i.test(hashOut)) {
    throw new RangeError(`Block ${height} out of range`);
  }
  const hash = hashOut.trim();
  const dest = join(repoPath, buildBlockPath(height, hash));
  const dir = dest.slice(0, dest.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });

  // remove stale
  readdirSync(dir)
    .filter(
      (f) => f.startsWith(`${height}_`) && f !== `${height}_${hash}.block`
    )
    .forEach((stale) => {
      rmSync(join(dir, stale));
      console.log('Removed stale block:', stale);
    });

  // fetch + write if missing
  if (!existsSync(dest)) {
    const blockHex = await runCmd(cliCmd, ['getblock', hash, '0']);
    const blockBin = Buffer.from(blockHex, 'hex');
    writeFileSync(dest, blockBin);
    console.log(`Saved block ${height} => ${dest}`);
  }
}

/** Sync blocks from 'start' up to chain tip (or until out of range error) */
async function syncFrom(start: number) {
  let h = Math.max(0, start);
  for (;;) {
    try {
      await fetchBlock(h);
      h++;
    } catch (e) {
      if (e instanceof RangeError) return h - 1; // out of range
      throw e;
    }
  }
}

/** Perform sync from last known - 11, then commit & push */
async function performSync() {
  const lastLocal = findLastHeight();
  const resume = Math.max(0, lastLocal - 11);
  const newTip = await syncFrom(resume);
  if (newTip < 0) {
    if (verbose) console.log('No new blocks synced.');
    return;
  }
  // commit
  const tipHash = await runCmd(cliCmd, ['getblockhash', String(newTip)], true);
  await runCmd('git', ['add', 'blocks']);
  await runCmd(
    'git',
    ['commit', '-m', `Synced to block ${newTip} (${tipHash})`],
    true
  );
  if (!noPush) {
    await runCmd('git', ['push'], true);
  }
  console.log(`Sync completed at block ${newTip}`);
}

/** Main script */
(async function main() {
  // cd into repo
  try {
    process.chdir(repoPath);
  } catch {
    console.error(`Error: Cannot cd into ${repoPath}`);
    process.exit(1);
  }

  // initialize if not a git repo
  let isGit = true;
  try {
    await runCmd('git', ['rev-parse', '--is-inside-work-tree']);
  } catch {
    isGit = false;
  }
  if (!isGit) {
    await runCmd('git', ['init']);
    await runCmd('git', ['config', '--local', 'http.version', 'HTTP/1.1']);
    mkdirSync('blocks', { recursive: true });
    // Git LFS steps
    await runCmd('git', ['lfs', 'install', '--local'], true);
    await runCmd('git', ['lfs', 'track', '*.block'], true);
    await runCmd('git', ['add', '.gitattributes'], true);
    await runCmd('git', ['commit', '-m', 'Configure LFS for *.block'], true);
    if (verbose) console.log('Initialized Git + LFS');
  } else {
    mkdirSync('blocks', { recursive: true });
  }

  console.log('Beginning sync...');
  await performSync();

  // subscribe to ZMQ
  const sub = new Subscriber();
  sub.connect(`tcp://${zmqHost}:${zmqPort}`);
  sub.subscribe('hashblock');
  if (verbose)
    console.log(`Subscribed to ZMQ: tcp://${zmqHost}:${zmqPort} (hashblock)`);
  for await (const [topic] of sub) {
    if (topic.toString() === 'hashblock') {
      if (verbose) console.log('ZMQ hashblock => re-sync last ~11 blocks...');
      await performSync();
    }
  }
})();
