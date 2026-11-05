"""Synthetic storage benchmark; no model or network. Writes a JSON evidence record."""
import json
import os
import pathlib
import sys
import tempfile
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'plugin' / 'recall'))
import archive
import transcript


def run():
    with tempfile.TemporaryDirectory(prefix='recall-benchmark-') as temporary:
        root = pathlib.Path(temporary)
        os.environ['RECALL_HOME'] = str(root / 'archive')
        source = root / 'benchmark.jsonl'
        rows = []
        for n in range(1200):
            rows.extend([{'type': 'user', 'uuid': f'u{n}', 'message': {'content': f'合成任务 {n}'}},
                         {'type': 'assistant', 'uuid': f'a{n}', 'message': {'content': [
                             {'type': 'text', 'text': 'SYNTHETIC ' * 400 + str(n)}]}}])
        source.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows), encoding='utf-8')
        measurements = []
        for action in ('initial', 'append', 'unchanged'):
            if action == 'append':
                with source.open('a', encoding='utf-8') as stream:
                    stream.write(json.dumps({'type': 'user', 'uuid': 'last', 'message': {'content': '新增合成任务'}}) + '\n')
            raw = root / 'archive' / 'benchmark' / 'events.jsonl'
            before = raw.stat() if raw.exists() else None
            began = time.perf_counter()
            stats = archive.sync('benchmark', str(source))
            elapsed = time.perf_counter() - began
            after = raw.stat()
            measurements.append({'action': action, 'seconds': round(elapsed, 6), 'source_bytes': source.stat().st_size,
                                 'raw_bytes': after.st_size, 'raw_bytes_written': after.st_size - (before.st_size if before else 0),
                                 'raw_inode_preserved': before is None or before.st_ino == after.st_ino,
                                 'raw_mtime_unchanged': before is not None and before.st_mtime_ns == after.st_mtime_ns,
                                 **stats})
        began = time.perf_counter()
        view = transcript.load_archive('benchmark')
        projection = {'seconds': round(time.perf_counter() - began, 6), 'turns': len(view)}
        print(json.dumps({'measurements': measurements, 'view_rebuild': projection,
                          'limits': 'raw writes O(delta); source-prefix verification and raw/view reads O(n); single Linux sample'},
                         ensure_ascii=False, indent=2))


if __name__ == '__main__':
    run()
