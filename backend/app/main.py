import os
from contextlib import asynccontextmanager
from decimal import Decimal
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import or_, update
from sqlalchemy.orm import Session

from .database import Base, build_engine, build_session_factory, get_session
from .models import User, Vehicle
from .schemas import (
    Credentials,
    RestockRequest,
    TokenResponse,
    UserResponse,
    VehicleCreate,
    VehicleResponse,
    VehicleUpdate,
)
from .security import (
    admin_user,
    create_access_token,
    current_user,
    hash_password,
    verify_password,
)

load_dotenv(Path(__file__).resolve().parents[1] / ".env")


def create_app(database_url: str | None = None) -> FastAPI:
    app_engine = build_engine(database_url)
    session_factory = build_session_factory(app_engine)

    def request_session():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        Base.metadata.create_all(bind=app_engine)
        admin_email = os.getenv("ADMIN_EMAIL", "admin@example.com").strip().lower()
        admin_password = os.getenv("ADMIN_PASSWORD", "AdminPass123!")
        with session_factory() as session:
            if session.query(User).filter_by(email=admin_email).first() is None:
                session.add(
                    User(
                        email=admin_email,
                        password_hash=hash_password(admin_password),
                        role="admin",
                    )
                )
                session.commit()
        yield
        app_engine.dispose()

    app = FastAPI(
        title="Driveway Inventory API",
        description="Authenticated inventory and vehicle purchasing API.",
        version="1.0.0",
        lifespan=lifespan,
    )
    app.dependency_overrides[get_session] = request_session
    app.add_middleware(
        CORSMiddleware,
        allow_origins=os.getenv(
            "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
        ).split(","),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.post("/api/auth/register", response_model=UserResponse, status_code=201)
    def register(credentials: Credentials, session: Session = Depends(get_session)):
        email = str(credentials.email).lower()
        if session.query(User).filter_by(email=email).first():
            raise HTTPException(status_code=409, detail="An account with this email already exists")
        user = User(email=email, password_hash=hash_password(credentials.password), role="user")
        session.add(user)
        session.commit()
        session.refresh(user)
        return user

    @app.post("/api/auth/login", response_model=TokenResponse)
    def login(credentials: Credentials, session: Session = Depends(get_session)):
        email = str(credentials.email).lower()
        user = session.query(User).filter_by(email=email).first()
        if user is None or not verify_password(credentials.password, user.password_hash):
            raise HTTPException(status_code=401, detail="Invalid email or password")
        return {
            "access_token": create_access_token(user),
            "user": {"email": user.email, "role": user.role},
        }

    @app.get("/api/vehicles", response_model=list[VehicleResponse])
    def list_vehicles(
        _: User = Depends(current_user), session: Session = Depends(get_session)
    ):
        return session.query(Vehicle).order_by(Vehicle.id.desc()).all()

    @app.get("/api/vehicles/search", response_model=list[VehicleResponse])
    def search_vehicles(
        q: str | None = None,
        make: str | None = None,
        model: str | None = None,
        category: str | None = None,
        min_price: Decimal | None = Query(default=None, ge=0),
        max_price: Decimal | None = Query(default=None, gt=0),
        _: User = Depends(current_user),
        session: Session = Depends(get_session),
    ):
        if min_price is not None and max_price is not None and min_price > max_price:
            raise HTTPException(status_code=422, detail="min_price cannot exceed max_price")
        query = session.query(Vehicle)
        if q and q.strip():
            term = f"%{q.strip()}%"
            query = query.filter(or_(Vehicle.make.ilike(term), Vehicle.model.ilike(term)))
        for field, value in (("make", make), ("model", model), ("category", category)):
            if value and value.strip():
                column = getattr(Vehicle, field)
                query = query.filter(column.ilike(f"%{value.strip()}%"))
        if min_price is not None:
            query = query.filter(Vehicle.price >= min_price)
        if max_price is not None:
            query = query.filter(Vehicle.price <= max_price)
        return query.order_by(Vehicle.id.desc()).all()

    @app.post("/api/vehicles", response_model=VehicleResponse, status_code=201)
    def add_vehicle(
        vehicle_data: VehicleCreate,
        _: User = Depends(current_user),
        session: Session = Depends(get_session),
    ):
        vehicle = Vehicle(**vehicle_data.model_dump())
        session.add(vehicle)
        session.commit()
        session.refresh(vehicle)
        return vehicle

    @app.put("/api/vehicles/{vehicle_id}", response_model=VehicleResponse)
    def update_vehicle(
        vehicle_id: int,
        vehicle_data: VehicleUpdate,
        _: User = Depends(current_user),
        session: Session = Depends(get_session),
    ):
        vehicle = session.get(Vehicle, vehicle_id)
        if vehicle is None:
            raise HTTPException(status_code=404, detail="Vehicle not found")
        for field, value in vehicle_data.model_dump(exclude_unset=True).items():
            setattr(vehicle, field, value)
        session.commit()
        session.refresh(vehicle)
        return vehicle

    @app.delete("/api/vehicles/{vehicle_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_vehicle(
        vehicle_id: int,
        _: User = Depends(admin_user),
        session: Session = Depends(get_session),
    ):
        vehicle = session.get(Vehicle, vehicle_id)
        if vehicle is None:
            raise HTTPException(status_code=404, detail="Vehicle not found")
        session.delete(vehicle)
        session.commit()

    @app.post("/api/vehicles/{vehicle_id}/purchase", response_model=VehicleResponse)
    def purchase_vehicle(
        vehicle_id: int,
        _: User = Depends(current_user),
        session: Session = Depends(get_session),
    ):
        result = session.execute(
            update(Vehicle)
            .where(Vehicle.id == vehicle_id, Vehicle.quantity > 0)
            .values(quantity=Vehicle.quantity - 1)
            .execution_options(synchronize_session=False)
        )
        if result.rowcount == 0:
            if session.get(Vehicle, vehicle_id) is None:
                raise HTTPException(status_code=404, detail="Vehicle not found")
            raise HTTPException(status_code=409, detail="Vehicle is out of stock")
        session.commit()
        return session.get(Vehicle, vehicle_id)

    @app.post("/api/vehicles/{vehicle_id}/restock", response_model=VehicleResponse)
    def restock_vehicle(
        vehicle_id: int,
        request: RestockRequest,
        _: User = Depends(admin_user),
        session: Session = Depends(get_session),
    ):
        result = session.execute(
            update(Vehicle)
            .where(Vehicle.id == vehicle_id)
            .values(quantity=Vehicle.quantity + request.quantity)
            .execution_options(synchronize_session=False)
        )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Vehicle not found")
        session.commit()
        return session.get(Vehicle, vehicle_id)

    return app


app = create_app()
