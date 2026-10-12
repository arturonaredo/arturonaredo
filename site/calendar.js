/* calendar.js — Tokens used summary
 *
 * Pure, dependency-free, CSP-safe (no inline, no eval, no Function
 * constructor, no remote loads, no analytics). The script fetches the
 * public snapshot at ./assets/profile/snapshot.json, validates a strict
 * subset of the schema (see SCHEMA below), and renders a 12-month,
 * Monday-first calendar.
 *
 * Public selectors maintained for browser tests:
 *   .day[data-date]                     every day button carries its ISO date
 *   .day[data-state=measured|unknown|pending]
 *   .day[data-level="0".."4"]           only on data-state="measured"
 *   #day-tooltip                        floating tooltip
 *   #day-dialog                         native <dialog> modal
 *   #daily-value                        inside dialog, token total or label
 *
 * Conventions in this file:
 *   - Everything is wrapped in an IIFE so nothing leaks to window.
 *   - Listeners use addEventListener exclusively; no inline handlers in HTML.
 *   - textContent is used for all dynamic text; no innerHTML for calendar data.
 *   - The annual total headline is rendered only from the validated
 *     metrics block, never from a recomputed sum of daily values, so a
 *     partial payload cannot drift the headline.
 *   - The script refuses to invent data. If the snapshot is malformed it
 *     surfaces a clear error and skips rendering.
 */
