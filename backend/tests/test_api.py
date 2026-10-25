from fastapi.testclient import TestClient
import pytest

from app.main import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "admin@example.com")
    monkeypatch.setenv("ADMIN_PASSWORD", "AdminPass123!")
    app = create_app(f"sqlite:///{tmp_path / 'test.db'}")
    with TestClient(app) as test_client:
        yield test_client


def register(client, email="buyer@example.com", password="BuyerPass123!"):
    return client.post(
        "/api/auth/register", json={"email": email, "password": password}
    )


def login(client, email, password):
    response = client.post(
        "/api/auth/login", json={"email": email, "password": password}
    )
    assert response.status_code == 200
    return response.json()["access_token"]


def create_vehicle(client, token, **overrides):
    payload = {
        "make": "Toyota",
        "model": "Corolla",
        "category": "Sedan",
        "price": 24999.99,
        "quantity": 3,
    }
    payload.update(overrides)
    return client.post(
        "/api/vehicles",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )


def test_register_login_and_protect_vehicle_inventory(client):
    assert register(client).status_code == 201
    token = login(client, "buyer@example.com", "BuyerPass123!")
    headers = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/vehicles", headers=headers).status_code == 200
    assert client.get("/api/vehicles", headers=headers).json() == []
    assert client.get("/api/vehicles", headers={}).status_code == 401


def test_register_rejects_duplicate_email_and_invalid_password(client):
    assert register(client).status_code == 201
    assert register(client).status_code == 409
    assert (
        register(client, email="short@example.com", password="short").status_code
        == 422
    )


def test_vehicle_search_filters_and_update(client):
    token = login(client, "admin@example.com", "AdminPass123!")
    created = create_vehicle(client, token)
    assert created.status_code == 201
    assert created.json()["price"] == 24999.99
    vehicle_id = created.json()["id"]

    result = client.get(
        "/api/vehicles/search?make=toyota&category=sedan&min_price=20000&max_price=30000",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert [vehicle["id"] for vehicle in result.json()] == [vehicle_id]
    assert client.get(
        "/api/vehicles/search?q=rolla",
        headers={"Authorization": f"Bearer {token}"},
    ).json()[0]["id"] == vehicle_id
    assert client.get(
        "/api/vehicles/search?make=Honda",
        headers={"Authorization": f"Bearer {token}"},
    ).json() == []

    updated = client.put(
        f"/api/vehicles/{vehicle_id}",
        json={"price": 22999.0},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert updated.status_code == 200
    assert updated.json()["price"] == 22999.0
    assert client.put(
        f"/api/vehicles/{vehicle_id}",
        json={"price": None},
        headers={"Authorization": f"Bearer {token}"},
    ).status_code == 422


def test_purchase_decrements_stock_and_rejects_out_of_stock(client):
    admin_token = login(client, "admin@example.com", "AdminPass123!")
    vehicle_id = create_vehicle(client, admin_token, quantity=1).json()["id"]
    buyer_token = register(client).json()
    assert buyer_token["email"] == "buyer@example.com"
    token = login(client, "buyer@example.com", "BuyerPass123!")
    headers = {"Authorization": f"Bearer {token}"}

    assert (
        client.post(
            f"/api/vehicles/{vehicle_id}/purchase", headers=headers
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"/api/vehicles/{vehicle_id}/purchase", headers=headers
        ).status_code
        == 409
    )
    vehicles = client.get("/api/vehicles", headers=headers).json()
    assert vehicles[0]["quantity"] == 0


def test_admin_only_delete_and_restock(client):
    admin_token = login(client, "admin@example.com", "AdminPass123!")
    vehicle_id = create_vehicle(client, admin_token, quantity=0).json()["id"]
    register(client)
    buyer_token = login(client, "buyer@example.com", "BuyerPass123!")
    buyer_headers = {"Authorization": f"Bearer {buyer_token}"}
    admin_headers = {"Authorization": f"Bearer {admin_token}"}

    assert client.post(
        f"/api/vehicles/{vehicle_id}/restock",
        json={"quantity": 2},
        headers=buyer_headers,
    ).status_code == 403
    assert client.delete(f"/api/vehicles/{vehicle_id}", headers=buyer_headers).status_code == 403
    assert client.post(
        f"/api/vehicles/{vehicle_id}/restock",
        json={"quantity": 2},
        headers=admin_headers,
    ).json()["quantity"] == 2
    assert client.delete(f"/api/vehicles/{vehicle_id}", headers=admin_headers).status_code == 204


def test_admin_cannot_be_registered_through_public_endpoint(client):
    response = register(client, "admin@example.com", "AnotherPass123!")
    assert response.status_code == 409
