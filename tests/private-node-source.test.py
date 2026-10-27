"""源码补丁语法回归，不构建或修改运行时。"""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('guard_prepare', Path(__file__).resolve().parents[1] / 'scripts/private-node/prepare-source.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class ClosedPatch(unittest.TestCase):
    def setUp(self):
        self.originals = {name: b'a\nb\nc\n' for name in prepare.PATCH_FILES}
        self.patch = ''.join('diff --git a/{0} b/{0}\n--- a/{0}\n+++ b/{0}\n@@ -2,1 +2,1 @@\n-b\n+B\n'.format(name) for name in prepare.PATCH_FILES).encode()

    def test_exact_allowed_file_patch(self):
        self.assertEqual(prepare.apply_closed_patch(self.originals, self.patch), {name: b'a\nB\nc\n' for name in prepare.PATCH_FILES})

    def rejected(self, patch):
        with self.assertRaises(RuntimeError): prepare.apply_closed_patch(self.originals, patch)

    def test_unknown_path(self):
        self.rejected(self.patch.replace(b'deps/uv/src/win/pipe.c', b'../../outside.c'))

    def test_missing_file(self):
        self.rejected(self.patch[:self.patch.index(b'diff --git', 1)])

    def test_duplicate_file(self):
        self.rejected(self.patch + self.patch)

    def test_wrong_line_position(self):
        self.rejected(self.patch.replace(b'@@ -2,1', b'@@ -1,1', 1))

    def test_wrong_output_position(self):
        self.rejected(self.patch.replace(b'+2,1 @@', b'+1,1 @@', 1))

    def test_wrong_count(self):
        self.rejected(self.patch.replace(b'@@ -2,1', b'@@ -2,2', 1))

    def test_context_mismatch(self):
        self.rejected(self.patch.replace(b'-b\n', b'-x\n', 1))

    def test_unclosed_trailing_data(self):
        self.rejected(self.patch + b'run arbitrary command\n')

    def test_bom_is_not_a_header(self):
        self.rejected(b'\xef\xbb\xbf' + self.patch)


if __name__ == '__main__': unittest.main()
