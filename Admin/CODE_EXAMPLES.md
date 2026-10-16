# GONGO Admin Backend - Code Examples

Complete implementation examples for frontend developers.

---

## 🔐 Authentication Examples

### JavaScript - Login & OTP Verification

```javascript
// Admin Auth Service
class AdminAuthService {
  constructor(baseUrl = 'http://localhost:3001/api/v1') {
    this.baseUrl = baseUrl;
    this.token = localStorage.getItem('adminToken');
  }

  // Step 1: Send credentials, get OTP
  async login(identifier, password) {
    const response = await fetch(`${this.baseUrl}/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Login failed');
    }

    const data = await response.json();
    return {
      sessionId: data.sessionId,
      phone: data.phone,
      expiresIn: data.expiresIn
    };
  }

  // Step 2: Verify OTP, get token
  async verify2FA(sessionId, otp) {
    const response = await fetch(`${this.baseUrl}/admin/auth/verify-2fa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, otp })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'OTP verification failed');
    }

    const data = await response.json();
    this.token = data.rawToken;
    localStorage.setItem('adminToken', data.rawToken);

    return {
      token: data.rawToken,
      user: data.user,
      session: data.session
    };
  }

  // Step 3: Get current user
  async getCurrentUser() {
    const response = await fetch(`${this.baseUrl}/admin/auth/me`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });

    if (!response.ok) throw new Error('Failed to get user');
    return await response.json();
  }

  // Step 4: Logout
  async logout() {
    const response = await fetch(`${this.baseUrl}/admin/auth/logout`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}` }
    });

    if (response.ok) {
      localStorage.removeItem('adminToken');
      this.token = null;
    }
  }
}

// Usage
async function handleLogin() {
  const auth = new AdminAuthService();

  try {
    // Step 1
    const { sessionId, phone } = await auth.login(
      'admin@gongo.com',
      'password123'
    );
    console.log(`OTP sent to ${phone}`);

    // Step 2 (after user enters OTP)
    const otp = prompt('Enter OTP:');
    const { token, user } = await auth.verify2FA(sessionId, otp);
    console.log(`Welcome ${user.name}!`);

    // Step 3
    const userInfo = await auth.getCurrentUser();
    console.log('User info:', userInfo);
  } catch (err) {
    console.error('Auth error:', err.message);
  }
}
```

### React Hook - Login State Management

```javascript
import { useState } from 'react';

