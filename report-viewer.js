/* ==========================================================================
   Report viewer
   Shared by every report page (AI Insights, QA Health Report, Performance
   Test, ...). Loads the latest published report for one category and lets the
   user pick any other published date from a calendar.

   Each page declares its category on <body>, so a new category needs only a
   new folder under reports/ and a copy of one of these pages — no JS changes:

       <body data-report-dir="reports/ai-insights/"
             data-report-prefix="weekly_qa_insights_"    (optional)
             data-report-cadence="weekly"                (optional)
             data-report-date-prefix="Week ending ">     (optional)

   The manifest for a category is written by tools/build-report-index.sh:
       reports/<category>/index.json
   ========================================================================== */

(function () {
    'use strict';

    const opts = document.body.dataset;

    const CONFIG = {
        // Folder holding this category's reports, with a trailing slash.
        reportsPath: (opts.reportDir || 'reports/').replace(/\/*$/, '/'),
        // File name prefix. Only used to guess names when there is no manifest.
        filePrefix:  opts.reportPrefix || '',
        fileExt:     opts.reportExt || '.html',
        // 'weekly' means reports land every Friday, which lets the page fall
        // back to probing for file names when the manifest is missing.
        weekly:      (opts.reportCadence || '') === 'weekly',
        // Prefix for the toolbar date, e.g. 'Week ending 5 Sep 2026'.
        datePrefix:  opts.reportDatePrefix || '',
        lookbackWeeks: 52
    };

    CONFIG.indexFile = opts.reportIndex || CONFIG.reportsPath + 'index.json';

    // Probing only makes sense when the file name is predictable.
    const canProbe = CONFIG.weekly && !!CONFIG.filePrefix;

    /* ---------------- date helpers (all local time, no UTC drift) ------------ */

    const pad = n => String(n).padStart(2, '0');
    const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const encodePath = p => p.split('/').map(encodeURIComponent).join('/');

    function fromISO(s) {
        const [y, m, d] = s.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    function startOfDay(d) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    // Most recent Friday on or before the given date.
    function lastFriday(from) {
        const d = startOfDay(from || new Date());
        d.setDate(d.getDate() - ((d.getDay() - 5 + 7) % 7));
        return d;
    }

    function addDays(d, n) {
        const c = new Date(d);
        c.setDate(c.getDate() + n);
        return c;
    }

    const longFmt = new Intl.DateTimeFormat(undefined, {
        weekday: 'long', day: 'numeric', month: 'short', year: 'numeric'
    });
    const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

    /* ---------------- state ------------------------------------------------- */

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
        open:        document.getElementById('qa-open'),
        badge:       document.getElementById('qa-badge'),
        frame:       document.getElementById('qa-frame'),
        loading:     document.getElementById('qa-loading'),
        empty:       document.getElementById('qa-empty'),
        emptyTitle:  document.getElementById('qa-empty-title'),
        emptyMsg:    document.getElementById('qa-empty-msg'),
        emptyLatest: document.getElementById('qa-empty-latest')
    };

    let manifest = null;                 // Map<isoDate, {date, file, title}> or null when unavailable
    let latestDate = null;               // ISO string of newest published report
    let currentDate = null;              // ISO string currently shown
    let calMonth = startOfDay(new Date()); // first-of-month anchor for the calendar

    /* ---------------- lookups ----------------------------------------------- */

    function fileFor(iso) {
        const entry = manifest && manifest.get(iso);
        const name = entry && entry.file
            ? entry.file
            : CONFIG.filePrefix + iso + CONFIG.fileExt;
        return encodePath(CONFIG.reportsPath + name);
    }

    async function urlExists(url) {
        try {
            const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
            if (head.ok) return true;
            if (head.status !== 405 && head.status !== 501) return false;
        } catch (e) { /* fall through to GET */ }

        try {
            const get = await fetch(url, { method: 'GET', cache: 'no-store' });
            return get.ok;
        } catch (e) {
            return false;
        }
    }

    async function loadManifest() {
        try {
            const res = await fetch(CONFIG.indexFile, { cache: 'no-store' });
            if (!res.ok) return null;

            const data = await res.json();
            const rows = Array.isArray(data) ? data : (data.reports || []);
            if (!rows.length) return null;

            const map = new Map();
            rows.forEach(row => {
                const iso = typeof row === 'string' ? row : row.date;
                if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return;
                map.set(iso, typeof row === 'string' ? { date: iso } : row);
            });
            return map.size ? map : null;
        } catch (e) {
            return null;   // no manifest in the repo yet — probing takes over
        }
    }

    // Newest published date, using the manifest when present, probing otherwise.
    async function findLatest() {
        if (manifest) {
            const today = toISO(new Date());
            const dates = [...manifest.keys()].filter(d => d <= today).sort();
            if (dates.length) return dates[dates.length - 1];
        }
        if (!canProbe) return null;

        let d = lastFriday(new Date());
        for (let i = 0; i < CONFIG.lookbackWeeks; i++) {
            const iso = toISO(d);
            if (await urlExists(fileFor(iso))) return iso;
            d = addDays(d, -7);
        }
        return null;
    }

    function isAvailable(iso) {
        if (manifest) return manifest.has(iso);
        if (!canProbe) return false;
        return fromISO(iso).getDay() === 5 && (!latestDate || iso <= latestDate);
    }

    function neighbourDate(iso, direction) {
        if (manifest) {
            const dates = [...manifest.keys()].sort();
            const idx = dates.indexOf(iso);
            if (idx === -1) return null;
            return dates[idx + direction] || null;
        }
        if (!canProbe) return null;

        const next = toISO(addDays(fromISO(iso), direction * 7));
        if (direction > 0 && latestDate && next > latestDate) return null;
        return next;
    }

    /* ---------------- rendering --------------------------------------------- */

    function showState(which) {
        el.loading.hidden = which !== 'loading';
        el.empty.hidden   = which !== 'empty';
        el.frame.hidden   = which !== 'report';
    }

    function fitFrame() {
        try {
            const body = el.frame.contentDocument && el.frame.contentDocument.body;
            if (!body) return;
            const h = Math.max(body.scrollHeight, body.offsetHeight, 460);
            el.frame.style.height = (h + 24) + 'px';
        } catch (e) {
            el.frame.style.height = '80vh';   // cross-origin or blocked — use a sane default
        }
    }

    function updateToolbar(iso) {
        el.dateLabel.textContent = CONFIG.datePrefix + longFmt.format(fromISO(iso));
        el.open.href = fileFor(iso);
        el.badge.hidden = iso !== latestDate;
        el.prev.disabled = !neighbourDate(iso, -1);
        el.next.disabled = !neighbourDate(iso, +1);
        el.latest.disabled = iso === latestDate;
    }

    async function showReport(iso, flags) {
        currentDate = iso;
        calMonth = startOfDay(fromISO(iso));
        updateToolbar(iso);
        renderCalendar();

        const url = new URL(window.location.href);
        url.searchParams.set('date', iso);
        history.replaceState(null, '', url);

        showState('loading');

        const src = fileFor(iso);
        const ok = (flags && flags.skipCheck) || await urlExists(src);

        if (!ok) {
            el.emptyTitle.textContent = 'No report for ' + longFmt.format(fromISO(iso));
            el.emptyMsg.textContent = latestDate
                ? (CONFIG.weekly ? 'Reports are published every Friday. ' : '') +
                  'Pick another date from the calendar, or open the latest one from ' +
                  longFmt.format(fromISO(latestDate)) + '.'
                : 'Nothing has been published to the ' + CONFIG.reportsPath + ' folder yet.';
            el.emptyLatest.hidden = !latestDate;
            showState('empty');
            return;
        }

        el.frame.style.height = '';
        el.frame.src = src;
        showState('report');
    }

    /* ---------------- calendar ----------------------------------------------- */

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
            const available = isAvailable(iso);

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'qa-cal-day';
            btn.textContent = day;
            btn.disabled = !available;

            if (available) {
                btn.classList.add('is-available');
                btn.setAttribute('aria-label', 'Report for ' + longFmt.format(date));
            }
            if (iso === currentDate) {
                btn.classList.add('is-selected');
                btn.setAttribute('aria-current', 'date');
            }

            btn.addEventListener('click', () => {
                closeCalendar();
                showReport(iso);
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

    /* ---------------- wiring -------------------------------------------------- */

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
        if (d) showReport(d);
    });

    el.next.addEventListener('click', () => {
        const d = neighbourDate(currentDate, +1);
        if (d) showReport(d);
    });

    el.latest.addEventListener('click', () => latestDate && showReport(latestDate));
    el.emptyLatest.addEventListener('click', () => latestDate && showReport(latestDate));
    el.frame.addEventListener('load', fitFrame);
    window.addEventListener('resize', fitFrame);

    /* ---------------- boot ---------------------------------------------------- */

    (async function init() {
        showState('loading');
        manifest = await loadManifest();
        latestDate = await findLatest();

        const requested = new URLSearchParams(window.location.search).get('date');
        const start = /^\d{4}-\d{2}-\d{2}$/.test(requested || '') ? requested : latestDate;

        if (!start) {
            currentDate = toISO(CONFIG.weekly ? lastFriday(new Date()) : new Date());
            updateToolbar(currentDate);
            el.emptyTitle.textContent = 'No reports published yet';
            el.emptyMsg.textContent =
                'Add a report named ' +
                (CONFIG.filePrefix || '<name>_') + 'YYYY-MM-DD' + CONFIG.fileExt +
                ' to the ' + CONFIG.reportsPath + ' folder and it will show up here.';
            el.emptyLatest.hidden = true;
            showState('empty');
            return;
        }

        showReport(start, { skipCheck: start === latestDate && !!manifest });
    })();
})();
