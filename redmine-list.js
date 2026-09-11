/* ==========================================================================
   Redmine Lists
   Shows the weekly release-team test cycle spreadsheets, rendered as a table.

   Unlike QA Insights, dates here are arbitrary (not locked to Fridays) and the
   files are .xlsx, so this page is manifest-driven: it reads the index written
   by tools/build-redmine-index.sh rather than guessing file names.

   The sheet is not dumped verbatim. Columns are matched to known roles by their
   header text and each role gets a purpose-built cell (status pill, environment
   pipeline, assignee chip, test window). Anything unrecognised still renders as
   plain text, so a change to the sheet shape degrades rather than breaks.
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
    const text = v => String(v == null ? '' : v).trim();

    function fromISO(s) {
        const [y, m, d] = s.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    const longFmt = new Intl.DateTimeFormat(undefined, {
        weekday: 'long', day: 'numeric', month: 'short', year: 'numeric'
    });
    const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
    const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

    // Sheet dates arrive as strings (raw:false). Show a short day/month when we
    // can parse one, otherwise hand back whatever the cell said.
    function shortDate(value) {
        const s = text(value);
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return dayFmt.format(new Date(+m[1], +m[2] - 1, +m[3]));
        const t = Date.parse(s);
        return Number.isNaN(t) ? s : dayFmt.format(new Date(t));
    }

    function dateKey(value) {
        const s = text(value);
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
        const t = Date.parse(s);
        return Number.isNaN(t) ? null : t;
    }

    function initials(name) {
        const parts = text(name).split(/\s+/).filter(Boolean);
        if (!parts.length) return '?';
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

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
        stats:       document.getElementById('rm-stats'),
        statTotal:   document.getElementById('rm-stat-total'),
        statDone:    document.getElementById('rm-stat-done'),
        statProgress: document.getElementById('rm-stat-progress'),
        statPeople:  document.getElementById('rm-stat-people'),
        cardDone:    document.getElementById('rm-stat-card-done'),
        cardProgress: document.getElementById('rm-stat-card-progress'),
        controls:    document.getElementById('rm-controls'),
        sheets:      document.getElementById('rm-sheets'),
        seg:         document.getElementById('rm-seg'),
        segBtns:     Array.prototype.slice.call(document.querySelectorAll('.rm-seg-btn')),
        segAllN:     document.getElementById('rm-seg-all-n'),
        segDoneN:    document.getElementById('rm-seg-done-n'),
        segProgressN: document.getElementById('rm-seg-progress-n'),
        search:      document.getElementById('rm-search'),
        count:       document.getElementById('rm-count'),
        card:        document.getElementById('rm-card'),
        thead:       document.getElementById('rm-thead'),
        tbody:       document.getElementById('rm-tbody'),
        noHits:      document.getElementById('rm-nohits'),
        foot:        document.getElementById('rm-foot')
    };

    let byDate = new Map();      // Map<isoDate, entry[]>
    let dates = [];              // sorted ascending
    let latestDate = null;
    let currentDate = null;
    let currentEntry = null;     // the file being shown
    let workbook = null;
    let activeSheet = null;
    let calMonth = startOfDay(new Date());

    // The rendered sheet: rows are enriched objects, not bare arrays.
    let view = null;             // { columns, items, hasStatus, truncated }
    let statusFilter = 'all';
    let sortCol = -1;            // index into view.columns
    let sortDir = 1;
    let searchTimer = 0;

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
        el.card.hidden      = which !== 'table';
        el.controls.hidden  = which !== 'table';
        el.stats.hidden     = which !== 'table';
    }

    function updateToolbar(iso) {
        el.dateLabel.textContent = longFmt.format(fromISO(iso));
        el.badge.hidden = iso !== latestDate;
        el.prev.disabled = !neighbourDate(iso, -1);
        el.next.disabled = !neighbourDate(iso, +1);
        el.latest.disabled = iso === latestDate;
    }

    /* ---------------- source / worksheet chips -------------------------------- */

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
            if (names.length > 1) {
                const sep = document.createElement('span');
                sep.className = 'rm-sep';
                el.sheets.appendChild(sep);
            }
        }

        if (names.length < 2) return;   // single sheet: no tabs worth showing

        names.forEach(name => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'rm-chip' + (name === activeSheet ? ' is-active' : '');
            btn.setAttribute('aria-pressed', String(name === activeSheet));
            btn.textContent = name;
            btn.addEventListener('click', () => {
                activeSheet = name;
                buildView();
                renderSheetTabs();
                renderTable();
            });
            el.sheets.appendChild(btn);
        });
    }

    /* ---------------- sheet shaping ------------------------------------------- */

    // Environment progression: later stages supersede earlier ones.
    const ENV_STEPS = ['STAGE', 'CERT', 'PROD'];
    const ENV_ORDER = { STAGE: 1, CERT: 2, PROD: 3 };

    function envRank(value) {
        const cell = text(value).toUpperCase();
        let rank = -1;
        ENV_STEPS.forEach(name => {
            if (cell.indexOf(name) !== -1) rank = Math.max(rank, ENV_ORDER[name]);
        });
        return rank;
    }

    // Which of the three pipeline stages this cell actually names, plus any
    // other environment it mentions (DEV and friends) so nothing is dropped.
    function envParts(value) {
        const cell = text(value).toUpperCase();
        const on = ENV_STEPS.filter(step => cell.indexOf(step) !== -1);
        const extra = cell.split(/[,/;|]+/)
            .map(t => t.trim())
            .filter(t => t && ENV_STEPS.indexOf(t) === -1);
        return { on, extra };
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
            const key = text(row[idIdx]);
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

    // Matches sheet columns to the roles this page knows how to draw.
    function detectRoles(header) {
        const find = re => header.findIndex(h => re.test(String(h)));
        return {
            id:      find(/redmine/i),
            tracker: find(/tracker/i),
            title:   find(/title|subject|summary/i),
            type:    find(/^\s*type\s*$/i),
            env:     find(/environment/i),
            qa:      find(/assign|engineer/i),
            start:   find(/start/i),
            end:     find(/end/i)
        };
    }

    function trackerTone(value) {
        return /bug/i.test(text(value)) ? 'bug' : 'neutral';
    }

    /* ---------------- cell painters ------------------------------------------- */

    function paintMuted(td, label) {
        const span = document.createElement('span');
        span.className = 'rm-muted';
        span.textContent = label;
        td.appendChild(span);
    }

    function paintBadge(td, label, tone, icon) {
        const span = document.createElement('span');
        span.className = 'rm-badge';
        span.dataset.tone = tone;
        if (icon) {
            const i = document.createElement('i');
            i.className = icon;
            i.setAttribute('aria-hidden', 'true');
            span.appendChild(i);
        }
        span.appendChild(document.createTextNode(label));
        td.appendChild(span);
    }

    function paintStatus(td, item) {
        if (item.done) paintBadge(td, 'Done in PROD', 'done', 'fas fa-circle-check');
        else paintBadge(td, 'In progress', 'progress', 'fas fa-circle-half-stroke');
    }

    function paintPipeline(td, raw) {
        const value = text(raw);
        if (!value) { paintMuted(td, 'Not recorded'); return; }

        const parts = envParts(value);
        const wrap = document.createElement('span');
        wrap.className = 'rm-pipe';
        wrap.title = value;

        ENV_STEPS.forEach(step => {
            const chip = document.createElement('span');
            chip.className = 'rm-pipe-step' + (parts.on.indexOf(step) !== -1 ? ' is-on' : '');
            chip.textContent = step;
            wrap.appendChild(chip);
        });

        if (parts.extra.length) {
            const extra = document.createElement('span');
            extra.className = 'rm-pipe-extra';
            extra.textContent = '+' + parts.extra.join(', ');
            wrap.appendChild(extra);
        }

        // Spelled out for screen readers, which would otherwise hear bare labels.
        const sr = parts.on.length ? parts.on.join(', ') : 'no pipeline stage recorded';
        wrap.setAttribute('aria-label', 'Tested in ' + sr);
        td.appendChild(wrap);
    }

    function paintWho(td, raw) {
        const name = text(raw);
        if (!name) { paintMuted(td, 'Unassigned'); return; }

        const wrap = document.createElement('span');
        wrap.className = 'rm-who';

        const avatar = document.createElement('span');
        avatar.className = 'rm-avatar';
        avatar.setAttribute('aria-hidden', 'true');
        avatar.textContent = initials(name);

        wrap.appendChild(avatar);
        wrap.appendChild(document.createTextNode(name));
        td.appendChild(wrap);
    }

    function paintWindow(td, startRaw, endRaw) {
        const start = text(startRaw);
        const end = text(endRaw);
        if (!start && !end) { paintMuted(td, '—'); return; }

        const wrap = document.createElement('span');
        wrap.className = 'rm-window';

        if (start) wrap.appendChild(document.createTextNode(shortDate(start)));
        else paintMuted(wrap, '—');

        const arrow = document.createElement('i');
        arrow.className = 'fas fa-arrow-right';
        arrow.setAttribute('aria-hidden', 'true');
        wrap.appendChild(arrow);

        if (end) {
            wrap.appendChild(document.createTextNode(shortDate(end)));
        } else {
            const open = document.createElement('span');
            open.className = 'rm-muted';
            open.textContent = 'open';
            wrap.appendChild(open);
        }

        td.appendChild(wrap);
    }

    /* ---------------- column model -------------------------------------------- */

    // Each column knows its label, how to draw a cell, and what to sort on.
    // `key` is a plain comparable (number, string or null) — null sorts last in
    // both directions, which is friendlier than flipping blanks to the top.
    function buildColumns(header, roles, hasStatus) {
        const columns = [];
        const used = new Set();
        const take = idx => { if (idx !== -1) used.add(idx); };

        if (hasStatus) {
            columns.push({
                label: 'Status',
                cls: 'rm-c-status',
                key: item => (item.done ? 1 : 0),
                paint: (td, item) => paintStatus(td, item)
            });
        }

        if (roles.id !== -1) {
            take(roles.id);
            columns.push({
                label: header[roles.id],
                cls: 'rm-c-id',
                key: item => {
                    const n = parseInt(item.cells[roles.id], 10);
                    return Number.isNaN(n) ? null : n;
                },
                paint: (td, item) => {
                    const value = text(item.cells[roles.id]);
                    if (!value) { paintMuted(td, '—'); return; }
                    const span = document.createElement('span');
                    span.className = 'rm-id';
                    span.textContent = '#' + value;
                    td.appendChild(span);
                }
            });
        }

        if (roles.tracker !== -1) {
            take(roles.tracker);
            columns.push({
                label: header[roles.tracker],
                cls: 'rm-c-tracker',
                key: item => text(item.cells[roles.tracker]).toLowerCase() || null,
                paint: (td, item) => {
                    const value = text(item.cells[roles.tracker]);
                    if (!value) { paintMuted(td, '—'); return; }
                    paintBadge(td, value, trackerTone(value), null);
                }
            });
        }

        if (roles.title !== -1) {
            take(roles.title);
            columns.push({
                label: header[roles.title],
                cls: 'rm-c-title',
                key: item => text(item.cells[roles.title]).toLowerCase() || null,
                paint: (td, item) => {
                    const value = text(item.cells[roles.title]);
                    if (!value) { paintMuted(td, '—'); return; }
                    td.textContent = value;
                    td.title = value;
                }
            });
        }

        if (roles.type !== -1) {
            take(roles.type);
            columns.push({
                label: header[roles.type],
                cls: 'rm-c-type',
                key: item => text(item.cells[roles.type]).toLowerCase() || null,
                paint: (td, item) => {
                    const value = text(item.cells[roles.type]);
                    if (!value) { paintMuted(td, '—'); return; }
                    const span = document.createElement('span');
                    span.className = 'rm-soft';
                    span.textContent = value;
                    td.appendChild(span);
                }
            });
        }

        if (roles.env !== -1) {
            take(roles.env);
            columns.push({
                label: header[roles.env],
                cls: 'rm-c-env',
                key: item => {
                    const rank = envRank(item.cells[roles.env]);
                    return rank === -1 ? null : rank;
                },
                paint: (td, item) => paintPipeline(td, item.cells[roles.env])
            });
        }

        if (roles.qa !== -1) {
            take(roles.qa);
            columns.push({
                label: header[roles.qa],
                cls: 'rm-c-qa',
                key: item => text(item.cells[roles.qa]).toLowerCase() || null,
                paint: (td, item) => paintWho(td, item.cells[roles.qa])
            });
        }

        // Start and end read as one span when both are present.
        if (roles.start !== -1 && roles.end !== -1) {
            take(roles.start);
            take(roles.end);
            columns.push({
                label: 'Test window',
                cls: 'rm-c-window',
                key: item => dateKey(item.cells[roles.start]),
                paint: (td, item) => paintWindow(td, item.cells[roles.start], item.cells[roles.end])
            });
        }

        // Anything the page has no opinion about still gets a plain column.
        header.forEach((label, idx) => {
            if (used.has(idx)) return;
            columns.push({
                label: label,
                cls: 'rm-c-other',
                key: item => text(item.cells[idx]).toLowerCase() || null,
                paint: (td, item) => {
                    const value = text(item.cells[idx]);
                    if (!value) { paintMuted(td, '—'); return; }
                    td.textContent = value;
                }
            });
        });

        return columns;
    }

    function buildView() {
        const sheet = workbook.Sheets[activeSheet];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });

        if (!rows.length) {
            view = { columns: [], items: [], hasStatus: false, truncated: false };
            return;
        }

        const header = rows[0].map(h => text(h));
        const roles = detectRoles(header);
        const deduped = dedupeByRedmineId(header, rows.slice(1));
        const body = deduped.slice(0, CONFIG.maxRows);
        const hasStatus = roles.env !== -1;

        const items = body.map(cells => ({
            cells: cells,
            done: hasStatus && envRank(cells[roles.env]) === ENV_ORDER.PROD,
            haystack: cells.join('  ').toLowerCase()
        }));

        view = {
            columns: buildColumns(header, roles, hasStatus),
            items: items,
            roles: roles,
            hasStatus: hasStatus,
            truncated: deduped.length > CONFIG.maxRows
        };

        // Default sort mirrors the old grouped view: Redmine Id ascending.
        const idCol = view.columns.findIndex(c => c.cls === 'rm-c-id');
        sortCol = idCol;
        sortDir = 1;
        statusFilter = 'all';
        el.search.value = '';
    }

    /* ---------------- stats + controls ---------------------------------------- */

    function renderStats() {
        const items = view.items;
        const done = items.filter(i => i.done).length;
        const qaIdx = view.roles ? view.roles.qa : -1;

        const people = new Set();
        if (qaIdx !== -1) {
            items.forEach(i => {
                const name = text(i.cells[qaIdx]);
                if (name) people.add(name.toLowerCase());
            });
        }

        el.statTotal.textContent = String(items.length);
        el.statDone.textContent = String(done);
        el.statProgress.textContent = String(items.length - done);
        el.statPeople.textContent = qaIdx === -1 ? '—' : String(people.size);

        // Only claim a status split when the sheet actually records environments.
        el.cardDone.hidden = !view.hasStatus;
        el.cardProgress.hidden = !view.hasStatus;

        el.seg.hidden = !view.hasStatus;
        el.segAllN.textContent = String(items.length);
        el.segDoneN.textContent = String(done);
        el.segProgressN.textContent = String(items.length - done);

        el.segBtns.forEach(btn => {
            btn.setAttribute('aria-pressed', String(btn.dataset.status === statusFilter));
        });
    }

    /* ---------------- table rendering ----------------------------------------- */

    function renderHead() {
        el.thead.innerHTML = '';
        if (!view.columns.length) return;

        const tr = document.createElement('tr');
        view.columns.forEach((col, idx) => {
            const th = document.createElement('th');
            th.className = col.cls;
            th.scope = 'col';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'rm-sort';
            btn.appendChild(document.createTextNode(col.label || '—'));

            const icon = document.createElement('i');
            if (idx === sortCol) {
                th.setAttribute('aria-sort', sortDir === 1 ? 'ascending' : 'descending');
                icon.className = sortDir === 1 ? 'fas fa-sort-up' : 'fas fa-sort-down';
            } else {
                icon.className = 'fas fa-sort';
            }
            icon.setAttribute('aria-hidden', 'true');
            btn.appendChild(icon);

            btn.addEventListener('click', () => {
                if (idx === sortCol) sortDir = -sortDir;
                else { sortCol = idx; sortDir = 1; }
                renderTable();
            });

            th.appendChild(btn);
            tr.appendChild(th);
        });
        el.thead.appendChild(tr);
    }

    function sortItems(items) {
        const col = view.columns[sortCol];
        if (!col) return items;

        return items.slice().sort((a, b) => {
            const ka = col.key(a);
            const kb = col.key(b);
            const ea = ka === null || ka === '';
            const eb = kb === null || kb === '';
            if (ea && eb) return 0;
            if (ea) return 1;      // blanks last, whichever way the column points
            if (eb) return -1;

            let cmp;
            if (typeof ka === 'number' && typeof kb === 'number') cmp = ka - kb;
            else cmp = String(ka).localeCompare(String(kb));
            return cmp * sortDir;
        });
    }

    function renderTable() {
        renderHead();
        el.tbody.innerHTML = '';

        if (!view.columns.length) {
            el.count.textContent = 'Empty sheet';
            el.noHits.hidden = false;
            el.foot.hidden = true;
            return;
        }

        const term = el.search.value.trim().toLowerCase();
        const inStatus = view.items.filter(item => {
            if (statusFilter === 'done') return item.done;
            if (statusFilter === 'progress') return !item.done;
            return true;
        });
        const matched = term
            ? inStatus.filter(item => item.haystack.indexOf(term) !== -1)
            : inStatus;

        const frag = document.createDocumentFragment();
        sortItems(matched).forEach(item => {
            const tr = document.createElement('tr');
            view.columns.forEach(col => {
                const td = document.createElement('td');
                td.className = col.cls;
                col.paint(td, item);
                tr.appendChild(td);
            });
            frag.appendChild(tr);
        });
        el.tbody.appendChild(frag);

        el.noHits.hidden = matched.length > 0;

        const noun = n => n + (n === 1 ? ' ticket' : ' tickets');
        el.count.textContent = term || statusFilter !== 'all'
            ? noun(matched.length) + ' of ' + view.items.length
            : noun(matched.length);

        el.foot.hidden = !view.truncated;
        if (view.truncated) {
            el.foot.textContent = 'Showing the first ' + CONFIG.maxRows +
                ' rows — download the spreadsheet for the full sheet.';
        }
    }

    /* ---------------- loading -------------------------------------------------- */

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

            buildView();
            renderSheetTabs();
            renderStats();
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

    el.segBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            statusFilter = btn.dataset.status;
            el.segBtns.forEach(b => {
                b.setAttribute('aria-pressed', String(b === btn));
            });
            renderTable();
        });
    });

    // Debounced: the whole tbody is rebuilt per keystroke, and a wide sheet
    // makes that measurable.
    el.search.addEventListener('input', () => {
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(renderTable, 120);
    });

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
