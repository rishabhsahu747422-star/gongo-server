'use strict';

const userRepository = require('../repositories/user.repository');
const adminCredentialRepository = require('../repositories/admin-credential.repository');
const auditService = require('./audit.service');
const { hashPassword, validatePasswordPolicy } = require('../utils/password');
const { normalizeEmail, normalizeMobile } = require('../utils/login-identifier');
const { ValidationError, NotFoundError, ForbiddenError } = require('../errors');
const logger = require('../config/logger');

const ALLOWED_ADMIN_ROLES = ['admin', 'super_admin', 'support_executive'];
const ALLOWED_STATUSES = ['active', 'suspended', 'inactive'];

class AdminUserService {
  /**
   * Lists administrative users from the database.
   *
   * @param {object} [pagination]
   * @returns {Promise<{ users: object[], pagination: object }>}
   */
  async listUsers(pagination = {}) {
    const page = pagination.page || 1;
    const limit = pagination.limit || 20;
    const offset = (page - 1) * limit;

    const dbAdmins = await userRepository.findAllAdmins({ limit, offset });
    const users = dbAdmins.map((u) => ({
      id: u.id,
      phone: u.phone,
      name: u.name || 'Admin',
      email: u.email || `${u.phone || u.id}@gongo.local`,
      role: u.role,
      status: u.status,
      isActive: u.is_active,
      createdAt: u.created_at,
      updatedAt: u.updated_at,
    }));

    return {
      users,
      pagination: {
        page,
        limit,
        total: users.length,
      },
    };
  }

