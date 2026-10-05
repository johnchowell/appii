import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

interface SourceFile {
  path: string;
  text: string;
}

class SourceTree {
  static readonly ROOT = 'src';
  static readonly DOMAINS = ['build', 'capture', 'cli', 'export', 'forms', 'present'];
  static readonly EMITTED_RUNTIME = new Set(['src/export/ts-client-runtime.ts']);

  static files(dir: string = SourceTree.ROOT): SourceFile[] {
    const out: SourceFile[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...SourceTree.files(path));
      else if (entry.name.endsWith('.ts')) out.push({ path: relative('.', path).split(sep).join('/'), text: readFileSync(path, 'utf8') });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  static domainFiles(): SourceFile[] {
    return SourceTree.files().filter((file) => SourceTree.DOMAINS.some((domain) => file.path.startsWith(`src/${domain}/`)) && !SourceTree.EMITTED_RUNTIME.has(file.path));
  }
}

describe('architecture', () => {
  test('generic helpers live once in src/shared and are not copied into the domain namespaces', () => {
    const rules: [string, RegExp][] = [
      ['a private copy of a Shared helper', /\bstatic\s+#?(?:parseUrl|isPotentiallyTrustworthy|isLoopbackHost|isIpAddress|bareHost|errorMessage|statusCodes|statuses|isRedacted|stripBom|decode|matchPath|asciiJson)\s*\(|\bstatic\s+#(?:short|summary|parse)\s*\(\s*(?:value|problems|items)\b/],
      ['a safe URL parse or percent decode', /try\s*\{\s*return\s+(?:new URL|decodeURIComponent)\(/],
      ['the loopback host rules', /0:0:0:0:0:0:0:1|\b(?:LOOPBACK_NAMES|SECURE_SCHEMES)\s*[:=]|endsWith\('\.localhost'\)/],
      ['ASCII JSON serialization', /toAscii\(\s*(?:JSON\.stringify|Json\.prettyJson)\(/],
      ['byte order mark handling', /charCodeAt\(0\)\s*===\s*0xfeff/i],
      ['sorted unique response statuses', /new Set\(\s*\w+\.responses\.map\(/],
      ['in-band {{placeholder}} parsing', /\\\{\\\{\[a-z0-9_\]\+\\\}\\\}|hasPlaceholder/],
    ];
    const found: string[] = [];
    for (const file of SourceTree.domainFiles()) {
      for (const [label, pattern] of rules) if (pattern.test(file.text)) found.push(`${file.path}: ${label}`);
    }
    assert.deepEqual(found, []);
  });

  test('every class whose constructor takes collaborators has a static create() factory', () => {
    const missing: string[] = [];
    for (const file of SourceTree.files()) {
      for (const match of file.text.matchAll(/^export (abstract )?class (\w+)[^{]*\{/gm)) {
        if (match[1] !== undefined) continue;
        const start = (match.index ?? 0) + match[0].length;
        const next = file.text.slice(start).search(/^export (?:abstract )?class /m);
        const body = next < 0 ? file.text.slice(start) : file.text.slice(start, start + next);
        const ctor = /\n {2}constructor\(([^)]*)\)/.exec(body);
        if (!ctor || !/\bdeps\b|\w+Deps\b/.test(ctor[1] ?? '')) continue;
        if (!/\n {2}static (?:override )?create\(/.test(body)) missing.push(`${file.path}: ${match[2]}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  test('cross-domain imports go through the namespace barrels', () => {
    const deep: string[] = [];
    for (const file of SourceTree.files()) {
      const domain = file.path.split('/')[1];
      for (const match of file.text.matchAll(/from '(\.\.\/(?:\.\.\/)?([a-z]+)\/([^']+))'/g)) {
        const target = match[2];
        if (target !== domain && match[3] !== 'index.js') deep.push(`${file.path}: ${match[1]}`);
      }
    }
    assert.deepEqual(deep, []);
  });

  test('modules keep no mutable state at module level', () => {
    const problems: string[] = [];
    for (const file of SourceTree.files()) {
      if (/^(?:export )?(?:let|var) /m.test(file.text)) problems.push(`${file.path}: module-level let or var`);
      if (/\b[A-Z][A-Z0-9_]*\.lastIndex\s*=/.test(file.text)) problems.push(`${file.path}: shared pattern state`);
    }
    assert.deepEqual(problems, []);
  });

  test('source files are ASCII only and carry no comments', () => {
    const problems: string[] = [];
    for (const file of SourceTree.files()) {
      if (/[^\x00-\x7f]/.test(file.text)) problems.push(`${file.path}: non-ASCII`);
      if (/^\s*(?:\/\/|\/\*)/m.test(file.text)) problems.push(`${file.path}: comment`);
    }
    for (const file of [...SourceTree.files('test'), ...['README.md', 'package.json'].map((path) => ({ path, text: readFileSync(path, 'utf8') }))]) {
      if (/[^\x00-\x7f]/.test(file.text)) problems.push(`${file.path}: non-ASCII`);
    }
    assert.deepEqual(problems, []);
  });
});
