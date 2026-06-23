"""Path-traversal hardening for LocalStorage (pre-public security audit).

LocalStorage joins caller-supplied filenames/urls under upload_dir; a value
like "../../etc/x" or one with a leading "/" must not escape the upload root.
"""
import pytest

from app.services.storage import LocalStorage


def test_localstorage_allows_legit_paths(tmp_path):
    s = LocalStorage(str(tmp_path))
    url = s.save("abc.jpg", b"hello")
    assert url == "/static/abc.jpg"
    assert s.exists("/static/abc.jpg") is True
    assert s.read("/static/abc.jpg") == b"hello"
    assert s.delete("/static/abc.jpg") is True


def test_localstorage_blocks_traversal_on_save(tmp_path):
    s = LocalStorage(str(tmp_path))
    with pytest.raises(FileNotFoundError):
        s.save("../../evil.txt", b"x")
    with pytest.raises(FileNotFoundError):
        s.save("/etc/evil.txt", b"x")


def test_localstorage_blocks_traversal_on_read(tmp_path):
    s = LocalStorage(str(tmp_path))
    with pytest.raises(FileNotFoundError):
        s.read("/static/../../../etc/passwd")
    with pytest.raises(FileNotFoundError):
        s.read("../../../etc/passwd")


def test_localstorage_exists_false_on_traversal(tmp_path):
    s = LocalStorage(str(tmp_path))
    assert s.exists("/static/../../../etc/passwd") is False
    assert s.exists("../../../etc/passwd") is False