(function () {
  "use strict";

  /* -------------------------------------------------------------------------
     Constants and pure helpers
     ------------------------------------------------------------------------- */

  var DATA_URL = "./assets/profile/snapshot.json";
  var SCHEMA_VERSION = 1;
  var DELAY_DAYS = 7;
  var ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var ISO_MONTH = /^(\d{4})-(\d{2})$/;
  var MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  var WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

   /* The public calendar requires at least 7 qualified days. */
  var MIN_QUALIFIED_DAYS = 7;

  /* Error messages are short, do not include any payload value, and are
     safe to echo to the user. */
  var ERR_FETCH = "Could not load the public data file.";
  var ERR_INVALID = "The public data file does not match the expected schema.";

  /* Build a UTC date from year/month/day. Using UTC matches the schema
     contract ("Source: OpenCode · UTC"). */
  function utcDate(year, month, day) {
    return new Date(Date.UTC(year, month - 1, day));
  }

  function isoOf(date) {
    var y = date.getUTCFullYear();
    var m = String(date.getUTCMonth() + 1);
    var d = String(date.getUTCDate());
    if (m.length < 2) { m = "0" + m; }
    if (d.length < 2) { d = "0" + d; }
    return y + "-" + m + "-" + d;
  }

  function isLeapYear(year) {
    return ((year % 4 === 0) && (year % 100 !== 0)) || (year % 400 === 0);
  }

  function daysInMonth(year, month) {
    if (month === 2) {
      return isLeapYear(year) ? 29 : 28;
    }
    if (month === 4 || month === 6 || month === 9 || month === 11) {
      return 30;
    }
    return 31;
  }

  /* Monday = 0 ... Sunday = 6. JS getUTCDay returns 0 = Sunday, so shift. */
  function mondayIndex(date) {
    var d = date.getUTCDay();
    return (d + 6) % 7;
  }

  /* Token band labels match the schema's published bands. */
  function levelFor(tokens) {
    if (tokens === 0) { return 0; }
    if (tokens < 1000000) { return 1; }
    if (tokens < 10000000) { return 2; }
    if (tokens < 100000000) { return 3; }
    return 4;
  }

  function formatTokens(value) {
    /* Always use comma thousands separators. */
    if (typeof value !== "number" || !isFinite(value)) { return ""; }
    return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function formatCompactTokens(value) {
    /* Compact form used inside the day cell. The cell is small; use
       the shortest reasonable representation. */
    if (typeof value !== "number" || !isFinite(value)) { return ""; }
    if (value < 1000) { return String(Math.round(value)); }
    if (value < 1000000) { return (value / 1000).toFixed(value < 10000 ? 1 : 0) + "k"; }
    if (value < 1000000000) {
      var m = value / 1000000;
      return m.toFixed(m < 10 ? 2 : m < 100 ? 1 : 0) + "M";
    }
    return (value / 1000000000).toFixed(2) + "B";
  }

  /* -------------------------------------------------------------------------
     Validation
     ------------------------------------------------------------------------- */

  /* Returns an Error for the first failure, or null. The script never
     produces detailed reasoning to the page or console; we keep the
     generic ERR_* strings so the user-visible error never echoes any
     payload detail. */
  function validateSnapshot(raw, todayUtcIso) {
    if (raw === null || typeof raw !== "object") {
      return new Error(ERR_INVALID);
    }
    if (raw.schema_version !== SCHEMA_VERSION) {
      return new Error(ERR_INVALID);
    }
    if (raw.mode !== "production") {
      return new Error(ERR_INVALID);
    }
    if (typeof raw.delay_days !== "number" || raw.delay_days !== DELAY_DAYS) {
      return new Error(ERR_INVALID);
    }
    if (typeof raw.aggregate_date !== "string" || !ISO_DATE.test(raw.aggregate_date)) {
      return new Error(ERR_INVALID);
    }
    if (typeof raw.period_start !== "string" || !ISO_DATE.test(raw.period_start)) {
      return new Error(ERR_INVALID);
    }
    if (typeof raw.period_end !== "string" || !ISO_DATE.test(raw.period_end)) {
      return new Error(ERR_INVALID);
    }

    var aggregateParts = raw.aggregate_date.match(ISO_DATE);
    var startParts = raw.period_start.match(ISO_DATE);
    var endParts = raw.period_end.match(ISO_DATE);
    var todayParts = (todayUtcIso || "").match(ISO_DATE);

    var aggregate = utcDate(+aggregateParts[1], +aggregateParts[2], +aggregateParts[3]);
    var periodStart = utcDate(+startParts[1], +startParts[2], +startParts[3]);
    var periodEnd = utcDate(+endParts[1], +endParts[2], +endParts[3]);
    var today = todayParts
      ? utcDate(+todayParts[1], +todayParts[2], +todayParts[3])
      : aggregate;

    if (isoOf(aggregate) !== raw.aggregate_date || isoOf(periodStart) !== raw.period_start
        || isoOf(periodEnd) !== raw.period_end) { return new Error(ERR_INVALID); }

    if (aggregate.getTime() > today.getTime()) { return new Error(ERR_INVALID); }
    if (periodStart.getTime() > periodEnd.getTime()) { return new Error(ERR_INVALID); }
    var cutoff = utcDate(
      aggregate.getUTCFullYear(),
      aggregate.getUTCMonth() + 1,
      aggregate.getUTCDate()
    );
    cutoff.setUTCDate(cutoff.getUTCDate() - DELAY_DAYS);
    /* Align the cutoff to the previous Monday. The published bundle uses
       Monday-cutoff windows; we just make sure the public period_end is
       not in the future relative to the cutoff. */
    while (cutoff.getUTCDay() !== 1) {
      cutoff.setUTCDate(cutoff.getUTCDate() - 1);
    }

    /* Metrics */
    if (!raw.metrics || typeof raw.metrics !== "object") {
      return new Error(ERR_INVALID);
    }
    var tokensYear = raw.metrics.opencode_tokens_year;
    var cacheYear = raw.metrics.opencode_cached_tokens_year;
    var freshYear = raw.metrics.opencode_fresh_input_tokens_year;
    var outputYear = raw.metrics.opencode_output_tokens_year;
    if (!tokensYear || cacheYear === undefined || freshYear === undefined || outputYear === undefined) {
      return new Error(ERR_INVALID);
    }
    if ([tokensYear, cacheYear, freshYear, outputYear].some(function (metric) {
      return !metric || typeof metric !== "object";
    })) { return new Error(ERR_INVALID); }
    if (!isFiniteInt(tokensYear.value) || tokensYear.value < 0) {
      return new Error(ERR_INVALID);
    }
    if (!isFiniteInt(cacheYear.value) || cacheYear.value < 0) {
      return new Error(ERR_INVALID);
    }
    if (!isFiniteInt(freshYear.value) || freshYear.value < 0) {
      return new Error(ERR_INVALID);
    }
    if (!isFiniteInt(outputYear.value) || outputYear.value < 0) {
      return new Error(ERR_INVALID);
    }
    if (tokensYear.window !== "year" || cacheYear.window !== "year"
        || freshYear.window !== "year" || outputYear.window !== "year") {
      return new Error(ERR_INVALID);
    }
    if ([tokensYear, cacheYear, freshYear, outputYear].some(function (metric) {
      return metric.unit !== "tokens" || !["measured", "provider-reported"].includes(metric.quality);
    })) { return new Error(ERR_INVALID); }
    /* The decomposition must be internally consistent. */
    if (cacheYear.value + freshYear.value + outputYear.value !== tokensYear.value) {
      return new Error(ERR_INVALID);
    }

    /* Calendar */
    var calendar = raw.token_calendar;
    if (!calendar || typeof calendar !== "object") {
      return new Error(ERR_INVALID);
    }
    if (calendar.source !== "opencode") { return new Error(ERR_INVALID); }
    if (calendar.provider !== "All providers") { return new Error(ERR_INVALID); }
    if (calendar.window !== "year") { return new Error(ERR_INVALID); }
    var calStartParts = typeof calendar.period_start === "string" && calendar.period_start.match(ISO_DATE);
    var calEndParts = typeof calendar.period_end === "string" && calendar.period_end.match(ISO_DATE);
    if (!calStartParts || !calEndParts) { return new Error(ERR_INVALID); }
    var calStart = utcDate(+calStartParts[1], +calStartParts[2], +calStartParts[3]);
    var calEnd = utcDate(+calEndParts[1], +calEndParts[2], +calEndParts[3]);
    /* The published bundle uses an independent calendar window: the
       period_start/period_end fields at the top level describe the
       trailing 30-day metrics window, while token_calendar.period_start
       describes the year window we render. We only enforce that the
       calendar end does not exceed the Monday-cutoff and is not before
       the year start. */
    if (isoOf(calStart) !== calendar.period_start || isoOf(calEnd) !== calendar.period_end
        || calEnd.getTime() !== cutoff.getTime() || calendar.period_end !== raw.period_end
        || periodEnd.getTime() - periodStart.getTime() !== 30 * 86400000) { return new Error(ERR_INVALID); }

    var aggregateYear = aggregate.getUTCFullYear();
    var jan1 = utcDate(aggregateYear, 1, 1);
    if (calStart.getTime() !== jan1.getTime()) { return new Error(ERR_INVALID); }

    if (!Array.isArray(calendar.days)) { return new Error(ERR_INVALID); }

    /* The published bundle treats ``period_end`` as exclusive: a window
       Jan 1 .. Oct 5 contains 277 daily entries (Jan 1 through Oct 4
       inclusive). Mirror that convention so the calendar matches the
       published bundle exactly. */
    var expectedLen = Math.floor((calEnd.getTime() - calStart.getTime()) / 86400000);
    if (calendar.days.length !== expectedLen) { return new Error(ERR_INVALID); }

    var prev = null;
    var knownSum = 0;
    var qualified = 0;
    var duplicateDetected = false;
    var daySeen = Object.create(null);

    for (var i = 0; i < calendar.days.length; i++) {
      var d = calendar.days[i];
      if (!d || typeof d !== "object") { return new Error(ERR_INVALID); }
      var dateParts = (typeof d.date === "string") ? d.date.match(ISO_DATE) : null;
      if (!dateParts) { return new Error(ERR_INVALID); }
      var date = utcDate(+dateParts[1], +dateParts[2], +dateParts[3]);
      if (isoOf(date) !== d.date || d.date !== isoOf(new Date(calStart.getTime() + i * 86400000))) {
        return new Error(ERR_INVALID);
      }
      if (prev !== null) {
        var diff = Math.floor((date.getTime() - prev.getTime()) / 86400000);
        if (diff !== 1) { return new Error(ERR_INVALID); }
      }
      if (date.getTime() < calStart.getTime() || date.getTime() > calEnd.getTime()) {
        return new Error(ERR_INVALID);
      }
      if (daySeen[d.date]) { duplicateDetected = true; break; }
      daySeen[d.date] = true;
      prev = date;

      var tokens = d.tokens;
      var level = d.level;
      if (tokens === null) {
        if (level !== null) { return new Error(ERR_INVALID); }
      } else if (isFiniteInt(tokens) && tokens >= 0) {
        if (typeof level !== "number" || !isFinite(level) || level < 0 || level > 4 || Math.floor(level) !== level) {
          return new Error(ERR_INVALID);
        }
        var expected = levelFor(tokens);
        if (level !== expected) { return new Error(ERR_INVALID); }
        knownSum += tokens;
        qualified += 1;
      } else {
        return new Error(ERR_INVALID);
      }
    }
    if (duplicateDetected) { return new Error(ERR_INVALID); }
    if (qualified < MIN_QUALIFIED_DAYS) { return new Error(ERR_INVALID); }

    /* Reconciliation: published annual total must accommodate the visible
       days. Withheld days contribute nothing visible to the sum. */
    if (knownSum > tokensYear.value) { return new Error(ERR_INVALID); }
    /* If every in-window day had a value, the sums must match exactly. */
    var allKnown = (qualified === calendar.days.length);
    if (allKnown && knownSum !== tokensYear.value) { return new Error(ERR_INVALID); }

    /* Reject historical payload if nonempty. The deployed site only uses
       the published current-year calendar; the rest of history must stay
       out of the page payload. */
    if (raw.token_calendar_history !== undefined) {
      if (!Array.isArray(raw.token_calendar_history) || raw.token_calendar_history.length !== 0) {
        return new Error(ERR_INVALID);
      }
    }
    if (["coverage", "providers", "models", "weekly_tokens"].some(function (key) {
      return !Array.isArray(raw[key]) || raw[key].length !== 0;
    }) || raw.tracking_since != null) { return new Error(ERR_INVALID); }

    return null;
  }

  function isFiniteInt(n) {
    return Number.isSafeInteger(n);
  }

  /* -------------------------------------------------------------------------
     Rendering
     ------------------------------------------------------------------------- */

  function buildStateMap(snapshot) {
    /* Returns a Map<isoDate, {state: 'measured'|'unknown', level: number|null,
       tokens: number|null}>. Dates after the calendar period_end are not in
       the map; the renderer treats those as "pending". */
    var map = new Map();
    var days = snapshot.token_calendar.days;
    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      if (d.tokens === null) {
        map.set(d.date, { state: "unknown", level: null, tokens: null });
      } else {
        map.set(d.date, { state: "measured", level: d.level, tokens: d.tokens });
      }
    }
    return map;
  }

  function makeYearBlock(year, firstColumn, lastColumn, gridStart, stateMap, periodEndIso) {
    var section = document.createElement("section");
    section.className = "calendar-block";
    section.setAttribute("aria-label", firstColumn === 0 ? "First half of calendar" : "Second half of calendar");
    section.style.setProperty("--columns", String(lastColumn - firstColumn));
    var months = document.createElement("div");
    months.className = "calendar-month-labels";
    months.setAttribute("aria-hidden", "true");
    for (var month = 1; month <= 12; month++) {
      var monthDay = utcDate(year, month, 1);
      var monthColumn = Math.floor((monthDay.getTime() - gridStart.getTime()) / (7 * 86400000));
      if (monthColumn >= firstColumn && monthColumn < lastColumn) {
        var label = document.createElement("span");
        label.textContent = MONTH_NAMES[month - 1].slice(0, 3);
        label.style.gridColumn = String(monthColumn - firstColumn + 1);
        months.appendChild(label);
      }
    }
    section.appendChild(months);
    var weekdays = document.createElement("div");
    weekdays.className = "calendar-row-labels";
    weekdays.setAttribute("aria-hidden", "true");
    for (var w = 0; w < 7; w++) {
      var ws = document.createElement("span");
      ws.textContent = w === 0 ? "M" : w === 2 ? "W" : w === 4 ? "F" : "";
      weekdays.appendChild(ws);
    }
    section.appendChild(weekdays);
    var grid = document.createElement("div");
    grid.className = "calendar-week-grid";
    for (var i = firstColumn * 7; i < lastColumn * 7; i++) {
      var date = new Date(gridStart.getTime() + i * 86400000);
      if (date.getUTCFullYear() !== year) {
        var spacer = document.createElement("span");
        spacer.className = "day-spacer";
        spacer.setAttribute("aria-hidden", "true");
        grid.appendChild(spacer);
        continue;
      }
      var iso = isoOf(date);
      var cellState;
      /* The published calendar uses an exclusive period_end, so any
         day on or after period_end is "Not yet reported" in this view
         (the public bundle has not yet published that day's data). The
         Monday immediately after a recorded Monday is the natural cut. */
      if (iso >= periodEndIso) {
        cellState = { state: "pending", level: null, tokens: null };
      } else if (stateMap.has(iso)) {
        cellState = stateMap.get(iso);
      } else {
        cellState = { state: "unknown", level: null, tokens: null };
      }
      grid.appendChild(makeDayButton(iso, date.getUTCDate(), cellState));
    }

    section.appendChild(grid);
    return section;
  }

  function makeDayButton(iso, dayOfMonth, cellState) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "day";
    btn.dataset.date = iso;
    btn.dataset.state = cellState.state;
    if (cellState.state === "measured") {
      btn.dataset.level = String(cellState.level);
      btn.setAttribute("aria-label",
        formatHumanLabel(iso, cellState.tokens));
    } else if (cellState.state === "unknown") {
      btn.setAttribute("aria-label",
        formatHumanLabel(iso, null));
    } else {
      btn.setAttribute("aria-label",
        iso + ", not yet reported");
    }
    btn.setAttribute("aria-haspopup", "dialog");
    return btn;
  }

  function formatHumanLabel(iso, tokens) {
    var parts = iso.match(ISO_DATE);
    var dt = utcDate(+parts[1], +parts[2], +parts[3]);
    var weekday = WEEKDAY_NAMES[mondayIndex(dt)];
    if (tokens === null) {
      return weekday + " " + iso + ", no qualified data (missing or withheld)";
    }
    return weekday + " " + iso + ", " + formatTokens(tokens) + " tokens";
  }

  /* -------------------------------------------------------------------------
     Tooltip
     ------------------------------------------------------------------------- */

  var tooltipEl = null;
  var tooltipDateEl = null;
  var tooltipValueEl = null;
  var tooltipNoteEl = null;
  var tooltipHideTimer = null;

  function ensureTooltip() {
    if (tooltipEl) { return; }
    tooltipEl = document.getElementById("day-tooltip");
    tooltipDateEl = document.createElement("p");
    tooltipDateEl.className = "day-tooltip-date";
    tooltipValueEl = document.createElement("p");
    tooltipValueEl.className = "day-tooltip-value";
    tooltipNoteEl = document.createElement("p");
    tooltipNoteEl.className = "day-tooltip-note";
    tooltipNoteEl.textContent = "Press Enter or Space for details. Includes cache.";
    tooltipEl.appendChild(tooltipDateEl);
    tooltipEl.appendChild(tooltipValueEl);
    tooltipEl.appendChild(tooltipNoteEl);
  }

  function showTooltipForButton(btn) {
    ensureTooltip();
    cancelTooltipHide();
    var iso = btn.dataset.date;
    var state = btn.dataset.state;
    var parts = iso.match(ISO_DATE);
    var dt = utcDate(+parts[1], +parts[2], +parts[3]);
    var human = WEEKDAY_NAMES[mondayIndex(dt)] + " " + iso;

    tooltipDateEl.textContent = human;
    tooltipValueEl.dataset.state = state;
    tooltipValueEl.textContent = "";
    if (state === "measured") {
      var tokens = currentDayTokens(iso);
      if (tokens !== null) {
        tooltipValueEl.textContent = formatTokens(tokens) + " tokens";
      }
    } else if (state === "pending") {
      tooltipValueEl.textContent = "Not yet reported";
    } else {
      tooltipValueEl.textContent = "No qualified data (missing or withheld)";
    }

    tooltipEl.hidden = false;
    document.querySelectorAll('[aria-describedby="day-tooltip"]').forEach(function (button) {
      button.removeAttribute("aria-describedby");
    });
    btn.setAttribute("aria-describedby", "day-tooltip");
    positionTooltipNear(btn);
  }

  function currentDayTokens(iso) {
    var map = currentStateMap();
    if (!map) { return null; }
    var entry = map.get(iso);
    if (!entry) { return null; }
    return entry.tokens;
  }

  function currentStateMap() {
    /* Stored by init() on success. */
    return stateMapRef.value;
  }
  var stateMapRef = { value: null };

  function positionTooltipNear(btn) {
    /* Position relative to the viewport so it never overflows its
       container; we also clamp inside the viewport. */
    var rect = btn.getBoundingClientRect();
    var tipRect = tooltipEl.getBoundingClientRect();
    var margin = 8;
    var top = rect.top - tipRect.height - margin;
    if (top < margin) {
      top = rect.bottom + margin;
    }
    var left = rect.left + (rect.width / 2) - (tipRect.width / 2);
    var maxLeft = window.innerWidth - tipRect.width - margin;
    if (left < margin) { left = margin; }
    if (left > maxLeft) { left = maxLeft; }
    tooltipEl.style.top = Math.round(top) + "px";
    tooltipEl.style.left = Math.round(left) + "px";
  }

  function hideTooltip() {
    cancelTooltipHide();
    if (!tooltipEl) { return; }
    tooltipEl.hidden = true;
    document.querySelectorAll('[aria-describedby="day-tooltip"]').forEach(function (button) {
      button.removeAttribute("aria-describedby");
    });
  }

  function scheduleTooltipHide() {
    cancelTooltipHide();
    tooltipHideTimer = setTimeout(hideTooltip, 80);
  }

  function cancelTooltipHide() {
    if (tooltipHideTimer !== null) {
      clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }
  }

  /* -------------------------------------------------------------------------
     Dialog
     ------------------------------------------------------------------------- */

  var dialogEl = null;
  var dialogDateEl = null;
  var dialogStatusEl = null;
  var dialogWindowEl = null;
  var dialogValueEl = null;
  var lastFocusedButton = null;

  function ensureDialog() {
    if (dialogEl) { return; }
    dialogEl = document.getElementById("day-dialog");
    dialogDateEl = document.getElementById("day-dialog-date");
    dialogStatusEl = document.getElementById("day-dialog-status");
    dialogValueEl = document.getElementById("daily-value");
    /* Esc closes natively; we also tie the close button + backdrop click
       to dialog.close() to ensure focus restoration happens via close. */
    dialogEl.addEventListener("close", onDialogClose);
    dialogEl.addEventListener("click", function (event) {
      var rect = dialogEl.getBoundingClientRect();
      if (event.target === dialogEl && (event.clientX < rect.left || event.clientX > rect.right
          || event.clientY < rect.top || event.clientY > rect.bottom)) { dialogEl.close(); }
    });
  }

  function openDialogForButton(btn) {
    ensureDialog();
    if (btn.disabled) {
      return;
    }
    lastFocusedButton = btn;
    var iso = btn.dataset.date;
    var state = btn.dataset.state;
    var parts = iso.match(ISO_DATE);
    var dt = utcDate(+parts[1], +parts[2], +parts[3]);
    dialogDateEl.textContent = WEEKDAY_NAMES[mondayIndex(dt)] + " " + iso;
    if (state === "measured") {
      var tokens = currentDayTokens(iso);
      dialogValueEl.textContent = tokens === null
        ? "No measurement"
        : formatTokens(tokens) + " tokens";
      dialogValueEl.dataset.state = "measured";
      dialogStatusEl.textContent = "Measured";
      dialogStatusEl.dataset.state = "measured";
    } else if (state === "pending") {
      dialogValueEl.textContent = "Not yet reported";
      dialogValueEl.dataset.state = "pending";
      dialogStatusEl.textContent = "Pending publication";
      dialogStatusEl.dataset.state = "pending";
    } else {
      dialogValueEl.textContent = "Not available";
      dialogValueEl.dataset.state = "unknown";
      dialogStatusEl.textContent = "Missing or withheld";
      dialogStatusEl.dataset.state = "unknown";
    }
    hideTooltip();
    if (typeof dialogEl.showModal === "function") {
      dialogEl.showModal();
    } else {
      dialogEl.setAttribute("open", "");
    }
  }

  function currentWindowDescription() {
    var meta = currentMetaRef.value;
    if (!meta) { return ""; }
    return "Year-to-date through " + meta.periodEndHuman +
      " (Monday, " + meta.delayDays + " days delayed)";
  }

  function onDialogClose() {
    if (lastFocusedButton && typeof lastFocusedButton.focus === "function") {
      lastFocusedButton.focus();
    }
    lastFocusedButton = null;
    hideTooltip();
  }

  /* -------------------------------------------------------------------------
     Keyboard roving tabindex
     ------------------------------------------------------------------------- */

  var rovingGrid = null;
  var allDayButtons = [];
  var activeIndex = -1;

  function setupRoving(rootContainer) {
    rovingGrid = rootContainer;
    var buttons = rootContainer.querySelectorAll("button.day");
    allDayButtons = Array.prototype.slice.call(buttons);
    if (allDayButtons.length === 0) { return; }
    /* Default: first one is in the tab order, others skipped. */
    activateRovingAt(0);
  }

  function activateRovingAt(index) {
    if (index < 0 || index >= allDayButtons.length) { return; }
    if (activeIndex >= 0 && allDayButtons[activeIndex]) {
      allDayButtons[activeIndex].setAttribute("tabindex", "-1");
    }
    activeIndex = index;
    allDayButtons[index].setAttribute("tabindex", "0");
  }

  function nearestButtonForDelta(delta) {
    /* delta is in calendar-day terms (e.g. -1 = previous day, +7 = same
       weekday next week). We compute by walking the rendered list. Because
       the rendered list skips pending days but keeps real dates in order,
       we walk across spacers too; for our purposes, we can map from the
       current ISO date. */
    if (!allDayButtons[activeIndex]) { return -1; }
    var currentIso = allDayButtons[activeIndex].dataset.date;
    var target = isoAddDays(currentIso, delta);
    for (var i = 0; i < allDayButtons.length; i++) {
      if (allDayButtons[i].dataset.date === target) { return i; }
    }
    return -1;
  }

  function isoAddDays(iso, days) {
    var parts = iso.match(ISO_DATE);
    var d = utcDate(+parts[1], +parts[2], +parts[3]);
    d.setUTCDate(d.getUTCDate() + days);
    return isoOf(d);
  }

  function handleGridKeydown(ev) {
    var key = ev.key;
    var delta = 0;
    if (key === "ArrowUp")    { delta = -1; }
    else if (key === "ArrowDown")  { delta = 1; }
    else if (key === "ArrowLeft")  { delta = -7; }
    else if (key === "ArrowRight") { delta = 7; }
    else if (key === "Home") {
      /* Move to first day of the current month. */
      ev.preventDefault();
      var cur = allDayButtons[activeIndex];
      if (cur) {
        var parts = cur.dataset.date.match(ISO_DATE);
        var target = parts[1] + "-" + parts[2] + "-01";
        var idx = findIndex(target);
        if (idx >= 0) { activateRovingAt(idx); allDayButtons[idx].focus(); }
      }
      return;
    } else if (key === "End") {
      ev.preventDefault();
      var c2 = allDayButtons[activeIndex];
      if (c2) {
        var lastOfMonth = daysInMonth(+c2.dataset.date.slice(0, 4),
          +c2.dataset.date.slice(5, 7));
        var year2 = +c2.dataset.date.slice(0, 4);
        var month2 = +c2.dataset.date.slice(5, 7);
        lastOfMonth = String(lastOfMonth);
        if (lastOfMonth.length < 2) { lastOfMonth = "0" + lastOfMonth; }
        var month2s = String(month2);
        if (month2s.length < 2) { month2s = "0" + month2s; }
        var tIso = year2 + "-" + month2s + "-" + lastOfMonth;
        var i2 = findIndex(tIso);
        if (i2 >= 0) { activateRovingAt(i2); allDayButtons[i2].focus(); }
      }
      return;
    } else if (key === "Enter" || key === " " || key === "Spacebar") {
      /* Native button activation. Let it through. */
      return;
    } else {
      return;
    }
    if (delta !== 0) {
      ev.preventDefault();
      var targetIdx = nearestButtonForDelta(delta);
      if (targetIdx >= 0) {
        activateRovingAt(targetIdx);
        allDayButtons[targetIdx].focus();
      }
    }
  }

  function findIndex(iso) {
    for (var i = 0; i < allDayButtons.length; i++) {
      if (allDayButtons[i].dataset.date === iso) { return i; }
    }
    return -1;
  }

  /* -------------------------------------------------------------------------
     Summary figure
     ------------------------------------------------------------------------- */

  function renderHeadline(snapshot) {
    var annualEl = document.getElementById("annual-total");
    var tokens = snapshot.metrics.opencode_tokens_year.value;
    annualEl.textContent = formatTokens(tokens) + " tokens";
    /* The "through" label reflects the most recent day actually recorded
       in the calendar, which may be one day before the published
       ``period_end`` when ``period_end`` is exclusive. */
    var days = snapshot.token_calendar.days;
    var lastRecordedIso = days.length > 0 ? days[days.length - 1].date : snapshot.token_calendar.period_end;
    currentMetaRef.value = {
      periodEndHuman: humanDate(lastRecordedIso),
      delayDays: snapshot.delay_days
    };
    var prov = document.getElementById("calendar-provenance");
    prov.textContent = "Source: OpenCode \u00b7 UTC \u00b7 through "
      + humanDate(lastRecordedIso)
      + " \u00b7 7d+ delay";
  }

  function humanDate(iso) {
    var p = iso.match(ISO_DATE);
    var dt = utcDate(+p[1], +p[2], +p[3]);
    return WEEKDAY_NAMES[mondayIndex(dt)] + ", " + MONTH_NAMES[dt.getUTCMonth()] + " " + dt.getUTCDate() + ", " + dt.getUTCFullYear();
  }

  var currentMetaRef = { value: null };

  /* -------------------------------------------------------------------------
     Click / hover / focus wiring
     ------------------------------------------------------------------------- */

  function wireGridEvents(rootContainer) {
    /* Use event delegation. Listeners stay here even if the grid is
       replaced later. */
    rootContainer.addEventListener("mouseover", function (ev) {
      var btn = ev.target.closest && ev.target.closest("button.day");
      if (!btn || btn.disabled) { hideTooltip(); return; }
      showTooltipForButton(btn);
    });
    rootContainer.addEventListener("mouseout", function (ev) {
      var btn = ev.target.closest && ev.target.closest("button.day");
      if (!btn) { return; }
      /* If the mouse moves to another day, the mouseover on that day
         will replace the tooltip. Otherwise schedule a hide. */
      var to = ev.relatedTarget;
      if (to && btn.contains(to)) { return; }
      scheduleTooltipHide();
    });
    /* Mouse leave on the grid clears immediately. */
    rootContainer.addEventListener("mouseleave", hideTooltip);
    rootContainer.addEventListener("focusin", function (ev) {
      var btn = ev.target.closest && ev.target.closest("button.day");
      if (!btn || btn.disabled) { hideTooltip(); return; }
      activateRovingAt(findIndex(btn.dataset.date));
      showTooltipForButton(btn);
    });
    rootContainer.addEventListener("focusout", function (ev) {
      var btn = ev.target.closest && ev.target.closest("button.day");
      if (!btn) { return; }
      var to = ev.relatedTarget;
      if (to && btn.contains(to)) { return; }
      scheduleTooltipHide();
    });
    rootContainer.addEventListener("click", function (ev) {
      var btn = ev.target.closest && ev.target.closest("button.day");
      if (!btn || btn.disabled) { return; }
      activateRovingAt(findIndex(btn.dataset.date));
      openDialogForButton(btn);
    });
    rootContainer.addEventListener("keydown", handleGridKeydown);
  }

  /* Esc on the grid area (when no day is focused) should hide the
     tooltip. Tooltip should never get focus. */
  function wireGlobalKeys() {
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") {
        hideTooltip();
      }
    });
  }

  /* -------------------------------------------------------------------------
     Theme
     ------------------------------------------------------------------------- */

  function applyTheme() {
    var wantsDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (wantsDark) {
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  function watchTheme() {
    if (!window.matchMedia) { return; }
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var handler = function () { applyTheme(); };
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", handler);
    } else if (typeof mq.addListener === "function") {
      mq.addListener(handler);
    }
  }

  /* -------------------------------------------------------------------------
     Lifecycle
     ------------------------------------------------------------------------- */

  function setStatus(text, state) {
    var el = document.getElementById("calendar-status");
    el.textContent = text;
    if (state) { el.dataset.state = state; } else { delete el.dataset.state; }
  }

  function showError(message) {
    var wrap = document.getElementById("calendar-error");
    var text = document.getElementById("calendar-error-text");
    wrap.hidden = false;
    text.textContent = message;
    setStatus("Data could not be loaded.", "error");
  }

  function hideError() {
    var wrap = document.getElementById("calendar-error");
    wrap.hidden = true;
  }

  function render(snapshot) {
    var aggregateParts = snapshot.aggregate_date.match(ISO_DATE);
    var year = +aggregateParts[1];
    var periodEnd = snapshot.token_calendar.period_end;

    stateMapRef.value = buildStateMap(snapshot);
    renderHeadline(snapshot);

    var root = document.getElementById("calendar-grid");
    while (root.firstChild) { root.removeChild(root.firstChild); }
    var jan1 = utcDate(year, 1, 1);
    var gridStart = new Date(jan1.getTime() - mondayIndex(jan1) * 86400000);
    var columns = Math.ceil((utcDate(year + 1, 1, 1).getTime() - gridStart.getTime()) / (7 * 86400000));
    root.style.setProperty("--second-columns", String(columns - 26) + "fr");
    root.style.setProperty("--total-columns", String(columns));
    root.appendChild(makeYearBlock(year, 0, 26, gridStart, stateMapRef.value, periodEnd));
    root.appendChild(makeYearBlock(year, 26, columns, gridStart, stateMapRef.value, periodEnd));
    root.hidden = false;

    setupRoving(root);
    wireGridEvents(root);
    ensureTooltip();
    tooltipEl.addEventListener("mouseenter", cancelTooltipHide);
    tooltipEl.addEventListener("mouseleave", hideTooltip);
    window.addEventListener("scroll", hideTooltip, { passive: true });
    window.addEventListener("resize", hideTooltip);
    ensureDialog();

    setStatus("Use the arrow keys to explore days; Enter opens details.");
  }

  function todayUtcIso() {
    var d = new Date();
    return d.getUTCFullYear() + "-" +
      String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
      String(d.getUTCDate()).padStart(2, "0");
  }

  function init() {
    applyTheme();
    watchTheme();
    wireGlobalKeys();

    var fetchOpts = {
      method: "GET",
      headers: { "Accept": "application/json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      mode: "same-origin"
    };

    setStatus("Loading public data\u2026");
    fetch(DATA_URL, fetchOpts).then(function (response) {
      if (!response.ok) { throw new Error(ERR_FETCH); }
      return response.json();
    }).then(function (raw) {
      var validationError = validateSnapshot(raw, todayUtcIso());
      if (validationError) {
        showError(validationError.message);
        return;
      }
      hideError();
      render(raw);
    }).catch(function () {
      showError(ERR_FETCH);
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { validateSnapshot: validateSnapshot, levelFor: levelFor, isoAddDays: isoAddDays };
    return;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
