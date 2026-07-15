// Generates .playwright/init.generated.js: the GM shim plus both userscripts, each
// deferred until DOMContentLoaded to approximate their real `@run-at document-idle`.
// playwright-cli's initScript files run at document-start (before the page's own
// scripts), so the userscripts' top-level `document.querySelector(...)` calls would
// otherwise run before the DOM exists.
//
// Run with: node .playwright/build-init-script.mjs
// No npm dependencies — uses only Node's built-in fs/path/url modules.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const gmShimSource = readFileSync(path.join(here, 'gm-shim.js'), 'utf8');

const userscripts = ['hitomi-tweak.user.js'];

function deferUntilDomReady(source, label) {
    return `
(function() {
    function run() {
        console.log('[init-script] running ${label}');
        ${source}
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        run();
    } else {
        document.addEventListener('DOMContentLoaded', run, { once: true });
    }
})();
`;
}

const parts = [gmShimSource];
for (const name of userscripts) {
    const source = readFileSync(path.join(repoRoot, name), 'utf8');
    parts.push(deferUntilDomReady(source, name));
}

const outputPath = path.join(here, 'init.generated.js');
writeFileSync(outputPath, parts.join('\n'));
console.log(`Wrote ${outputPath}`);
