"""准备固定版本源码，不修改旧运行时。"""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import re
import tarfile

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / '.cache/private-node/v24.22.1-appcontainer-canonical-v2-final-win-x64'
LEGACY = ROOT / '.cache/private-node/v24.22.1-appcontainer-win-x64'
ARCHIVE_SHA = '4f5379796280cdaeb0c2f358fd04b6a16cc4fb7dfa83b5a8c91a9d963b435231'
SOURCE_NAME = 'node-v24.22.1'
PATCH_FILES = ('deps/uv/src/win/pipe.c', 'deps/uv/src/win/fs.c', 'lib/fs.js')
HEADER_TARGET = 'deps/uv/src/win/yunzai-canonical.h'
HEADER_SOURCE = ROOT / 'scripts/private-node/canonical-metadata-client.h'
PATCH_SOURCE = ROOT / 'scripts/private-node/libuv-appcontainer.patch'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def apply_closed_patch(originals, patch):
    """按精确行号和补丁格式匹配，不做模糊应用。"""
    lines = patch.decode('utf8').splitlines(keepends=True)
    result = {}
    index = 0
    while index < len(lines):
        match = re.fullmatch(r'diff --git a/(\S+) b/(\S+)\n', lines[index])
        if match is None or match[1] != match[2] or match[1] not in PATCH_FILES or match[1] in result:
            raise RuntimeError('Unexpected patch file or duplicate section')
        name = match[1]
        index += 1
        if index < len(lines) and lines[index].startswith('index '):
            if re.fullmatch(r'index [0-9a-f]+\.\.[0-9a-f]+ 100644\n', lines[index]) is None:
                raise RuntimeError('Unexpected patch index')
            index += 1
        if lines[index:index + 2] != ['--- a/' + name + '\n', '+++ b/' + name + '\n']:
            raise RuntimeError('Unexpected patch headers')
        index += 2
        old = originals[name].decode('utf8').splitlines(keepends=True)
        output, cursor, hunks = [], 0, 0
        while index < len(lines) and not lines[index].startswith('diff --git '):
            hunk = re.fullmatch(r'@@ -(\d+),(\d+) \+(\d+),(\d+) @@[^\n]*\n', lines[index])
            if hunk is None:
                raise RuntimeError('Unexpected patch hunk')
            start, before_count, after_start, after_count = map(int, hunk.groups())
            index += 1
            before, after = [], []
            while index < len(lines) and lines[index][:1] in (' ', '+', '-'):
                line = lines[index]
                if line[0] != '+': before.append(line[1:])
                if line[0] != '-': after.append(line[1:])
                index += 1
            if len(before) != before_count or len(after) != after_count or start - 1 < cursor:
                raise RuntimeError('Patch hunk count or order mismatch')
            if old[start - 1:start - 1 + before_count] != before:
                raise RuntimeError('Patch does not exactly match the pinned archive')
            output.extend(old[cursor:start - 1])
            if len(output) != after_start - 1:
                raise RuntimeError('Patch output position mismatch')
            output.extend(after)
            cursor = start - 1 + before_count
            hunks += 1
        if hunks == 0:
            raise RuntimeError('Empty patch section')
        output.extend(old[cursor:])
        result[name] = ''.join(output).encode('utf8')
    if set(result) != set(PATCH_FILES):
        raise RuntimeError('Missing expected patch files')
    return result


