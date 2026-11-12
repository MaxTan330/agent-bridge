import { appendFileSync, readFileSync } from 'node:fs';

/** A release must describe the same stable version in every published artifact. */
export function validateRelease(version, tag, manifestVersion, changelog) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('package.json must contain a stable major.minor.patch version');
  }
  if (tag !== `v${version}`) throw new Error('Release tag does not match package.json version');
  if (manifestVersion !== version) throw new Error('Release manifest does not match package.json version');
  const headings = [...changelog.matchAll(/^## (?:\[([^\]]+)\]|(\S+))/gm)];
  if (!headings.some(match => (match[1] ?? match[2]) === version)) {
    throw new Error('CHANGELOG.md has no entry for the package.json version');
  }
  return version;
}

if (import.meta.main) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const manifest = JSON.parse(readFileSync('.release-please-manifest.json', 'utf8'));
  const version = validateRelease(pkg.version, process.env.RELEASE_TAG, manifest['.'], readFileSync('CHANGELOG.md', 'utf8'));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  console.log(`Release version verified: ${version}`);
}
