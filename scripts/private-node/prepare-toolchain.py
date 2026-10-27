"""仅在插件缓存准备固定工具链，不做全局安装。"""
import base64
import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / '.cache/private-node/toolchain-17.14.19.1.5'
CLANG_URL = ('https://download.visualstudio.microsoft.com/download/pr/'
             'e98d75fa-91b1-47a1-9cb7-b6556de592c5/'
             '3f4c2578467784756f3706848d8ebec3f0b1f6705c062b2be769f4138534115f/payload.vsix')
CLANG_SIZE = 2224434987
SIGNATURE_NAME = 'package/services/digital-signature/xml-signature/wt_6at5jv48snplcsvtygj66b.psdsxs'
SIGNATURE_SHA = 'c423d78ce1e6e2089ec2d29e0d6d528531cbbada036c559f70deac8d2b89f450'
TOOLSET_URL = ('https://download.visualstudio.microsoft.com/download/pr/'
               'c8fc9133-40be-4412-8403-7a2525e10208/'
               'fcf3526987fa83ef2e1d6757e7e367d0b8a1ec7e79d542967040a76ff8b9cb26/payload.vsix')
TOOLSET_SHA = 'fcf3526987fa83ef2e1d6757e7e367d0b8a1ec7e79d542967040a76ff8b9cb26'
NASM_URL = 'https://www.nasm.us/pub/nasm/releasebuilds/2.16.03/win64/nasm-2.16.03-win64.zip'
NASM_SHA = '3ee4782247bcb874378d02f7eab4e294a84d3d15f3f6ee2de2f47a46aa7226e6'
NS = {'d': 'http://www.w3.org/2000/09/xmldsig#'}
PREFIX = 'Contents/VC/Tools/Llvm/x64/'
BINS = {'clang.exe', 'clang-cl.exe', 'lld-link.exe', 'llvm-lib.exe', 'llvm-rc.exe',
        'llvm-mt.exe', 'llvm-ar.exe', 'msvcp140_2.dll', 'msvcp140_1.dll',
        'msvcp140_codecvt_ids.dll', 'msvcp140_atomic_wait.dll', 'vcruntime140_1.dll'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def get_range(start, end):
    for attempt in range(3):
        try:
            request = urllib.request.Request(CLANG_URL, headers={'Range': f'bytes={start}-{end}'})
            with urllib.request.urlopen(request, timeout=120) as response:
                if (response.status != 206 or response.headers.get('Content-Range') !=
                        f'bytes {start}-{end}/{CLANG_SIZE}'):
                    raise RuntimeError('Unexpected official VSIX range response')
                data = response.read(end - start + 2)
            if len(data) != end - start + 1:
                raise RuntimeError('Truncated official VSIX range')
            return data
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2)


class RemoteZip(io.RawIOBase):
    def __init__(self):
        self.position = 0

    def seek(self, offset, whence=0):
        self.position = (offset if whence == 0 else self.position + offset
                         if whence == 1 else CLANG_SIZE + offset)
        return self.position

    def tell(self):
        return self.position

    def readable(self):
        return True

    def seekable(self):
        return True

    def read(self, size=-1):
        if size == 0:
            return b''
        if size < 0 or size > 4 * 1024 * 1024:
            raise RuntimeError('Unexpected unbounded VSIX metadata read')
        end = min(self.position + size, CLANG_SIZE) - 1
        data = get_range(self.position, end)
        self.position += len(data)
        return data


def fixed_download(url, target, digest):
    if target.is_file() and sha(target.read_bytes()) == digest:
        return
    with urllib.request.urlopen(url, timeout=90) as response:
        data = response.read(4 * 1024 * 1024)
    if sha(data) != digest:
        raise RuntimeError(f'Pinned official tool archive digest mismatch: {url}')
    target.write_bytes(data)