function useAdminAuth(baseUrl = 'http://localhost:3001/api/v1') {
  const [token, setToken] = useState(() => localStorage.getItem('adminToken'));
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const login = async (identifier, password) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${baseUrl}/admin/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || 'Login failed');
      }

      return await response.json();
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const verify2FA = async (sessionId, otp) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${baseUrl}/admin/auth/verify-2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, otp })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || 'OTP verification failed');
      }

      const data = await response.json();
      setToken(data.rawToken);
      setUser(data.user);
      localStorage.setItem('adminToken', data.rawToken);

      return data;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    if (!token) return;

    try {
      await fetch(`${baseUrl}/admin/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } finally {
      setToken(null);
      setUser(null);
      localStorage.removeItem('adminToken');
    }
  };

  return { token, user, loading, error, login, verify2FA, logout };
}

// Usage in component
export function LoginPage() {
  const { token, login, verify2FA, error, loading } = useAdminAuth();
  const [step, setStep] = useState('login'); // 'login' | 'otp'
  const [sessionId, setSessionId] = useState('');
  const [phone, setPhone] = useState('');

  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      const { sessionId, phone } = await login(
        e.target.email.value,
        e.target.password.value
      );
      setSessionId(sessionId);
      setPhone(phone);
      setStep('otp');
    } catch (err) {
      // Error handled by hook
    }
  };

  const handleOTP = async (e) => {
    e.preventDefault();
    try {
      await verify2FA(sessionId, e.target.otp.value);
      // Redirect to dashboard
      window.location.href = '/dashboard';
    } catch (err) {
      // Error handled by hook
    }
  };

  if (token) return <Navigate to="/dashboard" />;

  return (
    <div>
      {error && <div className="alert">{error}</div>}

      {step === 'login' && (
        <form onSubmit={handleLogin}>
          <input type="email" name="email" placeholder="Email" required />
          <input type="password" name="password" placeholder="Password" required />
          <button disabled={loading}>{loading ? 'Loading...' : 'Login'}</button>
        </form>
      )}

      {step === 'otp' && (
        <form onSubmit={handleOTP}>
          <p>OTP sent to {phone}</p>
          <input type="text" name="otp" placeholder="Enter 6-digit OTP" required />
          <button disabled={loading}>{loading ? 'Verifying...' : 'Verify'}</button>
        </form>
      )}
    </div>
  );
}
```

### Axios with Interceptors

```javascript
import axios from 'axios';

// Create API instance
const api = axios.create({
  baseURL: 'http://localhost:3001/api/v1',
  timeout: 10000
});

// Request interceptor - add token
api.interceptors.request.use(config => {
  const token = localStorage.getItem('adminToken');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor - handle errors
api.interceptors.response.use(
  response => response.data,
  error => {
    // Handle 401 - redirect to login
    if (error.response?.status === 401) {
      localStorage.removeItem('adminToken');
      window.location.href = '/login';
    }

    // Extract error message
    const message = error.response?.data?.error?.message || error.message;
    return Promise.reject(new Error(message));
  }
);

export default api;

// Usage
import api from './api';

async function loadDashboard() {
  try {
    const data = await api.get('/admin/dashboard');
    console.log(data);
  } catch (err) {
    console.error(err.message);
  }
}
```

---

## 📊 Dashboard Examples

### Fetch Dashboard Data

```javascript
async function loadDashboard() {
  const token = localStorage.getItem('adminToken');

  try {
    // Load all dashboard data in parallel
    const [overview, stats, revenue, alerts] = await Promise.all([
      fetch(`${API}/admin/dashboard`, {
        headers: { 'Authorization': `Bearer ${token}` }
      }).then(r => r.json()),

      fetch(`${API}/admin/dashboard/stats`, {
        headers: { 'Authorization': `Bearer ${token}` }
      }).then(r => r.json()),

      fetch(`${API}/admin/dashboard/revenue`, {
        headers: { 'Authorization': `Bearer ${token}` }
      }).then(r => r.json()),

      fetch(`${API}/admin/dashboard/urgent-alerts`, {
        headers: { 'Authorization': `Bearer ${token}` }
      }).then(r => r.json())
    ]);

    return { overview, stats, revenue, alerts };
  } catch (err) {
    console.error('Failed to load dashboard:', err);
    throw err;
  }
}

// Display dashboard
async function renderDashboard() {
  const dashboard = await loadDashboard();

  document.getElementById('totalBookings').textContent = 
    dashboard.overview.totalBookings;

  document.getElementById('totalRevenue').textContent = 
    `₹${dashboard.revenue.totalRevenue.toLocaleString()}`;

  document.getElementById('completionRate').textContent = 
    `${dashboard.stats.bookings.completionRate}%`;

  document.getElementById('pendingKYC').textContent = 
    dashboard.alerts.pendingKYC;
}
```

---

## 👥 Partner Management Examples

### List Partners with Pagination

```javascript
class PartnerAPI {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async listPartners(page = 1, limit = 20, filters = {}) {
    const params = new URLSearchParams({
      page,
      limit,
      ...filters
    });

    const response = await fetch(
      `${this.baseUrl}/admin/partners?${params}`,
      { headers: { 'Authorization': `Bearer ${this.token}` } }
    );

    if (!response.ok) throw new Error('Failed to fetch partners');
    return await response.json();
  }

  async getPartner(id) {
    const response = await fetch(
      `${this.baseUrl}/admin/partners/${id}`,
      { headers: { 'Authorization': `Bearer ${this.token}` } }
    );

    if (!response.ok) throw new Error('Partner not found');
    return await response.json();
  }

  async updatePartner(id, data) {
    const response = await fetch(
      `${this.baseUrl}/admin/partners/${id}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify(data)
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message);
    }

    return await response.json();
  }

  async suspendPartner(id, reason) {
    return this.updatePartner(id, { status: 'SUSPENDED', reason });
  }

  async activatePartner(id) {
    return this.updatePartner(id, { status: 'ACTIVE' });
  }
}

