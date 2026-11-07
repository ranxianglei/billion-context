"""Canonical configuration names with legacy Recall environment compatibility."""
import os
import pathlib


def env(suffix, default=None):
    """An explicitly set canonical name wins, including an empty value."""
    name = 'BILLION_CONTEXT_NATIVE_' + suffix
    if name in os.environ:
        return os.environ[name]
    return os.environ.get('RECALL_' + suffix, default)


def archive_root():
    return pathlib.Path(env('HOME') or pathlib.Path.home() / '.claude' / 'recall')
