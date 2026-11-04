"""The engine folder the person chose in the app (STRATA_ENGINE_DIR) is the engine folder, exactly like <components>/engine."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from strata_control import engine_component as ec, updater


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


if __name__ == "__main__":
    unittest.main()
