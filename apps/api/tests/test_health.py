from fastapi.testclient import TestClient

from fieldquote import __version__


def test_health_ok(client: TestClient) -> None:
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "version": __version__}
