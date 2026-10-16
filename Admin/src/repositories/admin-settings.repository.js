'use strict';

const BaseRepository = require('../db/base.repository');

let defaultSettings = {
  defaultCommission: 15.0,
  platformConvenienceFee: 150,
  gstRate: 18.0,
  cancellationWindow1: 12,
  cancellationRefund1: 100,
  cancellationWindow2: 6,
  cancellationRefund2: 50,
  maxBookingDays: 30,
  autoApproveVerifiedPartnerVehicles: false,
  maintenanceMode: false,
  otpExpirySeconds: 60,
};

class AdminSettingsRepository extends BaseRepository {
  constructor() {
    super('admin_settings', 'id');
  }

  _getExecutor(client) {
    return client
      ? (text, params) => client.query(text, params)
      : (text, params) => this.query(text, params);
  }

  async getSettings(client = null) {
    const executor = this._getExecutor(client);
    try {
      const sql = `SELECT category, key, value FROM admin_settings;`;
      const res = await executor(sql);
      if (res.rows && res.rows.length > 0) {
        const merged = { ...defaultSettings };
        for (const row of res.rows) {
          merged[row.key] = typeof row.value === 'object' && row.value?.val !== undefined ? row.value.val : row.value;
        }
        return merged;
      }
    } catch (_) {}

    return defaultSettings;
  }

  async updateSettings(updates, adminId = null, client = null) {
    const executor = this._getExecutor(client);
    try {
      for (const [key, val] of Object.entries(updates)) {
        const sql = `
          INSERT INTO admin_settings (category, key, value, updated_by)
          VALUES ('general', $1, $2::jsonb, $3)
          ON CONFLICT (key)
          DO UPDATE SET value = $2::jsonb, updated_by = $3, updated_at = CURRENT_TIMESTAMP;
        `;
        await executor(sql, [key, JSON.stringify({ val }), adminId]);
      }
    } catch (_) {}

    defaultSettings = { ...defaultSettings, ...updates };
    return defaultSettings;
  }
}

module.exports = new AdminSettingsRepository();