def main():
    if sys.platform != 'win32':
        raise RuntimeError('This private toolchain is only for Windows x64 builds')
    CACHE.mkdir(parents=True, exist_ok=True)
    metadata = CACHE / 'metadata'
    metadata.mkdir(exist_ok=True)
    with zipfile.ZipFile(RemoteZip()) as package:
        signature_data = package.read(SIGNATURE_NAME)
        if sha(signature_data) != SIGNATURE_SHA:
            raise RuntimeError('Pinned VSIX XML signature digest mismatch')
        signature_path = metadata / Path(SIGNATURE_NAME).name
        signature_path.write_bytes(signature_data)
        signature_result = json.loads(subprocess.check_output([
            'powershell.exe', '-NoProfile', '-NonInteractive', '-File',
            str(ROOT / 'scripts/private-node/verify-vsix-signature.ps1'),
            '-Path', str(signature_path),
        ], encoding='utf8'))
        tree = ET.fromstring(signature_data)
        references = tree.findall('.//d:Object/d:Manifest/d:Reference', NS)
        digests = {}
        for reference in references:
            name = reference.attrib['URI'].split('?')[0].lstrip('/')
            if name in digests:
                raise RuntimeError('Duplicate signed VSIX file reference')
            digests[name] = base64.b64decode(reference.find('d:DigestValue', NS).text).hex()
        selected = [item for item in package.infolist() if item.filename.startswith(PREFIX) and
                    (item.filename.startswith(PREFIX + 'lib/clang/19/') or
                     item.filename.split('/')[-1] in BINS)]
    if len(selected) != 290:
        raise RuntimeError('Unexpected pinned Clang toolchain contents')
    if (len({item.filename for item in selected}) != len(selected) or
            sum(item.file_size for item in selected) > 400 * 1024 * 1024):
        raise RuntimeError('Unexpected duplicate or oversized Clang tool selection')

    def extract(item):
        name = item.filename
        if (item.file_size > 100 * 1024 * 1024 or item.compress_size > 40 * 1024 * 1024 or
                item.header_offset < 0 or
                item.header_offset + item.compress_size + 4096 > CLANG_SIZE):
            raise RuntimeError('Pinned tool ZIP entry exceeds preparation limits')
        target = CACHE / 'clang' / name[len(PREFIX):]
        digest = digests[name]
        if target.is_file() and sha(target.read_bytes()) == digest:
            return {'path': name[len(PREFIX):], 'sha256': digest, 'size': item.file_size}
        remaining = item.compress_size + 30 + len(name.encode()) + 512
        position = item.header_offset
        parts = []
        while remaining:
            length = min(4 * 1024 * 1024, remaining)
            parts.append(get_range(position, position + length - 1))
            remaining -= length
            position += length
        data = b''.join(parts)
        header = struct.unpack('<4s5H3I2H', data[:30])
        if header[0] != b'PK\x03\x04' or header[-1] > 512 or header[3] not in (0, 8):
            raise RuntimeError('Unexpected pinned ZIP entry header')
        offset = 30 + header[-2] + header[-1]
        compressed = data[offset:offset + item.compress_size]
        if header[3] == 8:
            inflater = zlib.decompressobj(-15)
            raw = inflater.decompress(compressed, item.file_size + 1)
            if not inflater.eof or inflater.unconsumed_tail:
                raise RuntimeError('Unexpected oversized or truncated ZIP deflate entry')
        else:
            raw = compressed
        if len(raw) != item.file_size or zlib.crc32(raw) != item.CRC or sha(raw) != digest:
            raise RuntimeError(f'Signed Microsoft tool file digest mismatch: {name}')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        print(f'Verified {name}', flush=True)
        return {'path': name[len(PREFIX):], 'sha256': digest, 'size': len(raw)}

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        files = list(pool.map(extract, selected))
    fixed_download(TOOLSET_URL, CACHE / 'llvm-toolset.vsix', TOOLSET_SHA)
    fixed_download(NASM_URL, CACHE / 'nasm-2.16.03-win64.zip', NASM_SHA)
    archive_files = {}
    for archive, destination in [('llvm-toolset.vsix', 'toolset'),
                                 ('nasm-2.16.03-win64.zip', 'nasm')]:
        with zipfile.ZipFile(CACHE / archive) as package:
            archive_files[destination] = []
            for item in package.infolist():
                if '..' in Path(item.filename).parts or Path(item.filename).is_absolute():
                    raise RuntimeError('Unsafe pinned tool archive path')
                if not item.is_dir():
                    archive_files[destination].append({
                        'path': destination + '/' + item.filename,
                        'sha256': sha(package.read(item)),
                    })
            package.extractall(CACHE / destination)
    report = {
        'clangVersion': '19.1.5',
        'clangPackageVersion': '17.14.36203.27',
        'clangSource': CLANG_URL,
        'clangPackageDigestNotChecked': True,
        'integrity': 'Pinned XML signature and each selected file digest; current Authenticode is checked before build',
        'signatureSha256': SIGNATURE_SHA,
        'signature': signature_result,
        'files': files,
        'toolset': {'url': TOOLSET_URL, 'sha256': TOOLSET_SHA},
        'nasm': {'version': '2.16.03', 'url': NASM_URL, 'sha256': NASM_SHA},
        'archiveFiles': archive_files,
    }
    (CACHE / 'toolchain-manifest.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    print('Private toolchain prepared; no global installation or PATH changes', flush=True)


if __name__ == '__main__':
    main()