// React component
function PartnersList() {
  const [partners, setPartners] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const api = new PartnerAPI(API_URL, token);

  useEffect(() => {
    loadPartners();
  }, [page]);

  async function loadPartners() {
    try {
      const { data, pagination } = await api.listPartners(page, 20);
      setPartners(data);
      setTotal(pagination.total);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleSuspend(partnerId) {
    if (confirm('Suspend this partner?')) {
      try {
        await api.suspendPartner(partnerId, 'Suspended by admin');
        loadPartners();
      } catch (err) {
        alert(err.message);
      }
    }
  }

  return (
    <div>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Vehicles</th>
            <th>Earnings</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {partners.map(p => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.status}</td>
              <td>{p.vehicles}</td>
              <td>₹{p.totalEarnings.toLocaleString()}</td>
              <td>
                <button onClick={() => handleSuspend(p.id)}>Suspend</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pagination">
        <button onClick={() => setPage(page - 1)} disabled={page === 1}>
          Previous
        </button>
        <span>Page {page} of {Math.ceil(total / 20)}</span>
        <button onClick={() => setPage(page + 1)} disabled={page * 20 >= total}>
          Next
        </button>
      </div>
    </div>
  );
}
```

---

## 📅 Booking Management Examples

### List and Filter Bookings

```javascript
const [bookings, setBookings] = useState([]);
const [filters, setFilters] = useState({
  status: 'ALL',
  dateFrom: '',
  dateTo: ''
});

async function loadBookings() {
  const params = {
    page: 1,
    limit: 20
  };

  if (filters.status !== 'ALL') params.status = filters.status;
  if (filters.dateFrom) params.dateFrom = filters.dateFrom;
  if (filters.dateTo) params.dateTo = filters.dateTo;

  const query = new URLSearchParams(params);

  const response = await fetch(
    `${API}/admin/bookings?${query}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  const { data } = await response.json();
  setBookings(data);
}

// Cancel Booking
async function cancelBooking(bookingId) {
  const response = await fetch(
    `${API}/admin/bookings/${bookingId}/cancel`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        reason: 'Admin cancellation'
      })
    }
  );

  if (response.ok) {
    alert('Booking cancelled');
    loadBookings();
  } else {
    const error = await response.json();
    alert(error.error?.message);
  }
}
```

---

## ✅ KYC Verification Examples

### Approve/Reject Verification

```javascript
class VerificationAPI {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async listPending() {
    const response = await fetch(
      `${this.baseUrl}/admin/verifications?status=PENDING`,
      { headers: { 'Authorization': `Bearer ${this.token}` } }
    );
    return await response.json();
  }

  async approve(verificationId, notes = '') {
    const response = await fetch(
      `${this.baseUrl}/admin/verifications/${verificationId}/approve`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ notes })
      }
    );

    if (!response.ok) throw new Error('Approval failed');
    return await response.json();
  }

  async reject(verificationId, reason, rejectionReason) {
    const response = await fetch(
      `${this.baseUrl}/admin/verifications/${verificationId}/reject`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ reason, rejectionReason })
      }
    );

    if (!response.ok) throw new Error('Rejection failed');
    return await response.json();
  }
}

// React component
function VerificationQueue() {
  const [items, setItems] = useState([]);
  const api = new VerificationAPI(API_URL, token);

  useEffect(() => {
    api.listPending().then(data => setItems(data.data));
  }, []);

  async function handleApprove(id) {
    try {
      await api.approve(id, 'Document verified');
      alert('Approved!');
      setItems(items.filter(item => item.id !== id));
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleReject(id) {
    try {
      await api.reject(
        id,
        'Document not clear',
        'LOW_IMAGE_QUALITY'
      );
      alert('Rejected!');
      setItems(items.filter(item => item.id !== id));
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div>
      {items.map(item => (
        <div key={item.id} className="verification-card">
          <h3>{item.document}</h3>
          <p>Submitted: {new Date(item.submittedAt).toLocaleDateString()}</p>
          <div className="document-preview">
            {item.documents.map(doc => (
              <img key={doc.type} src={doc.url} alt={doc.type} />
            ))}
          </div>
          <div className="actions">
            <button onClick={() => handleApprove(item.id)} className="btn-success">
              Approve
            </button>
            <button onClick={() => handleReject(item.id)} className="btn-danger">
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
```

---

## 💰 Payment Examples

### Process Payout

```javascript
async function triggerPayout(amount) {
  const response = await fetch(
    `${API}/admin/payouts`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        amount,
        scheduledDate: new Date().toISOString().split('T')[0]
      })
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message);
  }

  const data = await response.json();
  console.log('Payout created:', data);
  return data;
}

// Get payout details
async function getPayoutStatus(payoutId) {
  const response = await fetch(
    `${API}/admin/payouts/${payoutId}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  return await response.json();
}
```

---

## 📤 File Upload Examples

### Upload Document

```javascript
async function uploadDocument(file) {
  // Step 1: Get presigned upload URL
  const urlResponse = await fetch(
    `${API}/admin/storage/upload-url`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        fileName: file.name,
        contentType: file.type,
        bucket: 'gongo-uploads'
      })
    }
  );

  const { uploadUrl, path } = await urlResponse.json();

  // Step 2: Upload to presigned URL
  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file
  });

  if (!uploadResponse.ok) throw new Error('Upload failed');

  return path;
}

// React file input handler
function FileUploadInput() {
  const [uploading, setUploading] = useState(false);

  async function handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;

    setUploading(true);
    try {
      const path = await uploadDocument(file);
      console.log('Uploaded to:', path);
    } catch (err) {
      alert(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <input
      type="file"
      onChange={handleFileChange}
      disabled={uploading}
    />
  );
}
```

---

## 🔄 Error Handling Pattern

```javascript
class APIError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function apiRequest(method, endpoint, data = null) {
  const token = localStorage.getItem('adminToken');

  try {
    const response = await fetch(`${API}${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: data ? JSON.stringify(data) : null
    });

    const responseData = await response.json();

    if (!response.ok) {
      throw new APIError(
        responseData.error?.message || 'API Error',
        responseData.error?.code || 'UNKNOWN',
        response.status
      );
    }

    return responseData;
  } catch (err) {
    if (err instanceof APIError) {
      // Handle API errors
      if (err.status === 401) {
        // Redirect to login
        window.location.href = '/login';
      } else if (err.status === 429) {
        // Handle rate limiting
        console.warn('Rate limited:', err.message);
      } else if (err.status === 403) {
        // Handle permission errors
        alert('You do not have permission for this action');
      }
    }
    throw err;
  }
}
```

---

**Last Updated:** January 2024
