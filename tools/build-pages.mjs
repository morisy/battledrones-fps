// Build the current checkout at the site root, and each version tag beneath it.
// Run after npm ci and git fetch --tags (CI checks out main with full history).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createVersionArchive, restoreVersionArchive } from "./pages-archive.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "_site");
// The site's path: PAGES_BASE if set ("/" for a site served at a domain's root), else the repository's
// name as GitHub Pages serves a project site (/battledrones-fps/ for owner/battledrones-fps).
const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const base = process.env.PAGES_BASE || (repoName ? `/${repoName}/` : "/battledrones/");
// An empty override forces historical versions to rebuild from source.
const cacheURL = process.env.PAGES_CACHE_URL ?? "https://simonw.github.io/battledrones/";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const tags = git("tag", "--list", "--sort=version:refname", "v[0-9]*")
  .split("\n").filter(Boolean);

// Each tag is one URL segment, including future semver/prerelease tags.
for (const tag of tags) {
  if (!/^v[0-9][A-Za-z0-9.+-]*$/.test(tag)) throw new Error(`Unsupported version tag: ${tag}`);
}

// A tag's build knows its tag (VERSION_TAG: vite.config.ts), so battle records pinned to it play unchecked.
function build(cwd, destination, publicBase, tag = null) {
  execFileSync("npm", ["run", "build", "--", "--base", publicBase,
    "--outDir", destination, "--emptyOutDir"], { cwd, stdio: "inherit", env: { ...process.env, VERSION_TAG: tag ?? "" } });
  if (!existsSync(join(destination, "index.html"))) throw new Error(`Missing build: ${destination}`);
}

console.log("Building the current game");
build(root, output, base);
const versions = [{ tag: null, commit: git("rev-parse", "HEAD"), path: base }];

for (const tag of tags) {
  const version = { tag, commit: git("rev-parse", `refs/tags/${tag}^{commit}`), path: `${base}${tag}/` };
  const destination = join(output, tag);
  versions.push(version);
  if (cacheURL && await restoreVersionArchive(
    `${cacheURL.replace(/\/$/, "")}/${tag}/${tag}.zip`, destination, version
  )) continue;
  console.log(`\nBuilding ${tag}`);
  const temporary = mkdtempSync(join(tmpdir(), "battledrones-pages-"));
  try {
    const archive = join(temporary, "source.tar");
    const source = join(temporary, "source");
    mkdirSync(source);
    // Use each tag's own source, lockfile and Vite config, never its docs/ build.
    execFileSync("git", ["archive", "--format=tar", "--output", archive, `refs/tags/${tag}`], { cwd: root });
    execFileSync("tar", ["-xf", archive, "-C", source]);
    execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: source, stdio: "inherit" });
    build(source, destination, version.path, tag);
    createVersionArchive(destination, version);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

writeFileSync(join(output, "versions.json"), `${JSON.stringify(versions, null, 2)}\n`);
writeFileSync(join(output, ".nojekyll"), "");
console.log(`\nBuilt the current game and ${tags.length} version(s) in ${output}`);
