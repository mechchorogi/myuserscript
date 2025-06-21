// ==UserScript==
// @name         Hitomi::Page Progress
// @namespace    http://hitomi.la/
// @version      1.0.1
// @description  Show page progress on hitomi.la reader
// @author       mechchorogi
// @match        https://hitomi.la/reader/*
// @icon         https://www.google.com/s2/favicons?domain=hitomi.la
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

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

    const progressFill = document.createElement('div');
    progressFill.id = 'hitomi-page-progress-fill';
    progressFill.style.height = '100%';
    progressFill.style.background = 'limegreen';
    progressFill.style.width = '0%';
    progressFill.style.borderRadius = '2px';

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
        const select = document.querySelector('#single-page-select');
        if (!select) return;

        // Add event listener for change events
        select.addEventListener('change', updateProgress);

        // Also listen to keyboard events (j/k and arrow keys)
        document.addEventListener('keydown', (event) => {
            if (['j', 'k', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
                // Let the navigation occur, then update after a short delay
                setTimeout(updateProgress, 50);
            }
        });

        // Observe changes to the selected attribute of option elements
        const observer = new MutationObserver(updateProgress);
        select.querySelectorAll('option').forEach(option => {
            observer.observe(option, { attributes: true, attributeFilter: ['selected'] });
        });
    }

    waitForNav();
})();
