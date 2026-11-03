/**
 * Turns the production Vite output into a static site that runs on GitHub
 * Pages (or any plain file host): the production build leaves EJS locals
 * (`<%- gitCommit %>`, `<%- locals.cdnBaseRaw %>`, …) for the game server's
 * renderer to fill, and writes every source asset to a root-absolute
 * `/_assets/...` URL that only the CDN layout has room for.
 *
 * The site is published from a repository sub-path (`/<repo>/`), where GitHub
 * Pages serves `/<repo>/game/<id>` as a 404 instead of the SPA fallback a game
 * server has. The client copes with that path itself (singleplayer runs in the
 * browser and deep links are never navigated to, see ClientEnv.basePath), and
 * this script makes the files match:
 *
 * 1. writes a `404.html` that returns to the site root, so an unknown path
 *    still lands on the page rather than GitHub's own error screen;
 * 2. rewrites the hashed `/_assets/...` URLs to the deployment path in the
 *    asset manifest — or, with `--cdn-base <url>`, prefixes them with that
 *    URL and ships without the assets;
 * 3. renders the EJS locals into `index.html`, naming no game server (a
 *    static page has none: there is no cluster map, instance letter or
 *    serverHost, so the client takes its static-page paths);
 * 4. makes the bundle and its worker references relative to the page.
 *
 * Usage:
 *   tsx scripts/build-pages.ts --out <dir> [--base <path>] [--cdn-base <url>]
 *
 * `--out` is the published folder: it gets the Vite output and, unless a CDN
 * base is given, the `_assets` tree; `root-files.json` is replaced by a
 * `.nojekyll` marker (GitHub Pages' file index) and `asset-manifest.json` is
 * dropped, since the manifest is inlined in the page.
 *
 * The account API defaults to the public one (`JWT_AUDIENCE`, "openfront.io");
 * set it for a different backend, or to "localhost" for a local one.
 */
import { buildAssetUrl } from "@openfront/shared/AssetPaths";
import fs from "fs";
import path from "path";
import {
  type AssetManifest,
  getProprietaryDir,
  getPublicDir,
  getResourcesDir,
} from "../src/server/PublicAssetManifest";

const BUILD_DIR = "static";
const ASSETS_DIR = "_assets";
const ASSETS_MANIFEST = "asset-manifest.json";

/** Storybook-style arguments: `--name value`. */
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[arg.slice(2)] = "";
      continue;
    }
    args[arg.slice(2)] = next;
    i++;
  }
  return args;
}

function fail(message: string): never {
  throw new Error(`build-pages: ${message}`);
}

/** A base path without leading/trailing slashes: "/OpenFront/" becomes "OpenFront". */
function normalizeBase(raw: string | undefined): string {
  if (raw === undefined || raw === "" || raw === "/") return "";
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (
    trimmed === "" ||
    trimmed.split(/[\\/]/).some((p) => p === "." || p === "..")
  ) {
    fail(`invalid --base ${JSON.stringify(raw)}`);
  }
  return trimmed;
}

function requireDir(dir: string, what: string): void {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    fail(
      `${what} not found at ${dir}; run "vite build" in production mode first`,
    );
  }
}

/**
 * Rewrite the manifest's hashed root URLs (`/_assets/...`) for a static host:
 * relative when served from the same folder, CDN-prefixed when the assets live
 * elsewhere.
 */
function rewriteManifest(
  assetsUrl: string,
  cdnBase: string | undefined,
): string {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(BUILD_DIR, ASSETS_MANIFEST), "utf8"),
  ) as AssetManifest;
  const rewritten: AssetManifest = {};
  for (const [assetPath, hashedUrl] of Object.entries(manifest)) {
    const relative = hashedUrl.replace(/^\/+/, "");
    if (!relative.startsWith(`${ASSETS_DIR}/`)) {
      // Vite's own bundle files: they are published unchanged in the page's
      // `assets/` folder and referenced relatively, so they need no manifest
      // URL — the entry is simply left out.
      continue;
    }
    const published = relative.slice(ASSETS_DIR.length + 1);
    rewritten[assetPath] = cdnBase
      ? `${cdnBase}/${relative}`
      : `${assetsUrl}${published}`;
  }
  return JSON.stringify(rewritten);
}

