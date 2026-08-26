/* ==========================================================================
   Redmine Lists
   Shows the weekly release-team test cycle spreadsheets, rendered as a table.

   Unlike QA Insights, dates here are arbitrary (not locked to Fridays) and the
   files are .xlsx, so this page is manifest-driven: it reads the index written
   by tools/build-redmine-index.sh rather than guessing file names.
   ========================================================================== */

(function () {
    'use strict';

    const CONFIG = {
        // Folder holding the spreadsheets. Keep the trailing slash.
        // A space in the folder name works, but a hyphenated name is safer in URLs.
        dir:        'Redmine Lists/',
        indexFile:  'Redmine Lists/index.json',
        maxRows:    5000        // guard against a runaway sheet locking up the tab
    };

    /* ---------------- helpers ------------------------------------------------ */

    const pad = n => String(n).padStart(2, '0');
    const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const encodePath = p => p.split('/').map(encodeURIComponent).join('/');

    function fromISO(s) {
        const [y, m, d] = s.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    const longFmt = new Intl.DateTimeFormat(undefined, {
        weekday: 'long', day: 'numeric', month: 'short', year: 'numeric'
    });
    const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

    /* ---------------- state -------------------------------------------------- */

    const el = {
        prev:        document.getElementById('qa-prev'),
        next:        document.getElementById('qa-next'),
        dateBtn:     document.getElementById('qa-date-btn'),
        dateLabel:   document.getElementById('qa-date-label'),
        cal:         document.getElementById('qa-cal'),
        calPrev:     document.getElementById('qa-cal-prev'),
        calNext:     document.getElementById('qa-cal-next'),
        calTitle:    document.getElementById('qa-cal-title'),
        calGrid:     document.getElementById('qa-cal-grid'),
        latest:      document.getElementById('qa-latest'),
        download:    document.getElementById('qa-download'),
        badge:       document.getElementById('qa-badge'),
        loading:     document.getElementById('qa-loading'),
        empty:       document.getElementById('qa-empty'),
        emptyTitle:  document.getElementById('qa-empty-title'),
        emptyMsg:    document.getElementById('qa-empty-msg'),
        emptyLatest: document.getElementById('qa-empty-latest'),
        subbar:      document.getElementById('rm-subbar'),
        sheets:      document.getElementById('rm-sheets'),
        search:      document.getElementById('rm-search'),
        count:       document.getElementById('rm-count'),
        tableWrap:       document.getElementById('rm-groups'),
        doneSection:     document.getElementById('rm-group-done'),
        doneCount:       document.getElementById('rm-done-count'),
        theadDone:       document.getElementById('rm-thead-done'),
        tbodyDone:       document.getElementById('rm-tbody-done'),
        progressSection: document.getElementById('rm-group-progress'),
        progressCount:   document.getElementById('rm-progress-count'),
        theadProgress:   document.getElementById('rm-thead-progress'),
        tbodyProgress:   document.getElementById('rm-tbody-progress')
    };

    let byDate = new Map();      // Map<isoDate, entry[]>
    let dates = [];              // sorted ascending
    let latestDate = null;
    let currentDate = null;
    let currentEntry = null;     // the file being shown
    let workbook = null;
    let activeSheet = null;
    let calMonth = startOfDay(new Date());

    /* ---------------- manifest ----------------------------------------------- */

    async function loadIndex() {
        const res = await fetch(encodePath(CONFIG.indexFile), { cache: 'no-store' });
        if (!res.ok) throw new Error('index ' + res.status);

        const data = await res.json();
        const rows = Array.isArray(data) ? data : (data.files || data.reports || []);
        const map = new Map();

        rows.forEach(row => {
            const entry = typeof row === 'string' ? { file: row } : Object.assign({}, row);
            if (!entry.file) return;

            // Date comes from the manifest, or from the first YYYY-MM-DD in the file name.
            let iso = entry.date;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) {
                const found = entry.file.match(/(\d{4}-\d{2}-\d{2})/);
                if (!found) return;
                iso = found[1];
            }
            entry.date = iso;
            if (!map.has(iso)) map.set(iso, []);
            map.get(iso).push(entry);
        });

        return map;
    }

    function neighbourDate(iso, direction) {
        const idx = dates.indexOf(iso);
        if (idx === -1) return null;
        return dates[idx + direction] || null;
    }

    /* ---------------- view state --------------------------------------------- */

    function showState(which) {
        el.loading.hidden   = which !== 'loading';
        el.empty.hidden     = which !== 'empty';
        el.tableWrap.hidden = which !== 'table';
        el.subbar.hidden    = which !== 'table';
    }

    function updateToolbar(iso) {
        el.dateLabel.textContent = longFmt.format(fromISO(iso));
        el.badge.hidden = iso !== latestDate;
        el.prev.disabled = !neighbourDate(iso, -1);
        el.next.disabled = !neighbourDate(iso, +1);
        el.latest.disabled = iso === latestDate;
    }

    /* ---------------- spreadsheet rendering ----------------------------------- */

    function renderSheetTabs() {
        el.sheets.innerHTML = '';
        const names = workbook.SheetNames;
        const files = byDate.get(currentDate) || [];

        // If a date has more than one spreadsheet, let the user switch between them.
        if (files.length > 1) {
            files.forEach(entry => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'rm-chip' + (entry === currentEntry ? ' is-active' : '');
                btn.textContent = entry.label || entry.file.replace(/\.[^.]+$/, '');
                btn.title = entry.file;
                btn.addEventListener('click', () => openEntry(entry));
                el.sheets.appendChild(btn);
            });
            const sep = document.createElement('span');
            sep.className = 'rm-sep';
            el.sheets.appendChild(sep);
        }

        if (names.length < 2) return;   // single sheet: no tabs worth showing

        names.forEach(name => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.role = 'tab';
            btn.className = 'rm-chip' + (name === activeSheet ? ' is-active' : '');
            btn.setAttribute('aria-selected', String(name === activeSheet));
            btn.textContent = name;
            btn.addEventListener('click', () => {
                activeSheet = name;
                renderSheetTabs();
                renderTable();
            });
            el.sheets.appendChild(btn);
        });
    }

    // Environment progression: later stages supersede earlier ones.
    const ENV_ORDER = { STAGE: 1, CERT: 2, PROD: 3 };

    function envRank(value) {
        const cell = String(value == null ? '' : value).toUpperCase();
        let rank = -1;
        Object.keys(ENV_ORDER).forEach(name => {
            if (cell.indexOf(name) !== -1) rank = Math.max(rank, ENV_ORDER[name]);
        });
        return rank;
    }

    // Collapses rows that share a Redmine Id, keeping only the row for the
    // furthest-progressed environment (STAGE < CERT < PROD). Ties keep the
    // later row, since it's the more recently added update.
    function dedupeByRedmineId(header, rows) {
        const idIdx = header.findIndex(h => /redmine/i.test(String(h)));
        const envIdx = header.findIndex(h => /environment/i.test(String(h)));
        if (idIdx === -1) return rows;

        const order = [];
        const indexByKey = new Map();

        rows.forEach(row => {
            const key = String(row[idIdx] == null ? '' : row[idIdx]).trim();
            if (!key) { order.push(row); return; }

            if (!indexByKey.has(key)) {
                indexByKey.set(key, order.length);
                order.push(row);
                return;
            }

            const pos = indexByKey.get(key);
            const newRank = envIdx === -1 ? 0 : envRank(row[envIdx]);
            const oldRank = envIdx === -1 ? 0 : envRank(order[pos][envIdx]);
            if (newRank >= oldRank) order[pos] = row;
        });

        return order;
    }

    // Sorts rows by Redmine Id ascending (numeric). Rows with a non-numeric
    // or missing id are left in place at the end, in their original order.
    function sortByRedmineId(header, rows) {
        const idIdx = header.findIndex(h => /redmine/i.test(String(h)));
        if (idIdx === -1) return rows;

        const numbered = [];
        const rest = [];
        rows.forEach(row => {
            const n = parseInt(row[idIdx], 10);
            if (Number.isNaN(n)) rest.push(row);
            else numbered.push({ n, row });
        });

        numbered.sort((a, b) => a.n - b.n);
        return numbered.map(x => x.row).concat(rest);
    }

    // Splits rows into "Done in PROD" (highest environment reached is PROD)
    // and "In Progress" (everything else). Returns null when the sheet has
    // no Environment column to group by.
    function groupByEnvStatus(header, rows) {
        const envIdx = header.findIndex(h => /environment/i.test(String(h)));
        if (envIdx === -1) return null;

        const done = [];
        const inProgress = [];
        rows.forEach(row => {
            (envRank(row[envIdx]) === ENV_ORDER.PROD ? done : inProgress).push(row);
        });
        return { done, inProgress };
    }

    function renderGroupTable(theadEl, tbodyEl, header, rows) {
        theadEl.innerHTML = '';
        tbodyEl.innerHTML = '';
        if (!header.length) return;

        const htr = document.createElement('tr');
        header.forEach(cell => {
            const th = document.createElement('th');
            th.textContent = String(cell);
            htr.appendChild(th);
        });
        theadEl.appendChild(htr);

        const frag = document.createDocumentFragment();
        rows.forEach(row => {
            const tr = document.createElement('tr');
            for (let i = 0; i < header.length; i++) {
                const td = document.createElement('td');
                td.textContent = row[i] == null ? '' : String(row[i]);
                tr.appendChild(td);
            }
            tr.dataset.text = row.join(' ').toLowerCase();
            frag.appendChild(tr);
        });
        tbodyEl.appendChild(frag);
    }

    function renderTable() {
        const sheet = workbook.Sheets[activeSheet];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });

        if (!rows.length) {
            renderGroupTable(el.theadDone, el.tbodyDone, [], []);
            renderGroupTable(el.theadProgress, el.tbodyProgress, [], []);
            el.count.textContent = 'Empty sheet';
            return;
        }

        const header = rows[0];
        const deduped = sortByRedmineId(header, dedupeByRedmineId(header, rows.slice(1)));
        const body = deduped.slice(0, CONFIG.maxRows);
        const groups = groupByEnvStatus(header, body) || { done: [], inProgress: body };

        renderGroupTable(el.theadDone, el.tbodyDone, header, groups.done);
        renderGroupTable(el.theadProgress, el.tbodyProgress, header, groups.inProgress);
        el.doneCount.textContent = String(groups.done.length);
        el.progressCount.textContent = String(groups.inProgress.length);

        el.search.value = '';
        applyFilter();

        if (deduped.length > CONFIG.maxRows) {
            el.count.textContent = 'Showing first ' + CONFIG.maxRows + ' rows — download for the full sheet';
        }
    }

    function applyFilter() {
        const term = el.search.value.trim().toLowerCase();
        let shown = 0;
        let total = 0;

        function filterSection(section, tbody) {
            const trs = tbody.querySelectorAll('tr');
            let visible = 0;
            trs.forEach(tr => {
                total++;
                const hit = !term || tr.dataset.text.indexOf(term) !== -1;
                tr.hidden = !hit;
                if (hit) { shown++; visible++; }
            });
            section.hidden = trs.length === 0 || (!!term && visible === 0);
        }

        filterSection(el.doneSection, el.tbodyDone);
        filterSection(el.progressSection, el.tbodyProgress);

        el.count.textContent = term
            ? shown + ' of ' + total + ' rows'
            : total + (total === 1 ? ' row' : ' rows');
    }

    async function openEntry(entry) {
        currentEntry = entry;
        const url = encodePath(CONFIG.dir + entry.file);
        el.download.href = url;
        el.download.setAttribute('download', entry.file);

        showState('loading');

        try {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) throw new Error('fetch ' + res.status);

            const buf = await res.arrayBuffer();
            workbook = XLSX.read(buf, { type: 'array' });
            activeSheet = workbook.SheetNames[0];

            renderSheetTabs();
            renderTable();
            showState('table');
        } catch (err) {
            el.emptyTitle.textContent = 'Could not open ' + entry.file;
            el.emptyMsg.textContent =
                'The index lists this file but it could not be read. Check that it is committed ' +
                'to ' + CONFIG.dir + ' and that the name matches the index exactly.';
            el.emptyLatest.hidden = !latestDate;
            showState('empty');
        }
    }

    function showDate(iso) {
        currentDate = iso;
        calMonth = startOfDay(fromISO(iso));
        updateToolbar(iso);
        renderCalendar();

        const url = new URL(window.location.href);
        url.searchParams.set('date', iso);
        history.replaceState(null, '', url);

        const files = byDate.get(iso);
        if (!files || !files.length) {
            el.emptyTitle.textContent = 'No list for ' + longFmt.format(fromISO(iso));
            el.emptyMsg.textContent = latestDate
                ? 'Pick a highlighted date on the calendar, or open the most recent list from ' +
                  longFmt.format(fromISO(latestDate)) + '.'
                : 'Nothing has been published yet.';
            el.emptyLatest.hidden = !latestDate;
            showState('empty');
            return;
        }

        openEntry(files[0]);
    }

    /* ---------------- calendar ------------------------------------------------ */

    function renderCalendar() {
        const year = calMonth.getFullYear();
        const month = calMonth.getMonth();
        el.calTitle.textContent = monthFmt.format(new Date(year, month, 1));
        el.calGrid.innerHTML = '';

        const first = new Date(year, month, 1);
        const daysInMonth = new Date(year, month + 1, 0).getDate();

        for (let i = 0; i < first.getDay(); i++) {
            const blank = document.createElement('span');
            blank.className = 'qa-cal-blank';
            el.calGrid.appendChild(blank);
        }

        for (let day = 1; day <= daysInMonth; day++) {
            const date = new Date(year, month, day);
            const iso = toISO(date);
            const available = byDate.has(iso);

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'qa-cal-day';
            btn.textContent = day;
            btn.disabled = !available;

            if (available) {
                btn.classList.add('is-available');
                const n = byDate.get(iso).length;
                btn.setAttribute('aria-label',
                    longFmt.format(date) + ' — ' + n + (n === 1 ? ' list' : ' lists'));
            }
            if (iso === currentDate) {
                btn.classList.add('is-selected');
                btn.setAttribute('aria-current', 'date');
            }

            btn.addEventListener('click', () => {
                closeCalendar();
                showDate(iso);
            });

            el.calGrid.appendChild(btn);
        }
    }

    function openCalendar() {
        renderCalendar();
        el.cal.hidden = false;
        el.dateBtn.setAttribute('aria-expanded', 'true');
    }

    function closeCalendar() {
        el.cal.hidden = true;
        el.dateBtn.setAttribute('aria-expanded', 'false');
    }

    /* ---------------- wiring --------------------------------------------------- */

    el.dateBtn.addEventListener('click', e => {
        e.stopPropagation();
        el.cal.hidden ? openCalendar() : closeCalendar();
    });

    el.cal.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', closeCalendar);
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeCalendar();
    });

    el.calPrev.addEventListener('click', () => {
        calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1);
        renderCalendar();
    });

    el.calNext.addEventListener('click', () => {
        calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1);
        renderCalendar();
    });

    el.prev.addEventListener('click', () => {
        const d = neighbourDate(currentDate, -1);
        if (d) showDate(d);
    });

    el.next.addEventListener('click', () => {
        const d = neighbourDate(currentDate, +1);
        if (d) showDate(d);
    });

    el.latest.addEventListener('click', () => latestDate && showDate(latestDate));
    el.emptyLatest.addEventListener('click', () => latestDate && showDate(latestDate));
    el.search.addEventListener('input', applyFilter);

    /* ---------------- boot ------------------------------------------------------ */

    (async function init() {
        showState('loading');

        try {
            byDate = await loadIndex();
        } catch (err) {
            el.emptyTitle.textContent = 'No index found';
            el.emptyMsg.textContent =
                'Run tools/build-redmine-index.sh to create ' + CONFIG.indexFile +
                ', then commit it. The page reads that file to know which dates exist.';
            el.emptyLatest.hidden = true;
            showState('empty');
            return;
        }

        dates = [...byDate.keys()].sort();
        latestDate = dates[dates.length - 1] || null;

        if (!latestDate) {
            el.emptyTitle.textContent = 'No lists published yet';
            el.emptyMsg.textContent =
                'Add a spreadsheet to ' + CONFIG.dir + ' with a YYYY-MM-DD date in the file name, ' +
                'then rebuild the index.';
            el.emptyLatest.hidden = true;
            showState('empty');
            return;
        }

        const requested = new URLSearchParams(window.location.search).get('date');
        showDate(/^\d{4}-\d{2}-\d{2}$/.test(requested || '') ? requested : latestDate);
    })();
})();