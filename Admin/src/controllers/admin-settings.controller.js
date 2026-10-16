'use strict';

const adminSettingsService = require('../services/admin-settings.service');
const { sendSuccess } = require('../utils/response');

class AdminSettingsController {
  async getSettings(req, res, next) {
    try {
      const data = await adminSettingsService.getSettings();
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async updateSettings(req, res, next) {
    try {
      const data = await adminSettingsService.updateSettings(req.body, req.user?.id);
      if (req.audit) {
        req.audit({
          action: 'SETTINGS_UPDATE',
          targetResource: 'SYSTEM_SETTINGS',
          targetResourceId: 'global',
          afterState: req.body,
        });
      }
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminSettingsController();
