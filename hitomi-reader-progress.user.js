// ==UserScript==
// @name         Hitomi::Page Progress
// @namespace    http://hitomi.la/
// @version      1.2.0
// @description  Show page progress on hitomi.la reader
// @author       mechchorogi
// @match        https://hitomi.la/reader/*
// @icon         https://www.google.com/s2/favicons?domain=hitomi.la
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    let lastUrl = location.href;

    // Create a new list item to display progress
    const li = document.createElement('li');
    li.id = 'hitomi-page-progress-li';
    const progressDisplay = document.createElement('span');
    progressDisplay.id = 'hitomi-page-progress-text';
    progressDisplay.style.color = 'white';
    progressDisplay.style.padding = '8px';
    progressDisplay.style.alignSelf = 'center';

    const progressContainer = document.createElement('div');
    progressContainer.id = 'hitomi-page-progress-container';
    progressContainer.style.display = 'flex';
    progressContainer.style.flexDirection = 'column';
    progressContainer.style.alignItems = 'flex-start';
    progressContainer.style.minWidth = '120px';

    const progressBar = document.createElement('div');
    progressBar.id = 'hitomi-page-progress-bar';
    progressBar.style.width = '100%';
    progressBar.style.height = '4px';
    progressBar.style.background = '#555';
    progressBar.style.marginTop = '4px';
    progressBar.style.borderRadius = '2px';
    progressBar.style.direction = 'rtl';

    const progressFill = document.createElement('div');
    progressFill.id = 'hitomi-page-progress-fill';
    progressFill.style.height = '100%';
    progressFill.style.background = 'limegreen';
    progressFill.style.width = '0%';
    progressFill.style.borderRadius = '2px';
    progressFill.style.marginLeft = 'auto';

    progressBar.appendChild(progressFill);
    progressContainer.appendChild(progressDisplay);
    progressContainer.appendChild(progressBar);

    li.appendChild(progressContainer);

    // Wait for ul.nav to be available
    function waitForNav() {
        const nav = document.querySelector('ul.nav');
        if (!nav || !document.querySelector('#single-page-select')?.options.length) {
            setTimeout(waitForNav, 100);
            return;
        }
        nav.appendChild(li);
        updateProgress();
        observePageChange();
    }

    // Get current page and total pages, then display
    function updateProgress() {
        const select = document.querySelector('#single-page-select');
        if (!select || select.options.length === 0) return;

        const total = select.options.length;
        const current = select.selectedIndex + 1; // human-friendly (1-based)
        progressDisplay.textContent = `${current} / ${total}`;
        progressFill.style.width = `${(current / total) * 100}%`;
    }

    // Observe page change events
    function observePageChange() {
        // Observe URL changes
        const urlObserver = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                setTimeout(updateProgress, 50);
            }
        });
        urlObserver.observe(document.body, { childList: true, subtree: true });
    }

    waitForNav();
})();
