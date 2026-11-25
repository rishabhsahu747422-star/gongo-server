'use strict';

const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');
const UserRepository = require('../../../src/repositories/user.repository');
const { ConflictError, BadRequestError } = require('../../../src/errors');

describe('Database Foundation & UserRepository Integration Tests', () => {
  let db;
  let userRepository;
  let mockPool;

  beforeEach(async () => {
    // 1. Initialize hermetic in-memory PostgreSQL instance
    db = newDb();

    // 2. Register pgcrypto gen_random_uuid() as impure so each invocation generates a unique UUID
    db.public.registerFunction({
      name: 'gen_random_uuid',
      returns: DataType.uuid,
      impure: true,
      implementation: () => crypto.randomUUID(),
    });

    // 3. Create initial schema matching database/migrations/1726300000000_create-users-table.js
    db.public.none(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        role VARCHAR(20) NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'partner', 'admin')),
        name VARCHAR(150),
        country_code VARCHAR(8) NOT NULL DEFAULT '+91',
        phone VARCHAR(20),
        email VARCHAR(255),
        auth_provider VARCHAR(50) DEFAULT 'firebase',
        auth_id VARCHAR(128),
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_users_contact_required CHECK (phone IS NOT NULL OR email IS NOT NULL)
      );

      CREATE UNIQUE INDEX idx_users_country_code_phone
      ON users (country_code, phone)
      WHERE phone IS NOT NULL;

      CREATE UNIQUE INDEX idx_users_email_lower
      ON users (LOWER(email))
      WHERE email IS NOT NULL;

      CREATE UNIQUE INDEX idx_users_auth_provider_auth_id
      ON users (auth_provider, auth_id)
      WHERE auth_id IS NOT NULL;

      CREATE INDEX idx_users_role ON users (role);
      CREATE INDEX idx_users_is_active ON users (is_active);
    `);

    // 4. Create adapter pool to bind pg-mem to our UserRepository
    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();

    userRepository = new UserRepository();
    // Override query to execute on the in-memory pg instance
    userRepository.query = async (text, params) => {
      try {
        return await mockPool.query(text, params);
      } catch (err) {
        throw userRepository.handleDatabaseError(err);
      }
    };
  });

  afterEach(async () => {
    if (mockPool) {
      await mockPool.end();
    }
  });

  describe('1. Database Connection & Basic Health', () => {
    it('should successfully execute a connection verification query', async () => {
      const result = await userRepository.query('SELECT 1 AS alive');
      expect(result.rows).toBeDefined();
      expect(result.rows[0].alive).toBe(1);
    });
  });

  describe('2. User Creation & Defaults', () => {
    it('should create a customer user with valid defaults', async () => {
      const user = await userRepository.create({
        name: 'Rohan Sharma',
        phone: '9876543210',
        email: 'rohan@example.com',
      });

      expect(user).toBeDefined();
      expect(user.id).toBeDefined();
      expect(user.role).toBe('customer'); // Default role
      expect(user.countryCode).toBe('+91'); // Default country code
      expect(user.name).toBe('Rohan Sharma');
      expect(user.phone).toBe('9876543210');
      expect(user.email).toBe('rohan@example.com');
      expect(user.authProvider).toBe('firebase');
      expect(user.isActive).toBe(true);
      expect(user.createdAt).toBeInstanceOf(Date);
      expect(user.updatedAt).toBeInstanceOf(Date);
    });

    it('should create a partner or admin role user when explicitly specified', async () => {
      const partner = await userRepository.create({
        role: 'partner',
        name: 'Vendor Fleet',
        phone: '9876543211',
      });
      expect(partner.role).toBe('partner');

      const admin = await userRepository.create({
        role: 'admin',
        name: 'Super Admin',
        email: 'admin@gongo.in',
      });
      expect(admin.role).toBe('admin');
    });
  });

  describe('3. Unique Constraints (Phone & Email)', () => {
    it('should reject creation of user with duplicate country_code + phone', async () => {
      await userRepository.create({
        phone: '9999988888',
        countryCode: '+91',
        name: 'First User',
      });

      await expect(
        userRepository.create({
          phone: '9999988888',
          countryCode: '+91',
          name: 'Second User',
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('should allow same phone with different country_code', async () => {
      const user1 = await userRepository.create({
        phone: '9999988888',
        countryCode: '+91',
      });
      const user2 = await userRepository.create({
        phone: '9999988888',
        countryCode: '+1',
      });

      expect(user1.id).toBeDefined();
      expect(user2.id).toBeDefined();
      expect(user1.id).not.toBe(user2.id);
    });

    it('should reject creation of user with duplicate email (case-insensitive)', async () => {
      await userRepository.create({
        email: 'user@gongo.in',
        name: 'First User',
      });

      await expect(
        userRepository.create({
          email: 'USER@GONGO.IN',
          name: 'Second User',
        }),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('4. Invalid Role Check Constraint', () => {
    it('should reject user creation with invalid role not in (customer, partner, admin)', async () => {
      await expect(
        userRepository.create({
          role: 'superuser',
          phone: '9876543212',
        }),
      ).rejects.toThrow(BadRequestError);
    });
  });

  describe('5. Required Contact Check Constraint', () => {
    it('should reject user creation when both phone and email are null', async () => {
      await expect(
        userRepository.create({
          name: 'Ghost User',
          phone: null,
          email: null,
        }),
      ).rejects.toThrow(BadRequestError);
    });

    it('should allow user creation with phone only', async () => {
      const user = await userRepository.create({
        phone: '9876543213',
      });
      expect(user.phone).toBe('9876543213');
      expect(user.email).toBeNull();
    });

    it('should allow user creation with email only', async () => {
      const user = await userRepository.create({
        email: 'phone_less@example.com',
      });
      expect(user.email).toBe('phone_less@example.com');
      expect(user.phone).toBeNull();
    });
  });

  describe('6. UUID Primary Key Behavior', () => {
    it('should generate valid RFC 4122 v4 UUIDs for all created users', async () => {
      const user = await userRepository.create({
        phone: '9876543214',
      });

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(user.id).toMatch(uuidRegex);
    });

    it('should ensure all created users have distinct UUID primary keys', async () => {
      const u1 = await userRepository.create({ phone: '9000000001' });
      const u2 = await userRepository.create({ phone: '9000000002' });
      const u3 = await userRepository.create({ phone: '9000000003' });

      expect(u1.id).not.toBe(u2.id);
      expect(u2.id).not.toBe(u3.id);
      expect(u1.id).not.toBe(u3.id);
    });
  });

  describe('7. Timestamps and Update Behavior', () => {
    it('should set created_at and updated_at on initial insertion', async () => {
      const user = await userRepository.create({
        phone: '9876543215',
      });

      expect(user.createdAt).toBeInstanceOf(Date);
      expect(user.updatedAt).toBeInstanceOf(Date);
      expect(user.createdAt.getTime()).toBeLessThanOrEqual(user.updatedAt.getTime());
    });

    it('should update record and advance updated_at timestamp', async () => {
      const user = await userRepository.create({
        name: 'Original Name',
        phone: '9876543216',
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });

      const updated = await userRepository.update(user.id, {
        name: 'Updated Name',
      });

      expect(updated.name).toBe('Updated Name');
      expect(updated.id).toBe(user.id);
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(user.updatedAt.getTime());
    });

    it('should soft-delete user via deactivate()', async () => {
      const user = await userRepository.create({
        phone: '9876543217',
      });
      expect(user.isActive).toBe(true);

      const deactivated = await userRepository.deactivate(user.id);
      expect(deactivated.isActive).toBe(false);
    });
  });

  describe('8. Query Lookups', () => {
    it('should find user by id, phone, email, and authId', async () => {
      const created = await userRepository.create({
        name: 'Lookup User',
        countryCode: '+91',
        phone: '9123456789',
        email: 'lookup@gongo.in',
        authProvider: 'firebase',
        authId: 'firebase-uid-12345',
      });

      const byId = await userRepository.findById(created.id);
      expect(byId).toEqual(created);

      const byPhone = await userRepository.findByPhone('+91', '9123456789');
      expect(byPhone).toEqual(created);

      const byEmail = await userRepository.findByEmail('LOOKUP@GONGO.IN');
      expect(byEmail).toEqual(created);

      const byAuthId = await userRepository.findByAuthId('firebase', 'firebase-uid-12345');
      expect(byAuthId).toEqual(created);
    });

    it('should return null for non-existent records', async () => {
      const nonExistent = await userRepository.findById('00000000-0000-0000-0000-000000000000');
      expect(nonExistent).toBeNull();
    });
  });
});
