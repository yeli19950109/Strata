"""DeepSeek-V4.1-Flash's model id has dots ("deepseek-v4.1-flash-ist-das-2.00bpw"). The app lists installed models through Control, which
used to drop any id with a dot: the install finished and the model never appeared."""
import json
import tempfile
import unittest
from pathlib import Path

from strata_control import models


class DotInModelId(unittest.TestCase):
    def test_ids_with_a_dot_are_accepted_and_odd_ones_are_not(self):
        for good in ("deepseek-v4.1-flash-ist-das-2.00bpw", "q2_0", "qwen36-ud-q4_k_xl", "My-Model.IQ3"):
            self.assertTrue(models.MODEL_ID.fullmatch(good), good)
        for bad in ("a..b", ".a", "../x", "a/b", "K"):
            self.assertFalse(models.MODEL_ID.fullmatch(bad), bad)

    def test_a_run_config_with_a_dotted_name_is_listed(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / "strata-deepseek-v4.1-flash-ist-das-2.00bpw.json").write_text(json.dumps(
                {"exe": "/x/strata-dsv41", "tokenizer": str(folder), "args": ["--max-context", "8192"], "model_name": "deepseek-v4.1-flash"}))
            listed = models.list_installed(str(folder))
            self.assertEqual([m["id"] for m in listed["models"]], ["deepseek-v4.1-flash-ist-das-2.00bpw"])

    def test_previously_imported_mixed_case_name_is_discovered(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            path = folder / "strata-My-Model.IQ3.json"
            path.write_text(json.dumps({"exe": "/missing/strata", "tokenizer": str(folder), "args": [], "model_name": "Existing"}))
            listed = models.list_installed(str(folder))["models"]
            self.assertEqual([(m["id"], m["source_config"]) for m in listed], [("My-Model.IQ3", str(path))])


if __name__ == "__main__":
    unittest.main()
