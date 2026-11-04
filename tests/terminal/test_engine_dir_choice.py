"""The engine folder the person chose in the app (STRATA_ENGINE_DIR) is the engine folder, exactly like <components>/engine."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from strata_control import engine_component as ec, updater
from tests.terminal.test_engine_component import make_package


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


if __name__ == "__main__":
    unittest.main()
