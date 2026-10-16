'use strict';

const adminUserService = require('../services/admin-user.service');
const { sendSuccess } = require('../utils/response');

class AdminUserController {
  async listUsers(req, res, next) {
    try {
      const data = await adminUserService.listUsers(req.pagination || req.query);
      return sendSuccess(res, data.users, 'Users retrieved successfully', 200, data.pagination);
    } catch (err) {
      return next(err);
    }
  }

  async getUserById(req, res, next) {
    try {
      const data = await adminUserService.getUserById(req.params.id);
      return sendSuccess(res, data.user, 'User retrieved successfully');
    } catch (err) {
      return next(err);
    }
  }

  async updateUserStatus(req, res, next) {
    try {
      const data = await adminUserService.updateUserStatus(req.params.id, req.body, req.user);
      return sendSuccess(res, data.user, data.message);
    } catch (err) {
      return next(err);
    }
  }

  async updateUserRole(req, res, next) {
    try {
      const data = await adminUserService.updateUserRole(req.params.id, req.body, req.user);
      return sendSuccess(res, data.user, data.message);
    } catch (err) {
      return next(err);
    }
  }

  async createUser(req, res, next) {
    try {
      const data = await adminUserService.createUser(req.body, req.user);
      return sendSuccess(res, data.user, data.message, 201);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminUserController();
