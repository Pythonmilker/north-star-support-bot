/**
 * THE LEAKED-KEY TEST *
 * Anything in a browser bundle is public. The build can deliberately bake a disposable key into
 * dist/ (see vite.config.ts), which is exactly the convenience that ends with a live key in git.
 *
 * So the rule is split, and the split is the whole point:
 *
 *   SOURCE TREE (src/, demo/, tests/, config)  no credential, ever. No exceptions.
 *   BUILT BUNDLE (dist/)                       only the ONE key you deliberately configured.
 *                                              Any other credential is a leak and fails.
 *
 * That way a deliberate demo build passes, while a key pasted into a component, committed to a demo
 * page, or left behind by a stray dependency still fails the build. The configured key is read from
 * the local key file and compared by value; it is never printed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Credential shapes. Each requires a long random-looking tail, so documentation placeholders like
 * `sk-or-...` and the UI's `sk-or-…` hint text don't trip it — only something that could actually work.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['OpenRouter key', /sk-or-[A-Za-z0-9_-]{20,}/g],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI key', /sk-proj-[A-Za-z0-9_-]{20,}/g],
  ['Generic bearer secret', /\bBearer\s+[A-Za-z0-9_-]{32,}/g],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Private key block', /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
];

/** The source tree. A credential here is always a bug. */
const SOURCE_DIRS = ['src', 'demo', 'tests', 'proxy'];
const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.html', '.json', '.md', '.css', '']);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCAN_EXTS.has(extname(entry))) out.push(full);
  }
  return out;
}

/**
 * The key the build was deliberately told to embed, if any. Read from the local, gitignored key file
 * so the test can tell "the one key I meant to ship" apart from "a key I did not know was there".
 * Returns undefined when no key is configured, in which case dist/ must be completely clean.
 */
function configuredDemoKey(): string | undefined {
  const fromEnv = process.env['NORTHSTAR_DEMO_KEY'];
  if (fromEnv) return fromEnv.trim();

  const keyFile = join(ROOT, '.env.local');
  if (!existsSync(keyFile)) return undefined;
  const line = readFileSync(keyFile, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('NORTHSTAR_DEMO_KEY='));
  if (!line) return undefined;
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
}

const sourceFiles = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d)));

describe('the source tree contains no credential, ever', () => {
  it('finds files to scan (a scanner that scans nothing passes forever)', () => {
    expect(sourceFiles.length).toBeGreaterThan(5);
  });

  it.each(SECRET_PATTERNS)('no %s in src/, demo/, tests/ or proxy/', (_label, pattern) => {
    const hits = sourceFiles.filter((f) => new RegExp(pattern.source).test(readFileSync(f, 'utf8')));
    expect(
      hits.map((f) => f.replace(ROOT, '')),
      'Credential found in the source tree. Rotate it immediately, then move it to the local key file.',
    ).toEqual([]);
  });
});

/**
 * The scan above walks four directories. That is not the same question.
 *
 * The question that actually matters is "can an UNINTENDED credential be COMMITTED from this repo", and
 * the answer depends on what git can see — which includes the repo root, and every scratch file someone
 * leaves lying around while moving a key from one place to another. Those files are named for the moment
 * ("key.txt", "paste here, delete later") rather than for the risk, they sit outside every source
 * directory, and they are the ones that get swept up by `git add -A`.
 *
 * So ask git directly. `ls-files -co --exclude-standard` is exactly the set of files git would commit:
 * tracked, plus untracked-and-not-ignored. Anything gitignored — .env.local — is correctly absent,
 * because a file git cannot see cannot leak through git.
 *
 * ONE deliberate exception: dist/north-star-bot.js. That file is committed AND is allowed to carry the
 * one disposable demo key baked in at build time — that is the whole point of the evaluation build. It
 * has its own validator below ("the built bundle contains only the key you meant to ship"), which proves
 * it holds EXACTLY the configured key and no other credential. So it is excluded here rather than
 * double-judged by two tests with opposite expectations.
 */
const BUILT_BUNDLE = 'dist/north-star-bot.js';

describe('nothing git can see contains a credential', () => {
  function filesGitWouldCommit(): string[] {
    try {
      return execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
        cwd: ROOT,
        encoding: 'utf8',
      })
        .split(/\r?\n/)
        .filter(Boolean)
        // The built bundle is the sanctioned home of the demo key; the bundle test judges it instead.
        .filter((rel) => rel.replace(/\\/g, '/') !== BUILT_BUNDLE);
    } catch {
      return []; // not a git repo, or git is unavailable — the directory scan above still applies
    }
  }

  it('sees a realistic number of files (a scanner that scans nothing passes forever)', () => {
    expect(filesGitWouldCommit().length).toBeGreaterThan(10);
  });

  /**
   * And proves the patterns actually fire. Both halves are needed: without this, a typo in a regex turns
   * the whole file into a test that congratulates us for finding nothing.
   */
  it('would actually catch a key if one were there', () => {
    // Assembled at runtime on purpose. Written as one literal, this fixture would be a matching
    // credential shape sitting in a scanned file — and the scanner would dutifully fail on it.
    // (It did, the first time. The test caught its own test.)
    const synthetic = ['sk', 'or', 'v1', '0123456789abcdef0123456789abcdef'].join('-');
    const openRouter = SECRET_PATTERNS.find(([label]) => label === 'OpenRouter key')![1];
    expect(new RegExp(openRouter.source).test(synthetic)).toBe(true);
  });

  it.each(SECRET_PATTERNS)('no %s in any committable file', (_label, pattern) => {
    const hits = filesGitWouldCommit().filter((rel) => {
      const full = join(ROOT, rel);
      if (!existsSync(full) || !SCAN_EXTS.has(extname(rel))) return false;
      try {
        return new RegExp(pattern.source).test(readFileSync(full, 'utf8'));
      } catch {
        return false; // unreadable or binary
      }
    });

    expect(
      hits,
      'A credential sits in a file git would commit. Rotate the key, then delete the file — do not just ' +
        'gitignore it, because the key in it is already compromised the moment it is shared.',
    ).toEqual([]);
  });
});

describe('the built bundle contains only the key you meant to ship', () => {
  const bundle = join(ROOT, 'dist', 'north-star-bot.js');

  it('contains no credential other than the configured demo key', () => {
    if (!existsSync(bundle)) return; // not built yet; the source scan above still applies
    const code = readFileSync(bundle, 'utf8');
    const expected = configuredDemoKey();

    const found: string[] = [];
    for (const [label, pattern] of SECRET_PATTERNS) {
      for (const match of code.matchAll(new RegExp(pattern.source, 'g'))) {
        // The one deliberately configured key is allowed here and nowhere else.
        if (expected && match[0] === expected) continue;
        // Never print the secret itself, only what kind it was and where.
        found.push(`${label} at offset ${match.index}`);
      }
    }

    expect(
      found,
      'An unexpected credential is in dist/north-star-bot.js. The bundle is public. Rotate it.',
    ).toEqual([]);
  });

  it('is clean when no demo key is configured', () => {
    if (!existsSync(bundle) || configuredDemoKey()) return;
    const code = readFileSync(bundle, 'utf8');
    for (const [label, pattern] of SECRET_PATTERNS) {
      expect(new RegExp(pattern.source).test(code), `${label} is baked into the bundle`).toBe(false);
    }
  });
});
