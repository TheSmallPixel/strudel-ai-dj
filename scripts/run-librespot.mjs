#!/usr/bin/env node
/**
 * Spawn the librespot binary as a Spotify Connect device named "Strudel AI DJ".
 *
 * Lookup order for the binary:
 *   1. $LIBRESPOT_PATH
 *   2. ./bin/librespot.exe (Windows) or ./bin/librespot
 *   3. `librespot` on PATH
 *
 * librespot outputs through its default audio backend (rodio on most builds),
 * which means audio plays through the user's default output device. The Strudel
 * AI DJ console captures system audio via getDisplayMedia, so the agent hears
 * the same Spotify stream that's coming out of your speakers.
 *
 * Install:
 *   - Releases: https://github.com/librespot-org/librespot/releases
 *   - cargo: `cargo install librespot`
 *
 * The binary needs no flags beyond `--name`; Spotify Connect discovery is on
 * by default. After it starts, open your Spotify app and pick "Strudel AI DJ"
 * from the device list.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

const NAME = process.env.LIBRESPOT_DEVICE_NAME || 'Strudel AI DJ';
const BITRATE = process.env.LIBRESPOT_BITRATE || '320';

function findBinary() {
  if (process.env.LIBRESPOT_PATH && existsSync(process.env.LIBRESPOT_PATH)) {
    return process.env.LIBRESPOT_PATH;
  }
  const exe = platform() === 'win32' ? 'librespot.exe' : 'librespot';
  const local = join(process.cwd(), 'bin', exe);
  if (existsSync(local)) return local;
  // Fall through to PATH; spawn will surface ENOENT if not present.
  return exe;
}

const bin = findBinary();
const args = ['--name', NAME, '--bitrate', BITRATE, '--backend', 'rodio', '--initial-volume', '70'];

console.error(`[librespot] spawning ${bin} ${args.join(' ')}`);
const child = spawn(bin, args, { stdio: 'inherit' });
child.on('error', (e) => {
  console.error(`[librespot] failed to start: ${e.message}`);
  console.error('[librespot] Install instructions:');
  console.error('  - Download a release: https://github.com/librespot-org/librespot/releases');
  console.error('  - Or build with cargo: cargo install librespot');
  console.error('  - Then set LIBRESPOT_PATH=/path/to/librespot, OR drop the binary at ./bin/librespot[.exe]');
  process.exit(127);
});
child.on('exit', (code) => process.exit(code ?? 0));

const forward = (sig) => {
  if (!child.killed) child.kill(sig);
};
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));