/** Replaces `<%- code %>` with the value `locals` gives for that code. */
function renderLocals(
  html: string,
  locals: Record<string, string>,
  ternaries: Record<string, string>,
): string {
  const unhandled: string[] = [];
  // The project's template has ternaries for optional locals — never add a
  // placeholder the Steam shell does not supply, so the condition guards an
  // absent variable. Resolved from the expression alone, and the suffix is
  // only consulted for the head a ternary starts with.
  const isWordChar = (text: string, at: number): boolean =>
    at < text.length && /[\w.$]/.test(text.charAt(at));
  const output = html.replace(
    /<%[-=]?\s*([\s\S]*?)\s*%>/g,
    (match, code: string) => {
      const trimmed = code.trim();
      if (Object.hasOwn(locals, trimmed)) return locals[trimmed];
      // A bare conditional: "typeof cluster !== ..." — the head alone names it.
      for (const [head, value] of Object.entries(ternaries)) {
        if (trimmed.startsWith(head) && !isWordChar(trimmed, head.length)) {
          return value;
        }
      }
      // The page-level URLs are written as "x || """, so the head is the
      // expression before the operator.
      for (const [head, value] of Object.entries(locals)) {
        if (
          trimmed.startsWith(head) &&
          /^\s*\|\|/.test(trimmed.slice(head.length))
        ) {
          return value;
        }
      }
      unhandled.push(trimmed);
      return match;
    },
  );
  if (unhandled.length > 0) {
    fail(`the page still has unhandled EJS locals: ${unhandled.join(", ")}`);
  }
  // Only the EJS tags were rewritten above; guard against a stray "<%-" left
  // in a value.
  if (/<%[-=]/.test(output)) {
    fail("a rendered value still contains template syntax");
  }
  return output;
}

/**
 * GitHub Pages answers a missing file with `/<repo>/404.html`, so every route
 * lands there instead of the page. That copy returns to the site root, which
 * the client then resolves (a join link, a friend's profile, a replay URL).
 */
const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>OpenFront</title>
    <script>
      // Keep whatever the missing URL carried: the path and the ?host or
      // #hash forms, which the page can still act on.
      var target = "./" + (location.search || "") + (location.hash || "");
      location.replace(target);
    </script>
  </head>
  <body>
    <p>Redirecting… <a href="./">OpenFront</a></p>
  </body>
