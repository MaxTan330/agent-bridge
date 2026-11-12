import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRelease } from '../scripts/release-version.mjs';

test('release version comes from package and matches tag, manifest and changelog', () => {
  assert.equal(validateRelease('1.0.0', 'v1.0.0', '1.0.0', '# Changelog\n\n## [1.0.0](https://example.com) (2026-11-12)\n'), '1.0.0');
  assert.equal(validateRelease('0.1.0', 'v0.1.0', '0.1.0', '## 0.1.0\n'), '0.1.0');
});

test('release rejects mismatched versions and absent release notes', () => {
  assert.throws(() => validateRelease('1.0.0', 'v1.0.1', '1.0.0', '## 1.0.0'), /tag/);
  assert.throws(() => validateRelease('1.0.0', 'v1.0.0', '0.1.0', '## 1.0.0'), /manifest/);
  assert.throws(() => validateRelease('0.1.0', 'v0.1.0', undefined, '## 0.1.0'), /manifest/);
  assert.throws(() => validateRelease('1.0.0', 'v1.0.0', '1.0.0', '## 1.0.01'), /CHANGELOG/);
  assert.throws(() => validateRelease('1.0.0', 'v1.0.0', '1.0.0', '## 1.0.0-rc.1'), /CHANGELOG/);
});

test('only stable three-part package versions can be published', () => {
  for (const version of ['latest', '01.0.0', '1.0', '1.0.0-rc.1', '1.0.0+build', '1.0.0\ntag=evil']) {
    assert.throws(() => validateRelease(version, `v${version}`, version, `## ${version}`), /stable/);
  }
});
