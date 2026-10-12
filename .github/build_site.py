"""Package a closed static-site inventory and the validated, reduced public bundle.

Never copy the repository root, private source directories or local review history.
Stdlib only, usable by CI without backend dependencies or credentials.
"""

import argparse
import json
import runpy
import shutil
import tempfile
from pathlib import Path

SITE_FILES = frozenset({'index.html', 'calendar.css', 'calendar.js'})
BUNDLE_FILES = frozenset({
    'pulse-dark.svg', 'pulse-light.svg', 'pulse-mobile-dark.svg',
    'pulse-mobile-light.svg', 'snapshot.json', 'manifest.json',
})
PROFILE_METRICS = frozenset({
    'opencode_tokens_year', 'opencode_fresh_input_tokens_year',
    'opencode_cached_tokens_year', 'opencode_output_tokens_year',
    'nodes', 'vm_count', 'lxc_count', 'local_models',
})


def closed_directory(path, names):
    if path.is_symlink() or not path.is_dir():
        raise ValueError('site:invalid-directory')
    if {p.name for p in path.iterdir()} != names:
        raise ValueError('site:unexpected-files')
    if any(p.is_symlink() or not p.is_file() for p in path.iterdir()):
        raise ValueError('site:non-regular-file')


def build_site(site, bundle, output, *, today=None):
    closed_directory(site, SITE_FILES)
    closed_directory(bundle, BUNDLE_FILES)
    # Run the exact portable validator before reading or copying any payload.
    validate = runpy.run_path(str(Path(__file__).with_name('validate_bundle.py')))['main']
    args = [str(bundle), '--repo-root', str(Path(__file__).resolve().parents[1])]
    if today:
        args.extend(['--today', str(today)])
    if validate(args) != 0:
        raise ValueError('site:bundle-rejected')
    snapshot = json.loads((bundle / 'snapshot.json').read_text())
    if set(snapshot['metrics']) - PROFILE_METRICS or snapshot.get('tracking_since') is not None:
        raise ValueError('site:profile-only-required')
    if any(snapshot.get(key) for key in ['coverage', 'providers', 'models', 'weekly_tokens', 'token_calendar_history']):
        raise ValueError('site:profile-only-required')
    if output.is_symlink() or output.exists():
        raise ValueError('site:output-must-be-new')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.site-review-', dir=output.parent) as directory:
        staging = Path(directory) / 'site'
        staging.mkdir()
        for name in sorted(SITE_FILES):
            shutil.copyfile(site / name, staging / name)
        target = staging / 'assets' / 'profile'
        target.mkdir(parents=True)
        for name in sorted(BUNDLE_FILES):
            shutil.copyfile(bundle / name, target / name)
        # Revalidate copied bytes, guarding against a mid-build bundle change.
        copied_args = [str(target), '--repo-root', str(staging)]
        if today:
            copied_args.extend(['--today', str(today)])
        if validate(copied_args) != 0:
            raise ValueError('site:copied-bundle-rejected')
        for name in BUNDLE_FILES:
            if (target / name).read_bytes() != (bundle / name).read_bytes():
                raise ValueError('site:bundle-changed')
        staging.rename(output)
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site', type=Path, default=Path('site'))
    parser.add_argument('--bundle', type=Path, default=Path('assets/profile'))
    parser.add_argument('--output', type=Path, default=Path('_site'))
    parser.add_argument('--today', default=None)
    args = parser.parse_args(argv)
    try:
        build_site(args.site, args.bundle, args.output, today=args.today)
    except (ValueError, OSError, UnicodeError, KeyError, TypeError):
        parser.exit(1, 'build-site: rejected (invalid-public-site)\n')
    print('build-site: nine public files packaged; no repository-root upload')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
