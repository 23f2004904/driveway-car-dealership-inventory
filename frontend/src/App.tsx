import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type User = { email: string; role: "admin" | "user" };
type Vehicle = {
  id: number;
  make: string;
  model: string;
  category: string;
  price: number;
  quantity: number;
};
type VehicleDraft = Omit<Vehicle, "id">;
type AuthResult = { access_token: string; user: User };

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
const initialDraft: VehicleDraft = {
  make: "",
  model: "",
  category: "Sedan",
  price: 0,
  quantity: 1,
};

function messageFromResponse(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object" || !("detail" in payload)) return fallback;
  const detail = payload.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) =>
        item && typeof item === "object" && "msg" in item && typeof item.msg === "string"
          ? item.msg
          : "",
      )
      .filter(Boolean)
      .join("; ") || fallback;
  }
  return fallback;
}

function isAuthResult(payload: unknown): payload is AuthResult {
  if (!payload || typeof payload !== "object" || !("access_token" in payload) || !("user" in payload)) {
    return false;
  }
  const { access_token: accessToken, user: account } = payload;
  return (
    typeof accessToken === "string" &&
    !!account &&
    typeof account === "object" &&
    "email" in account &&
    typeof account.email === "string" &&
    "role" in account &&
    (account.role === "admin" || account.role === "user")
  );
}

