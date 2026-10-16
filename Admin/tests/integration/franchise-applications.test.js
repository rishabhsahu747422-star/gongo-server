'use strict';

const request = require('supertest');

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  http: jest.fn(),
}));

const userRepository = require('../../src/repositories/user.repository');
const adminSessionRepository = require('../../src/repositories/admin-session.repository');
const adminPermissionRepository = require('../../src/repositories/admin-permission.repository');
const franchiseRepository = require('../../src/repositories/franchise.repository');
const { hashSessionToken } = require('../../src/utils/crypto');
const { PERMISSIONS } = require('../../src/constants/permissions');
const { createApp } = require('../../src/app');

const app = createApp();

const SUPER_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000001',
  role: 'ADMIN',
  name: 'Super Admin',
  email: 'superadmin@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.SUPER_ADMIN],
};

const NO_PERM_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000004',
  role: 'ADMIN',
  name: 'No Perm Admin',
  email: 'noperm@gongo.in',
  is_active: true,
  permissions: [],
};
const SESSIONS = {
  superAdmin: 'a'.repeat(64),
  noPermAdmin: 'b'.repeat(64),
};

describe('Integration: Franchise Applications (Public & Admin)', () => {
  let inMemoryStore;

  beforeEach(() => {
    jest.clearAllMocks();

    inMemoryStore = [
      {
        id: 'fa-001',
        applicant_name: 'Pooja Verma',
        phone: '9822114455',
        email: 'pooja@verma.in',
        city: 'Bhopal',
        state: 'MP',
        investment_capacity: '25-50',
        business_experience: 'fleet',
        message: 'Looking to expand GONGO in MP.',
        status: 'new',
        admin_notes: null,
        reviewed_by: null,
        reviewed_at: null,
        created_at: new Date(Date.now() - 3600000).toISOString(),
        updated_at: new Date(Date.now() - 3600000).toISOString(),
      },
    ];

    const resolveSession = async (hash) => {
      const match = (tok) => hash === hashSessionToken(tok);
      let user = null;
      if (match(SESSIONS.superAdmin)) user = SUPER_ADMIN;
      else if (match(SESSIONS.noPermAdmin)) user = NO_PERM_ADMIN;

      if (!user) return null;
      return {
        id: 'sess-active',
        user_id: user.id,
        session_token: hash,
        is_active: true,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        last_active_at: new Date().toISOString(),
      };
    };

    adminSessionRepository.constructor.setMockSessionResolver({
      findByToken: resolveSession,
      findActiveByToken: resolveSession,
    });

    jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
      if (id === SUPER_ADMIN.id) return SUPER_ADMIN;
      if (id === NO_PERM_ADMIN.id) return NO_PERM_ADMIN;
      return null;
    });

    jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockImplementation(async (id) => {
      if (id === SUPER_ADMIN.id) return [PERMISSIONS.SUPER_ADMIN];
      return [];
    });

    franchiseRepository.constructor.setMockResolver({
      createApplication: async (data) => {
        const row = {
          id: `fa-${Date.now()}`,
          applicant_name: data.applicantName,
          phone: data.phone,
          email: data.email,
          city: data.city,
          state: data.state || '',
          investment_capacity: data.investmentCapacity || '25-50',
          business_experience: data.businessExperience || 'none',
          message: data.message || '',
          status: 'new',
          admin_notes: null,
          reviewed_by: null,
          reviewed_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        inMemoryStore.push(row);
        return row;
      },
      findRecentDuplicate: async (phone, email) => {
        return inMemoryStore.find(
          (x) => (x.phone === phone || x.email.toLowerCase() === email.toLowerCase()) &&
                 (Date.now() - new Date(x.created_at).getTime()) < 600000,
        ) || null;
      },
      listApplications: async ({ search, status, limit, offset }) => {
        let filtered = inMemoryStore;
        if (status && status !== 'all') {
          filtered = filtered.filter((x) => x.status === status);
        }
        if (search) {
          const q = search.toLowerCase();
          filtered = filtered.filter((x) => x.applicant_name.toLowerCase().includes(q) || x.city.toLowerCase().includes(q));
        }
        return {
          items: filtered.slice(offset, offset + limit),
          total: filtered.length,
        };
      },
      getApplicationById: async (id) => {
        return inMemoryStore.find((x) => x.id === id) || null;
      },
      updateStatus: async (id, { status, adminNotes, reviewedBy }) => {
        const rec = inMemoryStore.find((x) => x.id === id);
        if (!rec) return null;
        rec.status = status;
        rec.admin_notes = adminNotes || rec.admin_notes;
        rec.reviewed_by = reviewedBy;
        rec.reviewed_at = new Date().toISOString();
        rec.updated_at = new Date().toISOString();
        return rec;
      },
    });
  });

  afterAll(() => {
    franchiseRepository.constructor.resetMockResolver();
    adminSessionRepository.constructor.resetMockSessionResolver();
  });

  describe('Public Franchise Application Flow', () => {
    it('POST /api/v1/public/franchise-application creates application and returns 201', async () => {
      const res = await request(app)
        .post('/api/v1/public/franchise-application')
        .send({
          name: 'Vikas Tiwari',
          phone: '9811223344',
          email: 'vikas@tiwari.in',
          city: 'Indore',
          investment: '50-100',
          experience: 'dealership',
          message: 'Interested in commercial hub.',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('id');
      expect(res.body.data.status).toBe('new');
      expect(res.body.data.applicantName).toBe('Vikas Tiwari');
    });

    it('POST /api/v1/public/franchise-application rejects invalid phone number with 400', async () => {
      const res = await request(app)
        .post('/api/v1/public/franchise-application')
        .send({
          name: 'Test Name',
          phone: '12345',
          email: 'test@gongo.in',
          city: 'Bhopal',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/valid 10-digit Indian mobile/i);
    });

    it('POST /api/v1/public/franchise-application rejects duplicate submission within 10 min with 409', async () => {
      // First submission
      await request(app)
        .post('/api/v1/public/franchise-application')
        .send({
          name: 'Pawan Kumar',
          phone: '9988776655',
          email: 'pawan@kumar.in',
          city: 'Gwalior',
        });

      // Immediate duplicate submission
      const dupRes = await request(app)
        .post('/api/v1/public/franchise-application')
        .send({
          name: 'Pawan Kumar',
          phone: '9988776655',
          email: 'pawan@kumar.in',
          city: 'Gwalior',
        });

      expect(dupRes.status).toBe(409);
      expect(dupRes.body.success).toBe(false);
      expect(dupRes.body.message).toMatch(/recently submitted/i);
    });
  });

  describe('Admin Franchise Applications Management Flow', () => {
    it('GET /api/v1/admin/franchise-applications returns 401 without auth token', async () => {
      const res = await request(app).get('/api/v1/admin/franchise-applications');
      expect(res.status).toBe(401);
    });

    it('GET /api/v1/admin/franchise-applications lists applications with Super Admin token', async () => {
      const res = await request(app)
        .get('/api/v1/admin/franchise-applications')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].applicantName).toBe('Pooja Verma');
      expect(res.body.data.total).toBe(1);
    });

    it('GET /api/v1/admin/franchise-applications/:id returns detailed application', async () => {
      const res = await request(app)
        .get('/api/v1/admin/franchise-applications/fa-001')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe('fa-001');
      expect(res.body.data.city).toBe('Bhopal');
      expect(res.body.data.investmentCapacity).toBe('25-50');
    });

    it('PATCH /api/v1/admin/franchise-applications/:id/status updates status to in_review', async () => {
      const res = await request(app)
        .patch('/api/v1/admin/franchise-applications/fa-001/status')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({
          status: 'in_review',
          adminNotes: 'Spoke on phone, requesting financial docs.',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('in_review');
      expect(res.body.data.adminNotes).toBe('Spoke on phone, requesting financial docs.');
    });

    it('PATCH /api/v1/admin/franchise-applications/:id/status rejects invalid status with 400', async () => {
      const res = await request(app)
        .patch('/api/v1/admin/franchise-applications/fa-001/status')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({
          status: 'invalid_status_value',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Invalid status/i);
    });
  });
});
