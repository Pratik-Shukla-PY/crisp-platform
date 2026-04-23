"""W6 — YAML-driven modular form framework.

Tests pin:
  - `/api/v1/modules` lists the shipped modules
  - Each module has the required top-level keys + valid field types
  - `/applicable` filter gates on crisis_type + infrastructure_type
  - 404 on unknown module id
  - `CRISP_MODULES_DIR` env-var override loads an out-of-tree module
    without touching the shipped set
  - Malformed YAML files don't crash the endpoint (operator UX)
"""
import os
import importlib
import pytest
import tempfile


VALID_FIELD_TYPES = {"single_select", "multi_select", "short_text",
                     "long_text", "integer", "yes_no"}


class TestModulesListing:
    def test_list_returns_at_least_the_livelihoods_sample(self, client):
        res = client.get("/api/v1/modules")
        assert res.status_code == 200
        body = res.json()
        assert body["count"] >= 1
        ids = {m["id"] for m in body["modules"]}
        assert "livelihoods" in ids

    def test_every_module_has_required_keys(self, client):
        body = client.get("/api/v1/modules").json()
        for m in body["modules"]:
            for k in ("id", "version", "title", "fields"):
                assert k in m, f"module missing key {k}: {m.get('id')}"
            assert isinstance(m["fields"], list) and m["fields"]

    def test_every_field_has_valid_type(self, client):
        body = client.get("/api/v1/modules").json()
        for m in body["modules"]:
            for f in m["fields"]:
                assert "key" in f
                assert f["type"] in VALID_FIELD_TYPES, (
                    f"module {m['id']}: field {f.get('key')} has invalid type "
                    f"{f.get('type')}"
                )

    def test_livelihoods_module_shape(self, client):
        body = client.get("/api/v1/modules/livelihoods").json()
        assert body["id"] == "livelihoods"
        assert body["applies_to"]["crisis_types"]
        # The module must have at least one required field (otherwise
        # nothing is gating the submit button).
        assert any(f.get("required") for f in body["fields"])

    def test_unknown_module_id_returns_404(self, client):
        res = client.get("/api/v1/modules/does-not-exist")
        assert res.status_code == 404


class TestApplicableFilter:
    def test_crisis_match_includes_livelihoods(self, client):
        body = client.get(
            "/api/v1/modules/applicable",
            params={"crisis_type": "FLOOD"},
        ).json()
        ids = {m["id"] for m in body["modules"]}
        assert "livelihoods" in ids

    def test_crisis_not_in_allowlist_excludes(self, client):
        body = client.get(
            "/api/v1/modules/applicable",
            params={"crisis_type": "PANDEMIC"},   # not in livelihoods' list
        ).json()
        ids = {m["id"] for m in body["modules"]}
        assert "livelihoods" not in ids

    def test_case_insensitive_match(self, client):
        """Clients stringify enums with wild casing — gracefully handle."""
        body = client.get(
            "/api/v1/modules/applicable",
            params={"crisis_type": "flood"},
        ).json()
        ids = {m["id"] for m in body["modules"]}
        assert "livelihoods" in ids

    def test_filter_echoed_in_response(self, client):
        body = client.get(
            "/api/v1/modules/applicable",
            params={"crisis_type": "FLOOD",
                    "infrastructure_type": "ROAD"},
        ).json()
        assert body["filters"]["crisis_type"] == "FLOOD"
        assert body["filters"]["infrastructure_type"] == "ROAD"


class TestModulesLoader:
    """Unit-level tests on the loader itself — not API-dependent."""

    def test_crisp_modules_dir_override(self, monkeypatch, tmp_path):
        """Operator-facing feature: drop modules in an out-of-tree dir
        without touching the repo. Verified by writing a throwaway
        module + setting the env var + clearing the loader cache."""
        yaml_text = (
            "id: e2e_override\n"
            "version: 1\n"
            "title: Override-dir test\n"
            "fields:\n"
            "  - key: sample\n"
            "    type: yes_no\n"
            "    label: Are you seeing this?\n"
        )
        (tmp_path / "override.yaml").write_text(yaml_text, encoding="utf-8")
        monkeypatch.setenv("CRISP_MODULES_DIR", str(tmp_path))
        from app.api.endpoints import modules as mod_api
        mod_api._load_all.cache_clear()
        out = mod_api._load_all()
        ids = {m["id"] for m in out}
        assert "e2e_override" in ids
        # Clean up: restore cache to original state for subsequent tests.
        mod_api._load_all.cache_clear()

    def test_malformed_yaml_is_skipped_not_raised(self, monkeypatch, tmp_path):
        """Operator-typo'd YAML must not take the whole /modules endpoint
        down. Loader logs and skips the bad file."""
        (tmp_path / "broken.yaml").write_text("this: is: not: valid: yaml:\n", encoding="utf-8")
        (tmp_path / "good.yaml").write_text(
            "id: good\nversion: 1\ntitle: Good\nfields:\n  - key: k\n    type: short_text\n",
            encoding="utf-8",
        )
        monkeypatch.setenv("CRISP_MODULES_DIR", str(tmp_path))
        from app.api.endpoints import modules as mod_api
        mod_api._load_all.cache_clear()
        out = mod_api._load_all()
        ids = {m["id"] for m in out}
        assert "good" in ids          # broken file dropped; good still loads
        assert "broken" not in ids
        mod_api._load_all.cache_clear()
