"""Fork regressions: engine package roots and imported run config paths."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TERMINAL = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(TERMINAL))
from strata_control import cfg_paths, control_paths, profiles, runtime  # noqa: E402


class ForkConfigPaths(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        self.components = self.root / "components"
        self.default_engine = self.components / "engine"
        self.external_engine = self.root / "Selected Engine Packages"
        env = patch.dict(os.environ, {
            "STRATA_COMPONENTS_DIR": str(self.components),
            "STRATA_PROFILE_DIR": str(self.root / "profiles"),
            "STRATA_RUNTIME_DIR": str(self.root / "runtime"),
            "STRATA_ENGINE_DIR": str(self.external_engine),
        })
        env.start()
        self.addCleanup(env.stop)

    def package(self, root, version, kind="windows-x86_64-hip-rx9070"):
        path = root / f"{version}-{kind}"
        path.mkdir(parents=True)
        (path / "strata.exe").touch()
        (path / "rocm" / "bin").mkdir(parents=True)
        return path

    def config(self, old, **fields):
        cfg = {
            "exe": str(old / "strata.exe"),
            "lib_dirs": [str(old / "rocm" / "bin")],
            "tokenizer": str(self.root / "tokenizer.json"),
            "args": ["--native", str(self.root / "user model.gguf")],
            **fields,
        }
        path = self.root / "strata-test.json"
        path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
        return path, cfg

    def test_stale_selected_package_is_repaired_at_start_in_selected_root(self):
        expected = self.package(self.external_engine, "0.1.66")
        self.package(self.external_engine, "0.1.99", "windows-x86_64-cuda")
        self.package(self.default_engine, "0.1.99")
        old = self.external_engine / "0.1.44-windows-x86_64-hip-rx9070"
        path, cfg = self.config(old)
        before = path.read_bytes()
        resolved = {**cfg, "exe": str(expected / "strata.exe"), "lib_dirs": [str(expected / "rocm" / "bin")]}
        self.assertEqual(profiles.read_run_config(path), resolved)
        self.assertEqual(path.read_bytes(), before)
        profiles.create("test", str(path))
        old_digest, new_digest = runtime._repair_config_paths("test")
        self.assertIsNotNone(old_digest)
        self.assertIsNotNone(new_digest)
        self.assertNotEqual(old_digest, new_digest)
        self.assertEqual(json.loads(path.read_bytes()), resolved)
        self.assertEqual(runtime._repair_config_paths("test"), (None, None))

    def test_stale_default_package_follows_selection_and_defaults_still_work(self):
        selected = self.package(self.external_engine, "0.1.66")
        default = self.package(self.default_engine, "0.1.65")
        path, _ = self.config(self.default_engine / "0.1.44-windows-x86_64-hip-rx9070")
        self.assertEqual(profiles.read_run_config(path)["exe"], str(selected / "strata.exe"))
        with patch.dict(os.environ, {"STRATA_ENGINE_DIR": ""}):
            notes, problems = cfg_paths.repair([path])
            self.assertEqual(len(notes), 1)
            self.assertFalse(problems)
            self.assertEqual(json.loads(path.read_bytes())["exe"], str(default / "strata.exe"))

    def test_existing_version_and_unrelated_component_lookalike_are_unchanged(self):
        self.package(self.external_engine, "0.1.66")
        existing = self.package(self.external_engine, "0.1.44")
        unrelated = self.root / "other" / "components" / "engine" / existing.name
        path, cfg = self.config(existing, vision={"exe": str(unrelated / "strata.exe")})
        before = path.read_bytes()
        self.assertEqual(profiles.read_run_config(path), cfg)
        self.assertEqual(cfg_paths.repair([path]), ([], []))
        self.assertEqual(path.read_bytes(), before)

    def test_imported_absolute_paths_are_not_repointed_even_under_managed_roots(self):
        self.package(self.external_engine, "0.1.66")
        control = self.components / "control" / "0.1.66"
        (control / "data").mkdir(parents=True)
        (control / "data" / "expert-profile.bin").touch()
        stale_control = self.components / "control" / "0.1.44"
        stale_engine = self.external_engine / "0.1.44-windows-x86_64-hip-rx9070"
        path, cfg = self.config(stale_engine, ui_imported=True, cwd=str(stale_control),
                                tokenizer=r"Y:\Strata-data\packs\demo\tokenizer",
                                args=["--native", r"Y:\Strata-data\models\demo.gguf",
                                      "--expert-profile", str(stale_control / "data" / "expert-profile.bin")])
        before = path.read_bytes()
        self.assertEqual(profiles.read_run_config(path), cfg)
        self.assertEqual(cfg_paths.repair([path]), ([], []))
        profiles.create("test", str(path))
        self.assertEqual(runtime._repair_config_paths("test"), (None, None))
        self.assertEqual(path.read_bytes(), before)

    def test_current_source_control_uses_terminal_data_and_serve_paths(self):
        root = control_paths.this_control()
        self.assertEqual(root, TERMINAL)
        expert_profile = root / "data" / "expert-profile.bin"
        self.assertTrue(expert_profile.is_file())
        self.assertTrue((TERMINAL / "serve" / "server.py").is_file())
        path, cfg = self.config(self.external_engine / "manual", cwd=str(TERMINAL),
                                args=["--expert-profile", str(expert_profile)])
        self.assertEqual(profiles.read_run_config(path), cfg)
        self.assertEqual(cfg_paths.repair([path]), ([], []))


if __name__ == "__main__":
    unittest.main()
