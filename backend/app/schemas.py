from decimal import Decimal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator


class Credentials(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class UserResponse(BaseModel):
    email: EmailStr
    role: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


class VehicleCreate(BaseModel):
    make: str = Field(min_length=1, max_length=80)
    model: str = Field(min_length=1, max_length=80)
    category: str = Field(min_length=1, max_length=80)
    price: Decimal = Field(gt=0, le=100_000_000, max_digits=12, decimal_places=2)
    quantity: int = Field(ge=0, le=1_000_000)


class VehicleUpdate(BaseModel):
    make: str | None = Field(default=None, min_length=1, max_length=80)
    model: str | None = Field(default=None, min_length=1, max_length=80)
    category: str | None = Field(default=None, min_length=1, max_length=80)
    price: Decimal | None = Field(
        default=None, gt=0, le=100_000_000, max_digits=12, decimal_places=2
    )
    quantity: int | None = Field(default=None, ge=0, le=1_000_000)

    @model_validator(mode="after")
    def reject_explicit_null_values(self):
        if any(getattr(self, field) is None for field in self.model_fields_set):
            raise ValueError("Updated vehicle fields cannot be null")
        return self


class VehicleResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    make: str
    model: str
    category: str
    price: float
    quantity: int


class RestockRequest(BaseModel):
    quantity: int = Field(gt=0, le=1_000_000)
