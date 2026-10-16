'use strict';

const adminSettingsRepository = require('../repositories/admin-settings.repository');
const logger = require('../config/logger');

class AdminSettingsService {
  async getSettings() {
    const settings = await adminSettingsRepository.getSettings();
    return { settings };
  }

  async updateSettings(updates, adminId = null) {
    const settings = await adminSettingsRepository.updateSettings(updates, adminId);
    logger.info('Updated system settings', { adminId, updates });
    return { settings };
  }
}

module.exports = new AdminSettingsService();