  /**
   * Retrieves single admin user by ID.
   *
   * @param {string} id User UUID
   * @returns {Promise<object>}
   */
  async getUserById(id) {
    if (!id) {
      throw new ValidationError('User ID is required');
    }

    const user = await userRepository.findById(id);
    if (!user) {
      throw new NotFoundError(`User with ID ${id} not found`);
    }

    return {
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name || 'Admin',
        email: user.email,
        role: user.role,
        status: user.status,
        isActive: user.is_active,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      },
    };
  }

  /**
   * Updates an admin user's status with full auditing.
   *
   * @param {string} id User ID
   * @param {object} payload
   * @param {string} payload.status New status ('active', 'suspended', 'inactive')
   * @param {string} [payload.reason] Audit reason
   * @param {object} actor Authenticated admin user
   * @returns {Promise<object>}
   */
  async updateUserStatus(id, { status, reason = 'Admin status update' }, actor = {}) {
    if (!id) {
      throw new ValidationError('User ID is required');
    }

    const normalizedStatus = String(status || '').toLowerCase().trim();
    if (!ALLOWED_STATUSES.includes(normalizedStatus)) {
      throw new ValidationError(
        `Invalid status. Allowed values: ${ALLOWED_STATUSES.join(', ')}`,
      );
    }

    // 1. Validate target user exists
    const targetUser = await userRepository.findById(id);
    if (!targetUser) {
      throw new NotFoundError(`User with ID ${id} not found`);
    }

    // Prevent modifying self status
    if (actor.id && actor.id === targetUser.id && normalizedStatus !== 'active') {
      throw new ForbiddenError('Administrators cannot suspend their own account');
    }

    const beforeState = {
      status: targetUser.status,
      is_active: targetUser.is_active,
    };

    // 2. Perform database update
    const updated = await userRepository.updateStatus(id, normalizedStatus);

    const afterState = {
      status: updated ? updated.status : normalizedStatus,
      is_active: updated ? updated.is_active : normalizedStatus === 'active',
    };

    // 3. Create admin_actions & audit_logs records
    await auditService.recordAction({
      actorId: actor.id || 'system-admin',
      actorRole: actor.role || 'admin',
      action: normalizedStatus === 'active' ? 'REACTIVATE_ADMIN' : 'SUSPEND_ADMIN',
      targetResource: 'users',
      targetResourceId: id,
      beforeState,
      afterState,
      metadata: {
        reason,
        targetPhone: targetUser.phone,
        targetRole: targetUser.role,
      },
    });

    logger.info('Admin user status updated', {
      userId: id,
      newStatus: normalizedStatus,
      updatedBy: actor.id,
    });

    return {
      user: {
        id,
        status: normalizedStatus,
        role: targetUser.role,
        updatedAt: new Date().toISOString(),
      },
      message: `User status successfully updated to ${normalizedStatus}`,
    };
  }

  /**
   * Updates an admin user's role with strict RBAC validation and auditing.
   *
   * @param {string} id Target user ID
   * @param {object} payload
   * @param {string} payload.role New role ('admin' or 'support_executive')
   * @param {string} [payload.reason]
   * @param {object} actor Authenticated admin user
   * @returns {Promise<object>}
   */
  async updateUserRole(id, { role, reason = 'Admin role update' }, actor = {}) {
    if (!id) {
      throw new ValidationError('User ID is required');
    }

    const normalizedRole = String(role || '').toLowerCase().trim();
    if (!ALLOWED_ADMIN_ROLES.includes(normalizedRole)) {
      throw new ValidationError(
        `Invalid admin role. Allowed values: ${ALLOWED_ADMIN_ROLES.join(', ')}`,
      );
    }

    // 1. Validate target user
    const targetUser = await userRepository.findById(id);
    if (!targetUser) {
      throw new NotFoundError(`User with ID ${id} not found`);
    }

    // Privilege escalation prevention:
    const actorRole = String(actor.role || '').toLowerCase();
    const targetRole = String(targetUser.role || '').toLowerCase();
    if (targetRole === 'super_admin' && actorRole !== 'super_admin') {
      throw new ForbiddenError('Only Super Administrators can modify Super Administrator accounts');
    }
    if (normalizedRole === 'super_admin' && actorRole !== 'super_admin') {
      throw new ForbiddenError('Only Super Administrators can assign the Super Administrator role');
    }

    // Never allow demoting self if sole admin
    if (actor.id && actor.id === targetUser.id && normalizedRole !== 'admin' && normalizedRole !== 'super_admin') {
      throw new ForbiddenError('Administrators cannot revoke their own admin role');
    }

    const beforeState = { role: targetUser.role };

    // 2. Perform database update
    const updated = await userRepository.updateRole(id, normalizedRole);

    const afterState = { role: updated ? updated.role : normalizedRole };

    // 3. Create admin_actions & audit_logs records
    await auditService.recordAction({
      actorId: actor.id || 'system-admin',
      actorRole: actor.role || 'admin',
      action: 'CHANGE_ROLE',
      targetResource: 'users',
      targetResourceId: id,
      beforeState,
      afterState,
      metadata: {
        reason,
        oldRole: targetUser.role,
        newRole: normalizedRole,
      },
    });

    logger.info('Admin user role updated', {
      userId: id,
      newRole: normalizedRole,
      updatedBy: actor.id,
    });

    return {
      user: {
        id,
        role: normalizedRole,
        status: targetUser.status,
        updatedAt: new Date().toISOString(),
      },
      message: `User role successfully updated to ${normalizedRole}`,
    };
  }

  /**
   * Creates a new internal administrative user.
   *
   * @param {object} payload
   * @param {string} payload.name
   * @param {string} payload.email
   * @param {string} [payload.role='admin']
   * @param {string} [payload.password]
   * @param {string} [payload.phone]
   * @param {object} actor Authenticated admin user performing the action
   * @returns {Promise<object>}
   */
  async createUser(payload = {}, actor = {}) {
    const { name, email, role = 'admin', password, phone } = payload;

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new ValidationError('Admin user name is required');
    }
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      throw new ValidationError('Valid admin email is required');
    }
    const normalizedPhone = phone ? normalizeMobile(String(phone)) : null;
    if (phone && !normalizedPhone) {
      throw new ValidationError('Admin phone must be a valid 10-digit mobile number');
    }

    const normalizedRole = String(role || 'admin').toLowerCase().trim();
    if (!ALLOWED_ADMIN_ROLES.includes(normalizedRole)) {
      throw new ValidationError(
        `Invalid admin role. Allowed values: ${ALLOWED_ADMIN_ROLES.join(', ')}`,
      );
    }

    // Privilege escalation prevention
    const actorRole = String(actor.role || '').toLowerCase();
    if (actorRole === 'support_executive') {
      throw new ForbiddenError('Support executives cannot create administrative accounts');
    }
    const actorIsSuperAdmin = actorRole === 'super_admin'
      || (actor.permissions || []).includes('SUPER_ADMIN');
    if (normalizedRole === 'super_admin' && !actorIsSuperAdmin) {
      throw new ForbiddenError('Only Super Administrators can create Super Administrator accounts');
    }

    // No shared default password: each admin gets an explicit initial password, stored only
    // as a scrypt hash and flagged for change at first login.
    const passwordProblems = validatePasswordPolicy(password);
    if (typeof password !== 'string' || passwordProblems.length > 0) {
      throw new ValidationError(
        'An initial password meeting the password policy is required',
        passwordProblems.map((message) => ({ field: 'password', message })),
      );
    }

    // Check if user already exists
    const existing = await userRepository.findByEmailOrPhone(normalizedEmail);
    if (existing) {
      throw new ValidationError(`User with email ${normalizedEmail} already exists`);
    }

    const isActorUuid = actor.id && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(actor.id);
    const created = await userRepository.createAdminUser({
      name: name.trim(),
      email: normalizedEmail,
      phone: normalizedPhone,
      role: normalizedRole,
      status: 'active',
      is_active: true,
      auth_id: null,
      auth_provider: 'admin_password',
      created_by: isActorUuid ? actor.id : null,
    });

    const passwordHash = await hashPassword(password);
    await adminCredentialRepository.createIfAbsent({
      userId: created.id,
      passwordHash,
      mustChangePassword: true,
    });

    // Record audit action
    try {
      await auditService.recordAction({
        actorId: actor.id || 'system-admin',
        actorRole: actor.role || 'admin',
        action: 'CREATE_ADMIN_USER',
        targetResource: 'users',
        targetResourceId: created.id,
        afterState: {
          id: created.id,
          name: created.name,
          email: created.email,
          role: created.role,
          status: created.status,
        },
        metadata: {
          createdEmail: created.email,
          createdRole: created.role,
        },
      });
    } catch (_) {
      try {
        auditService.logAdminAction({
          actorId: actor.id || 'system-admin',
          actorRole: actor.role || 'admin',
          action: 'CREATE_ADMIN_USER',
          targetResource: 'users',
          targetResourceId: created.id,
        });
      } catch (__) {}
    }

    logger.info('Admin user created successfully', {
      userId: created.id,
      email: created.email,
      role: created.role,
      createdBy: actor.id,
    });

    return {
      user: {
        id: created.id,
        name: created.name,
        email: created.email,
        phone: created.phone,
        role: created.role,
        status: created.status,
        isActive: created.is_active,
        createdAt: created.created_at,
        updatedAt: created.updated_at,
      },
      message: 'Admin user created successfully',
    };
  }
}

module.exports = new AdminUserService();
