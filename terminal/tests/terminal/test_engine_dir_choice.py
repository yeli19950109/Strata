"""The engine folder the person chose in the app (STRATA_ENGINE_DIR) is the engine folder, exactly like <components>/engine."""
import os
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from strata_control import engine_component as ec, updater
from tests.terminal.test_engine_component import make_package
from tests.terminal.test_updater import UpdaterCase
from tests.terminal import update_fixture as fx


class EngineDirChoice(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))

    def test_engine_dir_follows_the_chosen_folder(self):
        components, chosen = self.tmp / "components", self.tmp / "my engines"
        with mock.patch.dict(os.environ, {ec.ENV_DIR: str(components)}):
            os.environ.pop(ec.ENV_ENGINE_DIR, None)
            self.assertEqual(ec.engine_dir(), components / "engine")
            os.environ[ec.ENV_ENGINE_DIR] = str(chosen)
            self.assertEqual(ec.engine_dir(), chosen)
            self.assertEqual(ec.engine_dir(components), chosen)      # the person's own component folder: updates and rollbacks land there too
            self.assertEqual(ec.engine_dir(self.tmp / "stage"), self.tmp / "stage" / "engine")   # an update's staging folder keeps its own

    def test_staged_test_start_does_not_see_the_chosen_folder(self):
        with mock.patch.dict(os.environ, {ec.ENV_ENGINE_DIR: str(self.tmp / "mine")}):
            with updater._patched_environ({ec.ENV_DIR: str(self.tmp / "stage"), ec.ENV_ENGINE_DIR: None}):
                self.assertEqual(ec.engine_dir(), self.tmp / "stage" / "engine")
            self.assertEqual(ec.engine_dir(None), self.tmp / "mine")

    def test_a_chosen_folder_that_is_one_package_lists_only_that_package(self):
        # A source checkout: Strata/engine is one engine package with its own rocm/bin; Strata itself holds tools, tests and so on.
        own = self.tmp / "checkout" / "engine"
        own.parent.mkdir()
        make_package(self.tmp / "a", version="0.1.56").rename(own)
        (own / "rocm" / "bin").mkdir(parents=True)
        staged = make_package(self.tmp / "b", version="0.1.57")
        newer = own / staged.name                                   # what an update puts beside its files
        staged.rename(newer)
        with mock.patch.dict(os.environ, {ec.ENV_DIR: str(self.tmp / "components"), ec.ENV_ENGINE_DIR: str(own)}):
            found, problems = ec.scan()
            self.assertEqual(sorted(item.root for item in found), sorted([own, newer]))
            self.assertEqual(problems, [], "the package's own folders are not broken packages")
            self.assertEqual(updater.prune_engines(self.tmp / "components", keep=set()), [newer.name])
            self.assertTrue((own / "rocm" / "bin").is_dir(), "an update never removes the package's own folders")

    def test_chosen_package_respects_requested_component_family(self):
        own = self.tmp / "chosen"
        make_package(self.tmp / "a", version="0.1.69").rename(own)
        with mock.patch.dict(os.environ, {ec.ENV_ENGINE_DIR: str(own)}):
            found, problems = ec.scan(component_id="strata-hy4")
            self.assertEqual(found, [], "a Qwen package must not be offered as a shape engine")
            self.assertEqual(len(problems), 1)



class ChosenPackageRollback(UpdaterCase):
    def _run_config(self):
        # No tokenizer/runtime is exercised by the mocked smoke start below.
        tokenizer = self.root / "tokenizer"
        tokenizer.mkdir()
        self.config = self.root / "run.json"
        self.config.write_text(json.dumps({"exe": "/old/engine", "backend": self.family["backend"],
            "tokenizer": str(tokenizer), "args": [], "cwd": str(self.root), "host": "127.0.0.1", "port": 0}))

    def test_signed_update_and_rollback_to_the_chosen_root_package(self):
        original = self.install_current("0.1.45")
        chosen = self.root / "external-engine"
        original.rename(chosen)
        with mock.patch.dict(os.environ, {ec.ENV_ENGINE_DIR: str(chosen)}):
            self.publish(("0.1.46", fx.GOOD_ENGINE))
            # Exercise signed download, verification, install, pin and rollback;
            # the GPU/runtime smoke is a fixture, not a real hardware claim.
            ctx = self.ctx(test_start=lambda *_: {"mode": "full"})
            result = updater.run_update(ctx, control=False)
            self.assertEqual(result["exit_code"], 0, result)
            self.assertEqual(self.resolved(), "0.1.46")
            self.assertEqual(ec.previous_folder(self.components), chosen.name)
            restored = updater.rollback_engine(ctx)
            self.assertEqual(restored["to"], "0.1.45")
            self.assertEqual(ec.resolve(self.components, backend=self.family["backend"], full=True).root, chosen)
            self.assertTrue((chosen / ec.MANIFEST).is_file())
            self.assertTrue(any(p.is_dir() for p in chosen.iterdir()), "the newer package stays beside the original")
            forward = updater.rollback_engine(ctx)
            self.assertEqual(forward["to"], "0.1.46")



if __name__ == "__main__":
    unittest.main()