</html>
`;

function writeFile(dest: string, content: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
}

function copyDir(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true });
}

/** Directory entry that keeps GitHub Pages from running Jekyll over the site. */
function writeNoJekyll(dir: string): void {
  writeFile(path.join(dir, ".nojekyll"), "");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const outArg = args.out;
  if (outArg === undefined || outArg === "")
    fail("--out <directory> is required");
  const out = path.resolve(outArg);
  const base = normalizeBase(args.base);
  const cdnBase =
    args["cdn-base"] !== undefined && args["cdn-base"] !== ""
      ? args["cdn-base"].replace(/\/+$/, "")
      : undefined;
  // Everything the page references lives under the deployment path, so the
  // page-local URLs are built from it: relative when there is no base.
  const assetsUrl = base === "" ? `${ASSETS_DIR}/` : `/${base}/${ASSETS_DIR}/`;
  const sitePrefix = base === "" ? "" : `/${base}`;

  requireDir(BUILD_DIR, "the production build");
  const resourcesDir = getResourcesDir(process.cwd());
  const publicDir = getPublicDir(resourcesDir);
  const proprietaryDir = getProprietaryDir(process.cwd());
  requireDir(publicDir, "resources/public");

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  // Everything except the two source asset trees and the two server-only
  // indexes: those are assembled (or replaced) below.
  for (const entry of fs.readdirSync(BUILD_DIR)) {
    if (entry === ASSETS_DIR || entry === "root-files.json") continue;
    if (entry === ASSETS_MANIFEST) continue;
    const from = path.join(BUILD_DIR, entry);
    const to = path.join(out, entry);
    if (fs.statSync(from).isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }

  const assetManifest = rewriteManifest(assetsUrl, cdnBase);
  const manifest = JSON.parse(assetManifest) as AssetManifest;
  // The manifest already carries the deployment path, so the page-level URLs
  // look the asset up and use it as is.
  const assetPageHref = (assetPath: string): string => {
    const url = buildAssetUrl(assetPath, manifest);
    if (!url.startsWith("/") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      // Never emitted by the manifest — resolve against the deployment path,
      // since a root-relative "/_assets/..." does not exist on Pages.
      return `${assetsUrl}${url.replace(/^\/+/, "")}`;
    }
    return url;
  };
  const htmlLocals: Record<string, string> = {
    // The game server's own locals, all supplied: the page is the whole site
    // here, so it carries the real values instead of a server's.
    gitCommit: JSON.stringify(process.env.GITHUB_SHA?.slice(0, 12) ?? "PAGES"),
    assetManifest,
    cdnBase: JSON.stringify(cdnBase ?? ""),
    gameEnv: JSON.stringify(process.env.GAME_ENV ?? "dev"),
    turnstileSiteKey: JSON.stringify(process.env.TURNSTILE_SITE_KEY ?? ""),
    // The account API's audience ("api.<audience>"): a static page reaches the
    // public one unless it was given its own. Empty would resolve to "api."
    // and every API call would fail to resolve.
    jwtAudience: JSON.stringify(process.env.JWT_AUDIENCE ?? "openfront.io"),
    "locals.cdnBaseRaw": cdnBase ?? "",
    // Page-only URLs: the deployment path, then the manifest lookup. Already
    // quoted for both the HTML attributes and the JavaScript template.
    manifestHref: assetPageHref("manifest.json"),
    faviconHref: assetPageHref("images/Favicon.svg"),
    gameplayScreenshotUrl: assetPageHref("images/GameplayScreenshot.png"),
    backgroundImageUrl: assetPageHref("images/background.webp"),
    desktopLogoImageUrl: assetPageHref("images/OpenFront.png"),
    mobileLogoImageUrl: assetPageHref("images/OF.png"),
  };
  // The static page names no game server of its own (no cluster map, no
  // instance letter, no serverHost), so the client's static-page paths apply:
  // singleplayer runs in the browser, and multiplayer needs the API's server
  // list. Each ternary then resolves its "absent" arm.
  const ternaries: Record<string, string> = {
    "typeof cluster": "",
    "typeof instanceLetter": "",
    "typeof stripePublishableKey": "",
    "typeof faroCollectorUrl": "",
    "typeof instanceId": "",
    "typeof serverHost": "",
    "typeof siteHost": "",
  };

  const templatePath = path.join(out, "index.html");
  let html = renderLocals(
    fs.readFileSync(templatePath, "utf8"),
    htmlLocals,
    ternaries,
  );
  // The bundle's own files live in `assets/`, next to the page: make their
  // references relative to the document so the site works from any
  // deployment path (GitHub Pages serves it under "/<repo>/"). Worker URLs
  // emitted by the bundle's JS carry an absolute "/assets/" too; they are
  // resolved against the deployment path by the client's pageHref().
  html = html.replace(/(\s(?:src|href)=["'])\/assets\//g, "$1assets/");
  writeFile(templatePath, html);

  // The game-only pages have their own placeholders (a policy body, contact
  // addresses, the page tabs) which only the game server renders. They are not
  // part of the static page's flow, so they ship as they are.

  writeFile(path.join(out, "404.html"), NOT_FOUND_HTML);

  if (cdnBase === undefined) {
    copyDir(path.join(BUILD_DIR, ASSETS_DIR), path.join(out, ASSETS_DIR));
  } else {
    console.log(`Skipping ${ASSETS_DIR}/ — assets are served from ${cdnBase}`);
  }

  // Root files (privacy, terms, press kit, robots.txt, .well-known, ...) stay
  // at stable, unhashed URLs. Copied before the page is written: the public
  // tree has its own index.html, which must not overwrite the game's page.
  if (fs.existsSync(publicDir)) {
    copyDir(publicDir, out);
  }
  if (fs.existsSync(proprietaryDir)) {
    copyDir(proprietaryDir, out);
  }
  writeNoJekyll(out);

  console.log(
    `build-pages: wrote ${out} (base "${sitePrefix}/", ${cdnBase ? `assets from ${cdnBase}` : "self-hosted assets"})`,
  );
}

main();