def prepare(patch_only=False):
    archive = CACHE / 'node-v24.22.1.tar.xz'
    if not archive.exists():
        archive = LEGACY / 'node-v24.22.1.tar.xz'
    with archive.open('rb') as source:
        if hashlib.file_digest(source, 'sha256').hexdigest() != ARCHIVE_SHA:
            raise RuntimeError('Official Node archive SHA256 mismatch')
    patch = PATCH_SOURCE.read_bytes().replace(b'\r\n', b'\n')
    header = HEADER_SOURCE.read_bytes()
    if header.startswith(b'\xef\xbb\xbf') or b'\r' in header:
        raise RuntimeError('Canonical client must be UTF8 without BOM, with LF newlines')
    header.decode('utf8')
    source = CACHE / SOURCE_NAME
    cursor = CACHE
    while cursor != ROOT:
        if cursor.exists() and (cursor.is_symlink() or getattr(cursor.lstat(), 'st_file_attributes', 0) & 0x400):
            raise RuntimeError('Candidate cache traverses a reparse point')
        cursor = cursor.parent
    CACHE.mkdir(parents=True, exist_ok=True)
    if source.exists() and not patch_only:
        raise RuntimeError('Candidate source already exists; --patch-only validates a pristine prebuild tree')
    if patch_only and not source.is_dir():
        raise RuntimeError('--patch-only requires an existing candidate source tree')
    if source.exists() and (source.is_symlink() or getattr(source.lstat(), 'st_file_attributes', 0) & 0x400):
        raise RuntimeError('Candidate source is a reparse point')
    originals = {}
    expected = {}
    official_inventory = []
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        names = set()
        for member in members:
            path = PurePosixPath(member.name)
            if member.name in names or path.is_absolute() or '..' in path.parts or path.parts[0] != SOURCE_NAME or not (member.isfile() or member.isdir()):
                raise RuntimeError('Unexpected official archive member')
            names.add(member.name)
        for name in PATCH_FILES:
            originals[name] = tar.extractfile(SOURCE_NAME + '/' + name).read()
        patched = apply_closed_patch(originals, patch)
        files = [member for member in members if member.isfile()]
        if len(files) != 33486:
            raise RuntimeError('Official source file count changed')
        for member in files:
            name = member.name[len(SOURCE_NAME) + 1:]
            data = tar.extractfile(member).read()
            official_inventory.append([name, digest(data)])
            expected[name] = digest(patched.get(name, data))
        if not patch_only:
            tar.extractall(CACHE, filter='data')
    expected[HEADER_TARGET] = digest(header)
    actual = set()
    for entry in source.rglob('*'):
        if entry.is_symlink() or getattr(entry.lstat(), 'st_file_attributes', 0) & 0x400:
            raise RuntimeError('Source tree contains a reparse point')
        if entry.is_file(): actual.add(entry.relative_to(source).as_posix())
        elif not entry.is_dir(): raise RuntimeError('Source tree contains a nonordinary entry')
    if actual - set(expected) or (set(expected) - actual) - {HEADER_TARGET}:
        raise RuntimeError('Source tree has missing or additional files; build outputs are not accepted inputs')
    for name, checksum in expected.items():
        target = source / name
        if target.exists():
            if target.stat().st_nlink != 1 or digest(target.read_bytes()) not in (checksum, digest(originals[name]) if name in originals else checksum):
                raise RuntimeError('Unexpected source modification: ' + name)
    for name in (*PATCH_FILES, HEADER_TARGET):
        (source / name).write_bytes(header if name == HEADER_TARGET else patched[name])
    full_inventory = sorted(expected.items())
    report = {
        'schemaVersion': 2, 'nodeVersion': '24.22.1', 'modules': '137',
        'canonicalMetadataProtocol': 1,
        'windowsJsRealpathAncestorFallback': 1,
        'archive': {'url': 'https://nodejs.org/dist/v24.22.1/node-v24.22.1.tar.xz', 'sha256': ARCHIVE_SHA,
                    'ordinaryFiles': len(official_inventory), 'inventorySha256': digest(json.dumps(sorted(official_inventory), separators=(',', ':')).encode())},
        'patch': {'path': 'scripts/private-node/libuv-appcontainer.patch', 'sha256': digest(PATCH_SOURCE.read_bytes()),
                  'normalizedUtf8Sha256': digest(patch), 'files': list(PATCH_FILES)},
        'header': {'source': HEADER_SOURCE.relative_to(ROOT).as_posix(), 'sha256': digest(header), 'onlyAddedPath': HEADER_TARGET},
        'changes': [{'path': name, 'before': digest(originals[name]), 'after': expected[name]} for name in PATCH_FILES],
        'prepared': {'ordinaryFiles': len(full_inventory), 'inventorySha256': digest(json.dumps(full_inventory, separators=(',', ':')).encode())},
        'legacyCacheChanged': False,
    }
    (CACHE / 'source-manifest.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8', newline='\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--patch-only', action='store_true')
    print(json.dumps(prepare(parser.parse_args().patch_only), indent=2))
