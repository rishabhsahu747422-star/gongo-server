'use strict';

const BaseRepository = require('../db/base.repository');

class ConsentRepository extends BaseRepository {
  constructor() {
    super('partner_consents', 'id');
  }

  async recordConsent({
    userId,
    partnerId = null,
    documentType,
    documentVersion,
    contentHash,
    ipAddress = null,
    userAgent = null,
    vehicleId = null,
    metadata = {},
    client = null,
  }) {
    const executor = client
      ? (text, params) => client.query(text, params)
      : (text, params) => this.query(text, params);

    const sql = `
      INSERT INTO partner_consents (
        user_id, partner_id, document_type, document_version,
        content_hash, ip_address, user_agent, vehicle_id, metadata, accepted_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
      RETURNING *;
    `;
    const params = [
      userId,
      partnerId,
      documentType,
      documentVersion,
      contentHash,
      ipAddress,
      userAgent,
      vehicleId,
      JSON.stringify(metadata || {}),
    ];

    const result = await executor(sql, params);
    return result.rows[0];
  }

  async getLatestConsentsByPartnerId(partnerId, client = null) {
    const executor = client
      ? (text, params) => client.query(text, params)
      : (text, params) => this.query(text, params);

    const sql = `
      SELECT DISTINCT ON (document_type)
        id, user_id, partner_id, document_type, document_version,
        content_hash, accepted_at, vehicle_id, metadata
      FROM partner_consents
      WHERE partner_id = $1
      ORDER BY document_type, accepted_at DESC;
    `;
    const result = await executor(sql, [partnerId]);
    return result.rows || [];
  }

  async getLatestConsentsByUserId(userId, client = null) {
    const executor = client
      ? (text, params) => client.query(text, params)
      : (text, params) => this.query(text, params);

    const sql = `
      SELECT DISTINCT ON (document_type)
        id, user_id, partner_id, document_type, document_version,
        content_hash, accepted_at, vehicle_id, metadata
      FROM partner_consents
      WHERE user_id = $1
      ORDER BY document_type, accepted_at DESC;
    `;
    const result = await executor(sql, [userId]);
    return result.rows || [];
  }
}

module.exports = new ConsentRepository();
