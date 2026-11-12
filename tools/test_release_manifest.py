"""The release manifest (docs/data/release.json) and the pages that quote it."""
import copy
import os
import sys
import unittest
from unittest.mock import patch
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import release_manifest as rm  # noqa: E402


class ReleaseManifest(unittest.TestCase):
    def test_current_pages_agree_with_the_manifest(self):
        problems = rm.check(rm.load())
        self.assertEqual(problems, [], "\n".join(problems))

    def test_old_installer_names_are_found_and_rewritten(self):
        m = rm.load()
        old = "run `Strata-0.2.9-windows-x64-setup.exe` or Strata-0.2.9-linux-x86_64.AppImage.sig"
        self.assertEqual(len(rm.INSTALLER_RE.findall(old)), 2)
        fixed = rm.INSTALLER_RE.sub(lambda x: x.group(0).replace(x.group(1), m["product_version"], 1), old)
        self.assertNotIn("0.2.9", fixed)
        self.assertIn("Strata-%s-linux-x86_64.AppImage.sig" % m["product_version"], fixed)

    def test_version_lines_are_rewritten_and_a_second_pass_changes_nothing(self):
        m = rm.load()
        page, regex, keys = [r for r in rm.LINES if r[0] == "AGENTS.md"][0]
        text = "Version 0.2.5, engine 0.1.50. The public model families"
        source = rm.page_manifest(page, m)
        once = rm.rewrite(text, regex, keys, source)
        self.assertEqual(once, "Version %s, engine %s. The public model families" % (source["product_version"], source["engine_version"]))
        self.assertEqual(rm.rewrite(once, regex, keys, source), once)

    def test_a_drifting_manifest_is_reported(self):
        m = copy.deepcopy(rm.load())
        m["product_version"] = "0.2.99"
        m["tag"] = "v0.2.99"
        m.pop("fork_version", None)
        m.pop("terminal_version", None)                             # the Terminal then has to say the product version
        problems = "\n".join(rm.check(m))
        self.assertIn("strata_cli/__init__.py says", problems)
        self.assertIn("asset list has no Strata-0.2.99-windows-x64-setup.exe", problems)

    def test_a_control_only_hotfix_is_allowed_and_a_drifting_control_is_not(self):
        """0.2.13.1: the Terminal and Control are one hotfix part ahead of the app and the engines; nothing else may differ."""
        m = rm.load()
        self.assertEqual(rm.check(m), [])
        wrong = copy.deepcopy(m)
        wrong["control_version"] = m["engine_version"]              # the manifest says the hotfix is not there, the source says it is
        problems = "\n".join(rm.check(wrong))
        self.assertIn("CMakeLists.txt (Control) says", problems)
        wrong = copy.deepcopy(m)
        wrong["engine_version"] = "0.1.58"                          # engines two builds behind Control: not a hotfix
        self.assertIn("CMakeLists.txt (engine) says", "\n".join(rm.check(wrong)))
        wrong = copy.deepcopy(m)
        del wrong["terminal_version"]
        wrong.pop("fork_version", None)                           # no overrides: the Terminal must say the product version
        self.assertIn("strata_cli/__init__.py says", "\n".join(rm.check(wrong)))

    def test_fork_override_checks_app_terminal_and_agents_only(self):
        m = copy.deepcopy(rm.load())
        m["fork_version"] = "0.2.1302"
        problems = "\n".join(rm.check(m))
        for source in ("strata_cli/__init__.py", "apps/host/package.json", "apps/desktop/package.json",
                       "apps/desktop/src-tauri/Cargo.toml"):
            self.assertIn(source + " says", problems)
        self.assertIn("AGENTS.md:", problems)
        self.assertNotIn("asset list has no", problems)
        self.assertNotIn("CMakeLists.txt", problems)

    def test_upstream_without_fork_override_still_checks_hotfix_versions(self):
        m = copy.deepcopy(rm.load())
        fork = m.pop("fork_version")
        versions = rm.code_versions()
        for where, (_, key) in versions.items():
            if key in ("product_version", "terminal_version"):
                versions[where] = (m.get(key, m["product_version"]), key)
        original_read = rm.read

        def upstream_read(page):
            text = original_read(page)
            return text.replace("Version " + fork + ",", "Version " + m["product_version"] + ",") if page == "AGENTS.md" else text

        with patch.object(rm, "code_versions", return_value=versions), patch.object(rm, "read", side_effect=upstream_read):
            self.assertEqual(rm.check(m), [])
            del m["terminal_version"]
            self.assertIn("strata_cli/__init__.py says", "\n".join(rm.check(m)))

    def test_write_keeps_upstream_installers_and_fork_header(self):
        m = rm.load()
        before = copy.deepcopy(m)
        with tempfile.TemporaryDirectory() as root:
            page = Path(root) / "AGENTS.md"
            page.write_text("Version 0.2.5, engine 0.1.50.\nStrata-0.2.5-windows-x64-setup.exe\n", encoding="utf-8")
            with patch.object(rm, "ROOT", root), patch.object(rm.doc_pages, "current_pages", return_value=["AGENTS.md"]):
                self.assertEqual(rm.write(m), ["AGENTS.md"])
                result = page.read_text(encoding="utf-8")
                self.assertIn("Version " + m["fork_version"] + ", engine " + m["engine_version"], result)
                self.assertIn("Strata-" + m["product_version"] + "-windows-x64-setup.exe", result)
                self.assertNotIn("Strata-" + m["fork_version"], result)
                self.assertEqual(rm.write(m), [])
        self.assertEqual(m, before, "writing docs must not mutate upstream release facts")

    def test_invalid_fork_version_is_reported(self):
        m = rm.load()
        for value in (None, "", "0.2.13.1", 1301):
            with self.subTest(value=value):
                m["fork_version"] = value
                self.assertIn("fork_version must be", "\n".join(rm.check(m)))

    def test_installer_names_in_the_manifest_asset_list(self):
        m = rm.load()
        for name in rm.expand(m):
            self.assertIn(name, m["assets"])


if __name__ == "__main__":
    unittest.main()
