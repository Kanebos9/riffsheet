import { defineConfig } from 'vite';
import { resolve, join, dirname } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { alphaTab } from '@coderline/alphatab-vite';

/**
 * Riffsheet web core.
 *
 * CLASSIC SCRIPTS, NOT ES MODULES — this is not a style preference.
 * WKWebView refuses to load `<script type="module">` over the `juce://` scheme JUCE serves
 * the page from ("Importing a module script failed"), measured by Team A in the shipping
 * shell (shell/BRIDGE.md §0). `fetch`, classic `<script src>`, Workers (including module
 * workers) and AudioContext are all fine — only the main document's scripts are affected.
 * So the output format is `iife` with `inlineDynamicImports`, and `modulePreload` is off to
 * stop Vite emitting `<link rel=modulepreload crossorigin>`.
 *
 * Everything must be self-contained: no CDN, no network at runtime. The build copies only the
 * required Bravura formats and licences from the pinned alphaTab package. alphaTab's Vite plugin
 * still rewrites its worker URLs, but its bulk asset copying is disabled because its SONiVOX
 * soundfont is unused in ExternalMedia mode.
 */

// Team C's pipeline lives at ../pipeline and is consumed as TypeScript source (its
// package.json points main at ./src/index.ts), so Vite transpiles it with everything else.
//   @pipeline-impl -> Team C's package, imported ONLY by src/pipeline/index.ts
//   @pipeline      -> our adapter, which is what the rest of webcore imports
const teamCPipeline = resolve(__dirname, '../pipeline/src/index.ts');
if (!existsSync(teamCPipeline)) {
  throw new Error(
    `Team C's pipeline was not found at ${teamCPipeline}.\n` +
      'webcore has no fallback any more — the mock was removed once the real pipeline landed.'
  );
}

/**
 * Rewrite the emitted script tag to a classic one.
 *
 * `output.format: 'iife'` makes the BUNDLE a classic script, but Vite still writes
 * `<script type="module" crossorigin>` into the HTML, and that attribute alone is enough
 * for WKWebView to refuse it over juce://. There is no Vite option for this, so the tag is
 * rewritten at the end of the build.
 *
 * `defer` is not cosmetic: a module script is deferred by default, a classic one is not, so
 * dropping `type="module"` alone makes the bundle run in <head> before <body> exists and
 * every `document.getElementById` returns null. Classic + defer keeps both properties.
 */
function classicScripts() {
  return {
    name: 'riffsheet-classic-scripts',
    enforce: 'post' as const,
    transformIndexHtml(html: string) {
      return html
        .replace(/<script\s+type="module"\s+/g, '<script defer ')
        .replace(/\s+crossorigin(?=[\s>])/g, '')
        .replace(/<link[^>]+rel="modulepreload"[^>]*>/g, '');
    }
  };
}

/**
 * Package the exact alphaTab assets Riffsheet uses, with their notices.
 *
 * Resolving the installed package instead of keeping duplicate files under public/ makes the
 * package-lock pin authoritative. The browser requests woff2, then woff, then otf; SVG/EOT and
 * the optional soundfont are deliberately excluded. The MPL licence/header are distributed
 * beside the bundled alphaTab code, and the Bravura OFL/FONTLOG travel beside the font.
 */
function packageThirdPartyAssets() {
  const require = createRequire(import.meta.url);
  const alphaTabDist = dirname(require.resolve('@coderline/alphatab'));
  const alphaTabRoot = resolve(alphaTabDist, '..');
  return {
    name: 'riffsheet-package-third-party-assets',
    closeBundle() {
      const fontOutput = join(__dirname, 'dist', 'font');
      mkdirSync(fontOutput, { recursive: true });
      for (const file of [
        'Bravura.woff2',
        'Bravura.woff',
        'Bravura.otf',
        'Bravura-OFL.txt',
        'Bravura-OFL-FAQ.txt',
        'Bravura-FONTLOG.txt'
      ]) {
        copyFileSync(join(alphaTabDist, 'font', file), join(fontOutput, file));
      }

      const noticeOutput = join(__dirname, 'dist', 'third-party', 'alphatab');
      mkdirSync(noticeOutput, { recursive: true });
      copyFileSync(join(alphaTabRoot, 'LICENSE'), join(noticeOutput, 'LICENSE'));
      copyFileSync(join(alphaTabRoot, 'LICENSE.header'), join(noticeOutput, 'LICENSE.header'));

      // Defensive cleanup in case a local public/ override contains the dormant player asset.
      rmSync(join(__dirname, 'dist', 'soundfont'), { force: true, recursive: true });
    }
  };
}

export default defineConfig(() => {
  // Sourcemaps are 17 MB and this folder is zipped into the plugin binary. Debug builds
  // (`npm run build:debug`) keep them; for on-disk debugging Team A's
  // RIFFSHEET_WEBCORE_DIR serves a dev build straight off disk anyway.
  const wantSourcemap = process.env.RIFFSHEET_SOURCEMAP === '1';

  return {
    base: './',
    plugins: [alphaTab({ assetOutputDir: false }), classicScripts(), packageThirdPartyAssets()],
    resolve: {
      alias: {
        '@pipeline-impl': teamCPipeline,
        '@pipeline': resolve(__dirname, 'src/pipeline/index.ts')
      }
    },
    // Module workers are explicitly fine over juce://; only the document is restricted.
    worker: { format: 'es' as const },
    build: {
      target: 'es2020',
      outDir: 'dist',
      emptyOutDir: true,
      modulePreload: false,
      sourcemap: wantSourcemap,
      assetsInlineLimit: 4096,
      chunkSizeWarningLimit: 3000,
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
        output: {
          format: 'iife' as const,
          inlineDynamicImports: true,
          entryFileNames: 'assets/main.js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name][extname]'
        }
      }
    },
    server: { port: 5273, strictPort: false },
    preview: { port: 5274, strictPort: false }
  };
});
