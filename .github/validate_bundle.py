#!/usr/bin/env python3
"""Strict, stdlib-only validator for the public AI Engineering Pulse bundle.

This script is intentionally self-contained: it does NOT import the
engineering-pulse backend (no pydantic, no httpx, no cryptography). It
mirrors the allowlists and rules in ``pulse.privacy`` (``validate_public``
and ``validate_svg``) so that the GitHub Actions workflow can verify the
bundle without leaking or depending on private backend state.

Bundle layout (the only files ever read):

    <bundle>/pulse-dark.svg
    <bundle>/pulse-light.svg
    <bundle>/pulse-mobile-dark.svg
    <bundle>/pulse-mobile-light.svg
    <bundle>/snapshot.json
    <bundle>/manifest.json

Exit codes:
    0: bundle is public-ready
    non-zero: bundle rejected. Error messages are intentionally generic so
              a malformed payload never echoes raw injected content back
              into CI logs.

Usage::

    python .github/validate_bundle.py [bundle_dir]

``bundle_dir`` defaults to ``assets/pulse`` (the path the workflow uses).

Privacy doctrine enforced here:

* No remote references, no JavaScript, no ``<foreignObject>``, no event
  handlers, no embedded HTML. Pure static SVG.
* Only allowlisted SVG tags / attributes may appear.
* The "sensitive" regex scans BOTH attribute values and visible text.
  It detects IPv4, MAC, GitHub/IDE/OAuth tokens, ``Bearer`` headers,
  filesystem paths under ``/Users/`` or ``/home/``, ``.local``,
  ``http(s)://`` and ``BEGIN … PRIVATE KEY``.
* ``manifest.json`` is verified by SHA-256 against the actual file
  bytes. Hash mismatches are rejected so a partial commit cannot slip
  past CI.
* Errors never print the offending value. They print a fixed reason
  code only, so a malformed payload cannot dump its own private
  string into CI logs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterable

# ---------------------------------------------------------------------------
# Public-error doctrine. Every error path calls _raise(...) with a fixed
# label. The label never includes the offending value or its surrounding
# context, so a malformed bundle cannot exfiltrate its own injected
# content into the CI log.
# ---------------------------------------------------------------------------


def _raise(reason: str) -> None:
    """Raise a ValueError with a generic, fixed-phrase reason label."""
    raise ValueError(reason)


# ---------------------------------------------------------------------------
# Mirror of pulse.privacy.METRIC_UNITS — must stay in sync with the
# backend. 41 keys, no more, no less. Drift here means the workflow will
# reject bundles the backend accepts (or vice-versa); CI on the backend
# repo surfaces drift via its own synthetic tests.
# ---------------------------------------------------------------------------

METRIC_UNITS: dict[str, str] = {
    "tracked_tokens": "tokens", "input_tokens": "tokens",
    "output_tokens": "tokens", "cached_tokens": "tokens",
    "tokens_30d": "tokens", "local_tokens": "tokens",
    "cloud_tokens": "tokens",
    "agent_executions": "count", "tool_calls": "count",
    "mcp_calls": "count", "configured_agents": "count",
    "configured_skills": "count", "used_skills": "count",
    "autonomous_executions": "count",
    "scheduled_executions": "count",
    "enabled_automations": "count", "local_executions": "count",
    "nodes": "count", "physical_cores": "count",
    "logical_threads": "count", "vm_count": "count",
    "lxc_count": "count", "gpu_count": "count",
    "local_models": "count",
    "ai_lines": "lines", "human_lines": "lines",
    "unknown_lines": "lines",
    "agent_success_rate": "percent", "ai_acceptance_rate": "percent",
    "agent_p50_seconds": "seconds", "agent_p95_seconds": "seconds",
    "ram_gib": "GiB", "storage_gib": "GiB", "vram_gib": "GiB",
    "api_spend_usd": "USD", "cost_per_million": "USD/Mtokens",
    "local_cost_per_million": "USD/Mtokens",
    "energy_wh": "Wh", "tokens_per_wh": "tokens/Wh",
    "wh_per_million": "Wh/Mtokens", "throughput": "tokens/s",
    "input_tokens_30d": "tokens", "output_tokens_30d": "tokens", "cached_tokens_30d": "tokens",
    "requests_30d": "count", "cache_input_share": "percent", "token_coverage": "percent",
    "priced_request_coverage": "percent", "request_success_rate": "percent",
    "request_p50_seconds": "seconds", "request_p95_seconds": "seconds",
    "verified_physical_cores": "count", "verified_logical_threads": "count",
    "capacity_nodes_observed": "count", "verified_os_ram_gib": "GiB",
    "verified_local_storage_gib": "GiB",
    "openai_tokens_30d": "tokens", "openai_output_tokens_30d": "tokens",
    "opencode_openai_tokens_30d": "tokens", "codex_tokens_30d": "tokens",
    "codex_output_tokens_30d": "tokens", "codex_cached_tokens_30d": "tokens",
    "opencode_tokens_30d": "tokens", "opencode_output_tokens_30d": "tokens",
    "opencode_cached_tokens_30d": "tokens", "opencode_fresh_input_tokens_30d": "tokens",
    "opencode_tokens_year": "tokens", "opencode_output_tokens_year": "tokens",
    "opencode_cached_tokens_year": "tokens", "opencode_fresh_input_tokens_year": "tokens",
}

PUBLIC_PROVIDERS: frozenset[str] = frozenset({
    "OpenAI", "Anthropic", "MiniMax", "Google", "GitHub Copilot",
    "Ollama", "OpenCode", "Gateway", "Other", "Unknown",
})

PUBLIC_MODELS: frozenset[str] = frozenset({
    "GPT", "Claude", "MiniMax", "Gemini", "Qwen", "DeepSeek",
    "Llama", "Other", "Unknown",
})

# Mirror of pulse.privacy.SENSITIVE. Same regex. Patterns in priority order:
SENSITIVE = re.compile(
    r"(?i)(?:\b(?:\d{1,3}\.){3}\d{1,3}\b"
    r"|(?:[0-9a-f]{2}:){5}[0-9a-f]{2}"
    r"|sk-[a-z0-9_-]{8,}|gh[oprsu]_[a-z0-9]+|Bearer\s+\S+"
    r"|/Users/|/home/|\.local\b|https?://|BEGIN .*PRIVATE KEY)"
)

ISO_WEEK = re.compile(r"^\d{4}-W\d{2}$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# SVG tags + attributes mirrors pulse.privacy.validate_svg. ``style`` is
# deliberately absent: presentation attributes (``font-family``, ``fill``,
# ...) carry the same information without any chance of ``@import`` or
# other remote style resolution.
SVG_TAGS: frozenset[str] = frozenset({
    "svg", "title", "desc", "g", "rect", "circle", "ellipse",
    "path", "line", "polyline", "polygon", "text", "tspan",
    "defs", "linearGradient", "radialGradient", "stop", "clipPath",
})
# Mirror of pulse.privacy.validate_svg attribute allowlist (37 keys,
# lowercased to match the validator's ``local = key.lower()`` step).
SVG_ATTRS: frozenset[str] = frozenset({
    "id", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx",
    "ry", "width", "height", "viewbox", "preserveaspectratio",
    "fill", "stroke", "stroke-width", "opacity",
    "font-family", "font-size", "font-weight", "text-anchor",
    "letter-spacing", "role", "aria-labelledby", "aria-label",
    "d", "points", "offset", "stop-color", "stop-opacity",
    "transform", "clip-path", "gradientunits",
})
URL_REF = re.compile(r"^url\(#[\w-]+\)$")
SVG_FILENAMES: tuple[str, ...] = (
    "pulse-dark.svg", "pulse-light.svg",
    "pulse-mobile-dark.svg", "pulse-mobile-light.svg",
)
ALLOWED_FILES: frozenset[str] = frozenset((*SVG_FILENAMES, "snapshot.json", "manifest.json"))
SCHEMA_VERSION: int = 1
DELAY_DAYS: int = 7
WINDOW_DAYS: int = 30
STALE_DAYS: int = 14
COVERAGE_STATUSES: frozenset[str] = frozenset({
    "connected", "partial", "not-configured", "unavailable",
})
COVERAGE_SOURCES: frozenset[str] = frozenset({
    "litellm", "ollama", "opencode", "claude-code", "codex",
    "openai", "anthropic", "minimax", "copilot", "agents",
    "skills", "proxmox", "energy", "git-ai",
})
QUALITY_TIERS: frozenset[str] = frozenset({
    "measured", "provider-reported", "estimated", "unavailable",
})


# ---------------------------------------------------------------------------
# Date / week helpers
# ---------------------------------------------------------------------------


def reporting_end(today: date) -> date:
    """Mirror of pulse.privacy.reporting_end (Monday + 7d delayed cutoff)."""
    return today - timedelta(days=today.weekday() + 7)


def _expect_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _raise(label + ":non-integer")
    return value


def _expect_float_finite(value: Any, label: str) -> float:
    if isinstance(value, bool):
        _raise(label + ":non-finite")
    if isinstance(value, int):
        value = float(value)
    if not isinstance(value, float):
        _raise(label + ":non-finite")
    if math.isnan(value) or math.isinf(value):
        _raise(label + ":non-finite")
    return value


def _expect_str(value: Any, allowed: Iterable[str], label: str) -> str:
    if not isinstance(value, str) or value not in allowed:
        _raise(label + ":enum")
    return value


def _expect_date(value: Any, label: str) -> date:
    if not isinstance(value, str) or not ISO_DATE.match(value):
        _raise(label + ":iso-date")
    try:
        return date.fromisoformat(value)
    except ValueError:
        _raise(label + ":iso-date")


# ---------------------------------------------------------------------------
# Bundle shape
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BundlePaths:
    bundle: Path

    def asset(self, name: str) -> Path:
        return self.bundle / name


def _check_filesystem(p: BundlePaths, allowed: frozenset[str]) -> None:
    if p.bundle.is_symlink() or not p.bundle.is_dir():
        _raise("bundle:missing-dir")
    actual = {child.name for child in p.bundle.iterdir()}
    if actual != allowed:
        _raise("bundle:files-mismatch")
    for child in p.bundle.iterdir():
        if child.is_symlink() or not child.is_file():
            _raise("bundle:not-regular-file")
        # Reject any path that escapes the bundle directory.
        try:
            child.resolve(strict=False).relative_to(p.bundle.resolve(strict=False))
        except ValueError:
            _raise("bundle:path-traversal")


# ---------------------------------------------------------------------------
# snapshot.json — strict top-level + nested-field validation
# ---------------------------------------------------------------------------


def _check_top_envelope(data: Any) -> None:
    if not isinstance(data, dict):
        _raise("snapshot:top-level-object")
    # Required fixed fields with strict types:
    if type(data.get("schema_version")) is not int or data["schema_version"] != SCHEMA_VERSION:
        _raise("snapshot:schema-version")
    if data.get("mode") != "production":
        _raise("snapshot:mode")
    if type(data.get("delay_days")) is not int or data["delay_days"] != DELAY_DAYS:
        _raise("snapshot:delay")
    if not isinstance(data.get("aggregate_date"), str) or not ISO_DATE.match(data["aggregate_date"]):
        _raise("snapshot:aggregate-date")
    for field in ("period_start", "period_end"):
        if not isinstance(data.get(field), str) or not ISO_DATE.match(data[field]):
            _raise("snapshot:" + field)
    tracking_since = data.get("tracking_since", None)
    if tracking_since is not None and (
        not isinstance(tracking_since, str) or not ISO_DATE.match(tracking_since)
    ):
        _raise("snapshot:tracking-since")


def _check_window(data: dict[str, Any], today: date) -> None:
    aggregate = _expect_date(data["aggregate_date"], "snapshot:aggregate-date")
    period_start = _expect_date(data["period_start"], "snapshot:period-start")
    period_end = _expect_date(data["period_end"], "snapshot:period-end")
    if aggregate > today:
        _raise("snapshot:future-aggregate")
    if (today - aggregate).days > STALE_DAYS:
        _raise("snapshot:stale-aggregate")
    cutoff = reporting_end(aggregate)
    # The period_end must equal the cutoff for a Monday-cutoff bundle,
    # OR be earlier than the cutoff but only when the earlier date is
    # also a Monday AND the period_start is exactly 30 days before it.
    # This mirrors pulse.privacy.validate_public's rule that the window
    # must be (period_end - 30d .. period_end) and period_end cannot be
    # later than the Monday cutoff.
    if period_end > cutoff:
        _raise("snapshot:period-end-after-cutoff")
    if period_start != period_end - timedelta(days=WINDOW_DAYS):
        _raise("snapshot:period-length")
    if period_end.weekday() != 0:
        _raise("snapshot:period-end-not-monday")
    tracking_since = data.get("tracking_since")
    if tracking_since is not None:
        ts = _expect_date(tracking_since, "snapshot:tracking-since")
        if ts > period_end:
            _raise("snapshot:tracking-since-future")


def _check_metric_value(unit: str, value: Any, quality: Any) -> None:
    if not isinstance(quality, str) or quality not in QUALITY_TIERS:
        _raise("metric:quality-enum")
    if value is None:
        if quality != "unavailable":
            _raise("metric:null-value-non-unavailable")
        return
    # Finite numeric only; bools excluded; Python int→float fine.
    f = _expect_float_finite(value, "metric:value")
    if f < 0:
        _raise("metric:negative-value")
    if quality == "unavailable":
        _raise("metric:unavailable-with-value")
    if unit == "percent" and f > 100:
        _raise("metric:percent-range")
    if unit == "count" and not isinstance(value, int):
        _raise("metric:count-not-integer")
    if unit in ("tokens", "lines") and not isinstance(value, int):
        _raise("metric:integer-unit-not-integer")


def _check_metrics(metrics: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(metrics, dict):
        _raise("metrics:object")
    unknown = set(metrics) - set(METRIC_UNITS)
    if unknown:
        _raise("metrics:unknown-key")
    for key, m in metrics.items():
        if not isinstance(m, dict):
            _raise("metrics:entry-object")
        # No extra fields beyond the documented schema.
        expected_fields = {"value", "unit", "quality", "window", "reason"}
        if set(m) - expected_fields:
            _raise("metrics:entry-extras")
        declared_unit = _expect_str(m.get("unit"), {METRIC_UNITS[key]}, "metric:unit")
        _expect_str(
            m.get("window"), {"tracked", "30d", "year", "inventory"}, "metric:window"
        )
        # Quality + reason are validated inside _check_metric_value / _check_reason.
        _check_reason(m.get("reason"), "metric:reason-enum")
        _check_metric_value(declared_unit, m.get("value"), m.get("quality"))
    # OpenCode decomposition is the published headline; both 30d and
    # year windows share the same primary + three component shape. Each
    # window's decomposition must share the same window tag and the
    # primary total must equal the sum of its three same-scope parts.
    for window in ('30d', 'year'):
        keys = [f'opencode_{part}_{window}'
                 for part in ('tokens', 'fresh_input_tokens',
                              'cached_tokens', 'output_tokens')]
        if any(metrics.get(key,{}).get('value') is not None
               and metrics[key]['window']!=window for key in keys):
            _raise('opencode:counter-window')
        if all(metrics.get(key, {}).get('value') is not None
               for key in keys):
            if any(metrics[key]['window'] != window for key in keys):
                _raise('opencode:decomposition-window')
            if metrics[keys[0]]['value'] != sum(
                    metrics[key]['value'] for key in keys[1:]):
                _raise('opencode:decomposition-total')
    return metrics


_REASON_ENUM: frozenset[str] = frozenset({
    "available", "not-instrumented", "insufficient-cohort", "partial",
    "stale", "uncorrelated", "suppressed", "pricing-estimate",
    "subscription-not-billed",
})


def _check_reason(value: Any, label: str) -> None:
    if not isinstance(value, str) or value not in _REASON_ENUM:
        _raise(label)


def _check_distribution(group: Any, allowed: frozenset[str], label: str) -> None:
    if not isinstance(group, list):
        _raise(label + ":list")
    seen: set[str] = set()
    for entry in group:
        if not isinstance(entry, dict) or set(entry) - {"name", "tokens"}:
            _raise(label + ":entry-shape")
        name = entry.get("name")
        tokens = entry.get("tokens")
        if not isinstance(name, str) or name not in allowed:
            _raise(label + ":label-not-allowlisted")
        if name in seen:
            _raise(label + ":duplicate")
        seen.add(name)
        # Tokens must be a non-negative integer.
        if isinstance(tokens, bool) or not isinstance(tokens, int) or tokens < 0:
            _raise(label + ":tokens-nonneg-int")


def _check_weekly(buckets: Any, period_end: date) -> None:
    if not isinstance(buckets, list):
        _raise("weekly_tokens:list")
    seen: set[str] = set()
    for b in buckets:
        if not isinstance(b, dict) or set(b) - {"week", "tokens"}:
            _raise("weekly_tokens:entry-shape")
        week = b.get("week")
        tokens = b.get("tokens")
        if not isinstance(week, str) or not ISO_WEEK.match(week):
            _raise("weekly_tokens:week-format")
        if week in seen:
            _raise("weekly_tokens:duplicate")
        seen.add(week)
        year, ww = map(int, week.split("-W"))
        try:
            week_start = date.fromisocalendar(year, ww, 1)
        except ValueError:
            _raise("weekly_tokens:week-real")
        # Real ISO week: the corresponding Monday must exist and the
        # full 7-day window must fit before period_end.
        if week_start + timedelta(days=7) > period_end:
            _raise("weekly_tokens:week-after-period-end")
        if isinstance(tokens, bool) or not isinstance(tokens, int) or tokens < 0:
            _raise("weekly_tokens:tokens-nonneg-int")


def _check_coverage(coverage: Any, aggregate: date) -> None:
    if not isinstance(coverage, list):
        _raise("coverage:list")
    seen: set[str] = set()
    for c in coverage:
        if not isinstance(c, dict) or set(c) - {"source", "status", "tracking_since"}:
            _raise("coverage:entry-shape")
        source = c.get("source")
        status = c.get("status")
        ts = c.get("tracking_since")
        _expect_str(source, COVERAGE_SOURCES, "coverage:source")
        _expect_str(status, COVERAGE_STATUSES, "coverage:status")
        if source in seen:
            _raise("coverage:duplicate")
        seen.add(source)
        if ts is not None:
            if _expect_date(ts, "coverage:tracking-since") > aggregate:
                _raise("coverage:future-tracking-since")


def _check_calendar(calendar: Any, period_end: date, aggregate: date,
                     metrics: dict) -> None:
    if calendar is None:
        return
    if not isinstance(calendar,dict) or set(calendar)-{'source','provider','window','period_start','period_end','days'}:
        _raise('calendar:shape')
    # Window defaults to legacy '24w' so old fixtures keep working;
    # the parent factory now emits 'year' only.
    window = calendar.get('window', '24w')
    _expect_str(window, {'24w', 'year'}, 'calendar:window')
    source = _expect_str(calendar['source'], {'codex', 'opencode', 'litellm'},
                         'calendar:source')
    _expect_str(calendar['provider'], {'OpenAI', 'All providers'},
                'calendar:provider')
    start = _expect_date(calendar['period_start'], 'calendar:start')
    end = _expect_date(calendar['period_end'], 'calendar:end')
    if end != period_end:
        _raise('calendar:window-end')
    expected_start = (date(aggregate.year, 1, 1)
                      if window == 'year'
                      else end - timedelta(weeks=24))
    if start != expected_start:
        _raise('calendar:window-start')
    days = calendar['days']
    if not isinstance(days, list):
        _raise('calendar:days')
    expected_len = (end - start).days
    if window == '24w' and len(days) != 168:
        _raise('calendar:days')
    if window == 'year' and len(days) != expected_len:
        _raise('calendar:days')
    qualified = 0
    for i, day in enumerate(days):
        if not isinstance(day, dict) or set(day) - {'date', 'level', 'tokens'}:
            _raise('calendar:day-shape')
        if 'date' not in day or 'level' not in day:
            _raise('calendar:day-shape')
        if _expect_date(day['date'], 'calendar:date') != start + timedelta(days=i):
            _raise('calendar:day-order')
        level = day['level']
        # Default missing tokens to None for backward parity with the
        # backend strict validator when a day was authored without the
        # tokens field. The two validators must accept the same input.
        tokens = day.get('tokens')
        # Strict integer-typed check for level regardless of provider.
        if level is not None and (isinstance(level, bool)
                                  or not isinstance(level, int)):
            _raise('calendar:level-not-integer')
        if calendar['provider'] == 'All providers':
            if tokens is not None and (isinstance(tokens, bool)
                                       or not isinstance(tokens, int)
                                       or tokens < 0):
                _raise('calendar:tokens-nonneg-int')
            if (level is None) != (tokens is None):
                _raise('calendar:level-tokens-parity')
            if tokens is not None:
                expected = (0 if tokens == 0
                            else 1 if tokens < 1_000_000
                            else 2 if tokens < 10_000_000
                            else 3 if tokens < 100_000_000
                            else 4)
                if level != expected:
                    _raise('calendar:level-band-mismatch')
                qualified += 1
        else:
            # Legacy OpenAI observer: tokens must be None, no daily totals
            if tokens is not None:
                _raise('calendar:legacy-tokens-rejected')
            if level is not None:
                if level not in range(5):
                    _raise('calendar:level-range')
                qualified += 1
    if qualified < 7:
        _raise('calendar:insufficient-cohort')
    if window=='year' and calendar['provider']!='All providers':
        _raise('calendar:annual-provider')
    if calendar['provider'] == 'All providers':
        if window == 'year':
            if source != 'opencode':
                _raise('calendar:observer-source')
            metric_key = 'opencode_tokens_year'
        else:
            if source != 'opencode':
                _raise('calendar:observer-source')
            metric_key = 'opencode_tokens_30d'
    else:
        preferred = ('codex'
                     if metrics.get('codex_tokens_30d', {}).get('value') is not None
                     else 'opencode'
                     if metrics.get('opencode_openai_tokens_30d', {}).get('value') is not None
                     else 'litellm')
        if source != preferred or metrics.get('openai_tokens_30d', {}).get('value') is None:
            _raise('calendar:observer')
        metric_key = 'openai_tokens_30d'
    metric = metrics.get(metric_key)
    if not metric or metric.get('value') is None:
        _raise('calendar:observer-metric')
    total = metric['value']
    # Annual reconciliation uses every cell of the calendar (year to
    # delayed cutoff); 24-week uses the trailing 30-day window only.
    if window == 'year':
        current = list(days)
    else:
        current = [d for d in days
                   if end - timedelta(days=30) <= date.fromisoformat(d['date']) < end]
    if calendar['provider'] == 'All providers':
        known = sum(d.get('tokens') or 0 for d in current)
        all_qualified = all(d.get('tokens') is not None for d in current)
        if known > total or (all_qualified and known != total):
            _raise('calendar:reconciliation')
        if sum(d.get('tokens') is None for d in current) == 1 and known < total:
            _raise('calendar:zero-complement')
    else:
        # Legacy zero-complement (single null-date + zero day totals)
        if (sum(d['level'] is None for d in current) == 1
                and all(d['level'] in {None, 0} for d in current)
                and total > 0):
            _raise('calendar:zero-complement')


def _check_calendar_history(history: Any, period_end: date,
                            aggregate: date) -> list[int]:
    """Validate each history TokenCalendar entry and return the sorted
    list of years. Mirrors ``pulse.privacy.validate_public`` rules for
    history: opencode / All providers / window='year' only, dense Jan
    1 -> Jan 1 (next year), >=7 qualified days, ascending unique
    years strictly before the aggregate year and within the current
    period. No annual total is published, so single-complement /
    zero-complement checks are NOT applied (a year total would leak
    rare-date complements via subtraction)."""
    if not isinstance(history, list):
        _raise('history:list')
    seen: set[int] = set()
    years: list[int] = []
    for entry in history:
        if not isinstance(entry, dict) or set(entry) != {'source', 'provider', 'window',
                                                        'period_start', 'period_end', 'days'}:
            _raise('history:shape')
        _expect_str(entry.get('source'), {'opencode'}, 'history:source')
        _expect_str(entry.get('provider'), {'All providers'},
                    'history:provider')
        _expect_str(entry.get('window'), {'year'}, 'history:window')
        start = _expect_date(entry['period_start'], 'history:start')
        end = _expect_date(entry['period_end'], 'history:end')
        year = start.year
        if year in seen:
            _raise('history:duplicate-year')
        if year >= aggregate.year:
            _raise('history:future-year')
        if start != date(year, 1, 1):
            _raise('history:start-not-jan1')
        if end != date(year + 1, 1, 1):
            _raise('history:end-not-jan1-next')
        if end > period_end:
            _raise('history:window-overflow')
        seen.add(year)
        days = entry['days']
        if not isinstance(days, list):
            _raise('history:days')
        expected_len = (date(year + 1, 1, 1) - date(year, 1, 1)).days
        if len(days) != expected_len:
            _raise('history:days-len')
        qualified = 0
        for i, day in enumerate(days):
            if not isinstance(day, dict) or set(day) - {'date', 'level', 'tokens'}:
                _raise('history:day-shape')
            if 'date' not in day or 'level' not in day:
                _raise('history:day-shape')
            if _expect_date(day['date'], 'history:date') != start + timedelta(days=i):
                _raise('history:day-order')
            level = day['level']
            tokens = day.get('tokens')
            if level is not None and (isinstance(level, bool)
                                      or not isinstance(level, int)):
                _raise('history:level-not-integer')
            if tokens is not None and (isinstance(tokens, bool)
                                       or not isinstance(tokens, int)
                                       or tokens < 0):
                _raise('history:tokens-nonneg-int')
            if (level is None) != (tokens is None):
                _raise('history:level-tokens-parity')
            if tokens is not None:
                expected = (0 if tokens == 0
                            else 1 if tokens < 1_000_000
                            else 2 if tokens < 10_000_000
                            else 3 if tokens < 100_000_000
                            else 4)
                if level != expected:
                    _raise('history:level-band-mismatch')
                qualified += 1
        if qualified < 7:
            _raise('history:insufficient-cohort')
        years.append(year)
    if years != sorted(years):
        _raise('history:not-sorted')
    return years


def _check_snapshot(p: BundlePaths, today: date) -> tuple[dict[str, Any], list[int]]:
    raw = p.asset("snapshot.json").read_bytes()
    try:
        data = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        _raise("snapshot:json-parse")
    _check_top_envelope(data)
    _check_window(data, today)
    # Extra top-level keys beyond the schema are rejected.
    top_allowed = {
        "schema_version", "mode", "aggregate_date",
        "period_start", "period_end", "tracking_since", "delay_days",
        "metrics", "coverage", "weekly_tokens", "providers", "models",
        "token_calendar", "token_calendar_history",
    }
    extras = set(data) - top_allowed
    if extras:
        _raise("snapshot:extras")
    _check_metrics(data.get("metrics"))
    _check_distribution(data.get("providers", []), PUBLIC_PROVIDERS, "providers")
    _check_distribution(data.get("models", []), PUBLIC_MODELS, "models")
    period_end = _expect_date(data["period_end"], "snapshot:period-end")
    aggregate = _expect_date(data["aggregate_date"], "snapshot:aggregate-date")
    _check_weekly(data.get("weekly_tokens", []), period_end)
    _check_calendar(data.get('token_calendar'), period_end, aggregate, data['metrics'])
    history_years = _check_calendar_history(
        data.get('token_calendar_history', []), period_end, aggregate)
    _check_coverage(data.get("coverage"), aggregate)
    # Sensitive-payload scan over text content (attribute scan happens
    # in SVG step). json.dumps is stable and ASCII-safe here.
    if SENSITIVE.search(json.dumps(data, separators=(",", ":"))):
        _raise("snapshot:sensitive")
    return data, history_years


# ---------------------------------------------------------------------------
# SVG validation
# ---------------------------------------------------------------------------


def _check_one_svg(p: BundlePaths, name: str) -> None:
    raw = p.asset(name).read_text(encoding="utf-8")
    text_upper = raw.upper()
    if "<!DOCTYPE" in text_upper or "<!ENTITY" in text_upper:
        _raise(name + ":doctype")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        _raise(name + ":parse")
    if root.tag.split("}")[-1] != "svg":
        _raise(name + ":root")
    for node in root.iter():
        tag = node.tag.split("}")[-1]
        if tag not in SVG_TAGS:
            _raise(name + ":tag")
        for key, value in node.attrib.items():
            if "}" in key:
                _raise(name + ":namespaced-attr")
            local = key.split("}")[-1].lower()
            if local not in SVG_ATTRS:
                _raise(name + ":attr")
            if local.startswith("on") or local in {"href", "src"}:
                _raise(name + ":active-attr")
            if "url(" in value and not URL_REF.match(value):
                _raise(name + ":url-ref")
            # Sensitive payload scan over ATTRIBUTE values too. Skip
            # the XML namespace declaration ``xmlns="...ns URL..."``:
            # ``xmlns`` is parsed by ElementTree as an attribute but is
            # pure structural metadata, not telemetry.
            if local != "xmlns" and SENSITIVE.search(value):
                _raise(name + ":attr-sensitive")
    # Visible text scan, ignoring namespace URLs.
    if SENSITIVE.search(" ".join(root.itertext())):
        _raise(name + ":text-sensitive")


def _check_svgs(p: BundlePaths, history_years: list[int]) -> None:
    for name in SVG_FILENAMES:
        _check_one_svg(p, name)
    for year in history_years:
        for suffix in ('dark.svg', 'light.svg',
                       'mobile-dark.svg', 'mobile-light.svg'):
            name = f'pulse-{year}-{suffix}'
            # Defence-in-depth: the filename must be exactly the
            # validated pattern. Anything else was smuggled in.
            if not re.fullmatch(r'pulse-\d{4}-(mobile-)?(dark|light)\.svg', name):
                _raise(name + ":name-pattern")
            _check_one_svg(p, name)


# ---------------------------------------------------------------------------
# manifest.json — exact-keyset, SHA-256 verifies bundle files only
# ---------------------------------------------------------------------------


def _check_manifest(p: BundlePaths, history_years: list[int]) -> None:
    raw = p.asset("manifest.json").read_bytes()
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        _raise("manifest:json-parse")
    if not isinstance(manifest, dict):
        _raise("manifest:object")
    history_names = [f'pulse-{year}-{suffix}' for year in history_years
                     for suffix in ('dark.svg', 'light.svg',
                                    'mobile-dark.svg', 'mobile-light.svg')]
    expected_keys = frozenset((*SVG_FILENAMES, *history_names, "snapshot.json"))
    actual_keys = frozenset(manifest.keys())
    if actual_keys != expected_keys:
        _raise("manifest:keyset")
    for name, expected_hash in manifest.items():
        if not isinstance(expected_hash, str):
            _raise("manifest:hash-type")
        if "/" in name or ".." in name:
            _raise("manifest:path-traversal")
        # Filename must be one of the closed inventory: main hero SVGs,
        # per-year history SVGs, or snapshot.json. The keyset check
        # above already enforces exact-match, so the membership check
        # here is defence-in-depth only.
        if name not in expected_keys:
            _raise("manifest:unexpected-key")
        actual_hash = hashlib.sha256(p.asset(name).read_bytes()).hexdigest()
        if expected_hash != actual_hash:
            _raise("manifest:hash-mismatch")


# ---------------------------------------------------------------------------
# README cross-link (optional but explicit on)
# ---------------------------------------------------------------------------


README_GLOB: tuple[str, ...] = ("README.md",)


def _check_readme_links(repo_root: Path) -> None:
    """If a README.md exists, ensure each ``assets/pulse/...`` reference
    is relative and points at a file in the bundle (no HTTP URL). The
    check is best-effort and only fails closed on absolute / external
    URLs to ``assets/pulse/``.
    """
    for name in README_GLOB:
        path = repo_root / name
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        for line in text.splitlines():
            lower = line.lower()
            if "assets/pulse/" in lower or "assets/profile/" in lower:
                if "http://" in lower or "https://" in lower:
                    # http(s) link to assets/pulse is allowed only when
                    # the host is githubusercontent.com (the canonical
                    # GitHub raw URL).
                    if "raw.githubusercontent.com" not in lower:
                        _raise("readme:external-assets-url")
    return None


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "bundle",
        nargs="?",
        default="assets/profile",
        help="Path to the public bundle directory (default: assets/profile).",
    )
    parser.add_argument(
        "--repo-root",
        default=".",
        help="Path to the repository root for README cross-link checks.",
    )
    parser.add_argument(
        "--today",
        default=None,
        help="Override today's date (YYYY-MM-DD) for deterministic CI runs.",
    )
    args = parser.parse_args(argv)
    bundle = Path(args.bundle)
    paths = BundlePaths(bundle=bundle)
    if args.today:
        today = date.fromisoformat(args.today)
    else:
        today = date.today()
    try:
        # Reject symlinks/non-files before opening the schema-bearing JSON.
        if paths.bundle.is_symlink() or not paths.bundle.is_dir():
            _raise('bundle:missing-dir')
        if any(p.is_symlink() or not p.is_file() for p in paths.bundle.iterdir()):
            _raise('bundle:not-regular-file')
        # Snapshot first: derive the per-year history asset set from the
        # validated snapshot so the filesystem / manifest / SVG checks
        # can lock down the bundle against a closed inventory.
        data, history_years = _check_snapshot(paths, today)
        history_names = [f'pulse-{year}-{suffix}' for year in history_years
                         for suffix in ('dark.svg', 'light.svg',
                                        'mobile-dark.svg', 'mobile-light.svg')]
        allowed = frozenset((*SVG_FILENAMES, *history_names,
                             'snapshot.json', 'manifest.json'))
        _check_filesystem(paths, allowed)
        _check_svgs(paths, history_years)
        _check_manifest(paths, history_years)
        _check_readme_links(Path(args.repo_root))
    except ValueError as exc:
        # Errors are emitted as a fixed label only; never echo the bundle
        # payload (which might contain injected telemetry).
        print("validate-public: rejected ({})".format(str(exc)), file=sys.stderr)
        return 1
    except (OSError, UnicodeError, TypeError, OverflowError):
        print("validate-public: rejected (bundle:invalid-input)", file=sys.stderr)
        return 1
    print("validate-public: bundle is public-ready")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