async function api<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(messageFromResponse(body, `Request failed (${response.status})`));
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("driveway-token") ?? "");
  const [user, setUser] = useState<User | null>(() => {
    const saved = localStorage.getItem("driveway-user");
    return saved ? (JSON.parse(saved) as User) : null;
  });
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authForm, setAuthForm] = useState({ email: "", password: "" });
  const [filters, setFilters] = useState({ query: "", category: "All types", budget: "Any price" });
  const [showVehicleForm, setShowVehicleForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<VehicleDraft>(initialDraft);
  const [busyId, setBusyId] = useState<number | null>(null);

  const refreshVehicles = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (filters.query.trim()) {
        params.set("q", filters.query.trim());
      }
      if (filters.category !== "All types") params.set("category", filters.category);
      const priceRanges: Record<string, [number, number]> = {
        "Under $25k": [0, 25000],
        "$25k – $50k": [25000, 50000],
        "$50k+": [50000, 100000000],
      };
      const range = priceRanges[filters.budget];
      if (range) {
        params.set("min_price", String(range[0]));
        params.set("max_price", String(range[1]));
      }
      const searchActive =
        Boolean(filters.query.trim()) || filters.category !== "All types" || Boolean(range);
      const result = await api<Vehicle[]>(
        searchActive ? `/api/vehicles/search?${params}` : "/api/vehicles",
        token,
      );
      setVehicles(result);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters, token]);

  useEffect(() => {
    void refreshVehicles();
  }, [refreshVehicles]);

  const categories = useMemo(
    () => ["All types", ...new Set(vehicles.map((vehicle) => vehicle.category))],
    [vehicles],
  );

  function saveSession(result: AuthResult) {
    setToken(result.access_token);
    setUser(result.user);
    localStorage.setItem("driveway-token", result.access_token);
    localStorage.setItem("driveway-user", JSON.stringify(result.user));
    setError("");
  }

  async function submitAuth(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      if (authMode === "register") {
        const response = await fetch(`${API_URL}/api/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(authForm),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(messageFromResponse(body, `Request failed (${response.status})`));
        }
      }
      const response = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(authForm),
      });
      const body = (await response.json()) as unknown;
      if (!response.ok) throw new Error(messageFromResponse(body, "Could not sign in"));
      if (!isAuthResult(body)) throw new Error("The server returned an invalid sign-in response");
      saveSession(body);
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }

  function signOut() {
    setToken("");
    setUser(null);
    setVehicles([]);
    localStorage.removeItem("driveway-token");
    localStorage.removeItem("driveway-user");
  }

  async function purchase(vehicle: Vehicle) {
    if (!token || vehicle.quantity === 0) return;
    setBusyId(vehicle.id);
    setNotice("");
    setError("");
    try {
      await api(`/api/vehicles/${vehicle.id}/purchase`, token, { method: "POST" });
      setNotice(`A ${vehicle.make} ${vehicle.model} is yours. Congratulations!`);
      await refreshVehicles();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  function startEdit(vehicle: Vehicle) {
    setEditingId(vehicle.id);
    setDraft({
      make: vehicle.make,
      model: vehicle.model,
      category: vehicle.category,
      price: vehicle.price,
      quantity: vehicle.quantity,
    });
    setShowVehicleForm(true);
  }

  async function saveVehicle(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setError("");
    try {
      await api(
        editingId ? `/api/vehicles/${editingId}` : "/api/vehicles",
        token,
        {
          method: editingId ? "PUT" : "POST",
          body: JSON.stringify(draft),
        },
      );
      setShowVehicleForm(false);
      setEditingId(null);
      setDraft(initialDraft);
      setNotice(editingId ? "Vehicle details updated." : "Vehicle added to your inventory.");
      await refreshVehicles();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }

  async function deleteVehicle(vehicle: Vehicle) {
    if (!token || !window.confirm(`Remove ${vehicle.make} ${vehicle.model} from inventory?`)) return;
    try {
      await api(`/api/vehicles/${vehicle.id}`, token, { method: "DELETE" });
      setNotice(`${vehicle.make} ${vehicle.model} was removed.`);
      await refreshVehicles();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }

  async function restock(vehicle: Vehicle) {
    const input = window.prompt(`How many ${vehicle.make} ${vehicle.model} vehicles would you like to add?`, "1");
    if (!input) return;
    const quantity = Number(input);
    if (!Number.isInteger(quantity) || quantity < 1) {
      setError("Enter a whole number greater than zero.");
      return;
    }
    try {
      await api(`/api/vehicles/${vehicle.id}/restock`, token, {
        method: "POST",
        body: JSON.stringify({ quantity }),
      });
      setNotice(`Inventory restocked by ${quantity}.`);
      await refreshVehicles();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }

  if (!token || !user) {
    return (
      <main className="auth-shell">
        <a className="brand auth-brand" href="#">
          <span className="brand-mark">d.</span> driveway
        </a>
        <section className="auth-card">
          <span className="eyebrow">YOUR NEXT CHAPTER STARTS HERE</span>
          <h1>{authMode === "login" ? "Welcome back." : "Find your way in."}</h1>
          <p className="muted">
            {authMode === "login"
              ? "Sign in to explore a better way to find your next car."
              : "Create an account and discover a car that feels like you."}
          </p>
          <form className="auth-form" onSubmit={submitAuth}>
            <label>
              Email address
              <input
                type="email"
                autoComplete="email"
                required
                value={authForm.email}
                onChange={(event) => setAuthForm({ ...authForm, email: event.target.value })}
                placeholder="you@example.com"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete={authMode === "login" ? "current-password" : "new-password"}
                minLength={8}
                required
                value={authForm.password}
                onChange={(event) => setAuthForm({ ...authForm, password: event.target.value })}
                placeholder="At least 8 characters"
              />
            </label>
            {error && <p className="alert error">{error}</p>}
            <button className="button button-primary full-width" type="submit">
              {authMode === "login" ? "Sign in" : "Create account"} <span aria-hidden="true">↗</span>
            </button>
          </form>
          <p className="switch-auth">
            {authMode === "login" ? "New to driveway?" : "Already have an account?"}{" "}
            <button
              className="text-button"
              onClick={() => {
                setAuthMode(authMode === "login" ? "register" : "login");
                setError("");
              }}
            >
              {authMode === "login" ? "Create an account" : "Sign in"}
            </button>
          </p>
          <p className="auth-footnote">Thoughtful cars. Straightforward buying. A little more you.</p>
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#">
          <span className="brand-mark">d.</span> driveway
        </a>
        <nav className="topnav">
          <a className="active" href="#inventory">Explore cars</a>
          <a href="#about">Our approach</a>
        </nav>
        <div className="account">
          <span className="account-avatar">{user.email.slice(0, 1).toUpperCase()}</span>
          <span className="account-name">{user.email.split("@")[0]}</span>
          {user.role === "admin" && <span className="admin-pill">ADMIN</span>}
          <button className="text-button sign-out" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow"><span className="sparkle">✳</span> THE GOOD KIND OF GOING PLACES</span>
            <h1>A car that feels<br />like <em>your</em> kind of ride.</h1>
            <p>Less scrolling, more feeling that first-drive feeling. Find the one that fits your life.</p>
            <a className="button button-dark" href="#inventory">Find your car <span aria-hidden="true">↓</span></a>
          </div>
          <div className="hero-art" role="img" aria-label="Illustration of a car driving on an open road">
            <div className="sun"></div>
            <div className="hill hill-back"></div>
            <div className="hill hill-front"></div>
            <div className="road"></div>
            <div className="car-illustration">
              <div className="car-roof"></div>
              <div className="car-body"></div>
              <div className="car-window"></div>
              <i className="wheel wheel-left"></i>
              <i className="wheel wheel-right"></i>
            </div>
            <span className="art-note">good things<br />are ahead</span>
          </div>
          <div className="hero-bottom"><span>GOOD CARS, GOOD ENERGY</span><span>SCROLL TO EXPLORE&nbsp; ↓</span></div>
        </section>

        <section className="inventory-section" id="inventory">
          <div className="section-heading">
            <div>
              <span className="eyebrow">THE DRIVEWAY EDIT</span>
              <h2>Find your <em>feel-good</em> car.</h2>
              <p className="muted">A few great options to get you going.</p>
            </div>
            {user.role === "admin" && (
              <button
                className="button button-primary"
                onClick={() => {
                  setEditingId(null);
                  setDraft(initialDraft);
                  setShowVehicleForm(true);
                }}
              >
                <span aria-hidden="true">＋</span> Add a car
              </button>
            )}
          </div>

          <div className="filters" aria-label="Search and filter cars">
            <label className="search-field">
              <span aria-hidden="true">⌕</span>
              <input
                value={filters.query}
                onChange={(event) => setFilters({ ...filters, query: event.target.value })}
                placeholder="Try a make or model"
                aria-label="Search by make or model"
              />
            </label>
            <label>
              <span className="sr-only">Body type</span>
              <select value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value })}>
                {categories.map((category) => <option key={category}>{category}</option>)}
              </select>
            </label>
            <label>
              <span className="sr-only">Price range</span>
              <select value={filters.budget} onChange={(event) => setFilters({ ...filters, budget: event.target.value })}>
                {["Any price", "Under $25k", "$25k – $50k", "$50k+"].map((price) => <option key={price}>{price}</option>)}
              </select>
            </label>
            <span className="result-count">{vehicles.length} {vehicles.length === 1 ? "car" : "cars"}</span>
          </div>

          {error && <p className="alert error page-alert">{error}</p>}
          {notice && <p className="alert success page-alert">{notice}</p>}

          {showVehicleForm && user.role === "admin" && (
            <form className="vehicle-form" onSubmit={saveVehicle}>
              <div className="form-heading">
                <h3>{editingId ? "Update this car" : "Add a car to the lot"}</h3>
                <button type="button" className="text-button" onClick={() => setShowVehicleForm(false)}>Close ×</button>
              </div>
              <div className="vehicle-form-grid">
                <label>Make<input required maxLength={80} value={draft.make} onChange={(event) => setDraft({ ...draft, make: event.target.value })} placeholder="e.g. Volvo" /></label>
                <label>Model<input required maxLength={80} value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="e.g. XC60" /></label>
                <label>Category<input required maxLength={80} value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} placeholder="SUV, Sedan..." /></label>
                <label>Price ($)<input required type="number" min="1" step="0.01" value={draft.price || ""} onChange={(event) => setDraft({ ...draft, price: Number(event.target.value) })} /></label>
                <label>In stock<input required type="number" min="0" step="1" value={draft.quantity} onChange={(event) => setDraft({ ...draft, quantity: Number(event.target.value) })} /></label>
              </div>
              <button className="button button-primary" type="submit">{editingId ? "Save changes" : "Add to inventory"}</button>
            </form>
          )}

          {loading ? (
            <div className="empty-state"><span className="loader"></span><p>Finding your next great drive...</p></div>
          ) : vehicles.length ? (
            <div className="vehicle-grid">
              {vehicles.map((vehicle, index) => (
                <article className="vehicle-card" key={vehicle.id}>
                  <div className={`vehicle-art vehicle-art-${index % 4}`}>
                    <span className="card-tag">{vehicle.category}</span>
                    <div className={`illustrated-car car-color-${index % 4}`}>
                      <div className="illustrated-roof"></div>
                      <div className="illustrated-body"></div>
                      <div className="illustrated-glass"></div>
                      <i className="illustrated-wheel left"></i>
                      <i className="illustrated-wheel right"></i>
                    </div>
                    <span className="art-stamp">DRIVE<br />YOUR WAY</span>
                  </div>
                  <div className="vehicle-details">
                    <div className="vehicle-title-row">
                      <div><span className="vehicle-make">{vehicle.make}</span><h3>{vehicle.model}</h3></div>
                      <span className="stock-badge">{vehicle.quantity > 0 ? `${vehicle.quantity} available` : "Just sold out"}</span>
                    </div>
                    <div className="vehicle-bottom">
                      <span className="vehicle-price">${vehicle.price.toLocaleString("en-US", { maximumFractionDigits: 0 })}<small> / one-time</small></span>
                      <button
                        className="button button-dark purchase-button"
                        disabled={vehicle.quantity === 0 || busyId === vehicle.id}
                        onClick={() => void purchase(vehicle)}
                      >
                        {busyId === vehicle.id ? "One sec..." : vehicle.quantity === 0 ? "Sold out" : "Make it yours ↗"}
                      </button>
                    </div>
                    {user.role === "admin" && (
                      <div className="admin-actions">
                        <button className="text-button" onClick={() => startEdit(vehicle)}>Edit details</button>
                        <button className="text-button" onClick={() => void restock(vehicle)}>Restock</button>
                        <button className="text-button danger-text" onClick={() => void deleteVehicle(vehicle)}>Remove</button>
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <span className="empty-icon">✳</span>
              <h3>{filters.query || filters.category !== "All types" || filters.budget !== "Any price" ? "No matches just yet." : "Your next car is still out there."}</h3>
              <p>{filters.query || filters.category !== "All types" || filters.budget !== "Any price" ? "Try adjusting your search or filters." : "Check back soon, or ask the team to add something special."}</p>
              {user.role === "admin" && !vehicles.length && (
                <button className="button button-primary" onClick={() => setShowVehicleForm(true)}>Add your first car</button>
              )}
            </div>
          )}
        </section>

        <section className="closing-banner" id="about">
          <span className="eyebrow">A BETTER WAY TO DRIVE</span>
          <h2>Good things happen<br />when you <em>go your own way.</em></h2>
          <p>Here’s to wherever you’re headed.</p>
          <span className="closing-flower">✳</span>
        </section>
      </main>
      <footer className="footer">
        <a className="brand" href="#"><span className="brand-mark">d.</span> driveway</a>
        <span>Made for the miles ahead.</span>
        <span>© 2025 Driveway Inventory</span>
      </footer>
    </div>
  );
}

export default App;
