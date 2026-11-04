"""The engine folder the person chose in the app (STRATA_ENGINE_DIR) is the engine folder, exactly like <components>/engine."""
from pathlib import Path

from strata_control import engine_component as ec, updater


def test_engine_dir_follows_the_chosen_folder(tmp_path, monkeypatch):
    components, chosen = tmp_path / "components", tmp_path / "my engines"
    monkeypatch.setenv(ec.ENV_DIR, str(components))
    monkeypatch.delenv(ec.ENV_ENGINE_DIR, raising=False)
    assert ec.engine_dir() == components / "engine"
    monkeypatch.setenv(ec.ENV_ENGINE_DIR, str(chosen))
    assert ec.engine_dir() == chosen
    assert ec.engine_dir(components) == chosen                 # the person's own component folder: updates and rollbacks land there too
    assert ec.engine_dir(tmp_path / "stage") == tmp_path / "stage" / "engine"   # an update's staging folder keeps its own


def test_staged_test_start_does_not_see_the_chosen_folder(tmp_path, monkeypatch):
    monkeypatch.setenv(ec.ENV_ENGINE_DIR, str(tmp_path / "mine"))
    with updater._patched_environ({ec.ENV_DIR: str(tmp_path / "stage"), ec.ENV_ENGINE_DIR: None}):
        assert ec.engine_dir() == tmp_path / "stage" / "engine"
    assert ec.engine_dir(None) == Path(tmp_path / "mine")
