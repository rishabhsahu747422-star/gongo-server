'use strict';

const BaseRepository = require('../db/base.repository');

class StorageUploadRepository extends BaseRepository {
  constructor() {
    super('storage_uploads', 'id');
  }

  /**
   * Create a new storage upload record.
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {string} params.entityType
   * @param {string} [params.entityId]
   * @param {string} [params.documentType]
   * @param {string} params.storageKey
   * @param {string} params.contentType
   * @param {number} [params.expectedSizeBytes]
   * @param {Date|string} params.expiresAt
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createUpload(
    {
      partnerId,
      entityType,
      entityId = null,
      documentType = null,
      storageKey,
      contentType,
      expectedSizeBytes = null,
      expiresAt,
      metadata = {},
    },
    client = null,
  ) {
    const text = `
      INSERT INTO ${this.tableName} (
        partner_id, entity_type, entity_id, document_type,
        storage_key, content_type, expected_size_bytes, expires_at, status, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9)
      RETURNING *;
    `;
    const values = [
      partnerId,
      entityType,
      entityId,
      documentType,
      storageKey,
      contentType,
      expectedSizeBytes,
      expiresAt,
      JSON.stringify(metadata || {}),
    ];

    try {
      const res = client
        ? await client.query(text, values)
        : await this.query(text, values);
      return res.rows[0];
    } catch (err) {
      this.handleDbError(err, 'StorageUploadRepository.createUpload');
    }
  }

  /**
   * Find an upload by ID and partnerId (enforcing BOLA protection).
   *
   * @param {string} id
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByIdAndPartnerId(id, partnerId, client = null) {
    const text = `
      SELECT *
      FROM ${this.tableName}
      WHERE id = $1 AND partner_id = $2
      LIMIT 1;
    `;
    const res = client
      ? await client.query(text, [id, partnerId])
      : await this.query(text, [id, partnerId]);
    return res.rows[0] || null;
  }

  /**
   * Find an upload by ID and partnerId with row-level lock (FOR UPDATE).
   *
   * @param {string} id
   * @param {string} partnerId
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async findByIdAndPartnerIdForUpdate(id, partnerId, client) {
    if (!client) {
      throw new Error('Transaction client is required for findByIdAndPartnerIdForUpdate');
    }
    const text = `
      SELECT *
      FROM ${this.tableName}
      WHERE id = $1 AND partner_id = $2
      LIMIT 1
      FOR UPDATE;
    `;
    const res = await client.query(text, [id, partnerId]);
    return res.rows[0] || null;
  }

  /**
   * Mark an upload as COMPLETED with actual byte size.
   *
   * @param {object} params
   * @param {string} params.id
   * @param {string} params.partnerId
   * @param {number} params.actualSizeBytes
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async markCompleted({ id, partnerId, actualSizeBytes }, client = null) {
    const text = `
      UPDATE ${this.tableName}
      SET 
        status = 'COMPLETED',
        actual_size_bytes = $3,
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND partner_id = $2
      RETURNING *;
    `;
    const res = client
      ? await client.query(text, [id, partnerId, actualSizeBytes])
      : await this.query(text, [id, partnerId, actualSizeBytes]);
    return res.rows[0] || null;
  }

  /**
   * Mark an upload with a specific status (e.g. FAILED, EXPIRED).
   *
   * @param {object} params
   * @param {string} params.id
   * @param {string} params.partnerId
   * @param {string} params.status
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async markStatus({ id, partnerId, status }, client = null) {
    const text = `
      UPDATE ${this.tableName}
      SET 
        status = $3,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND partner_id = $2
      RETURNING *;
    `;
    const res = client
      ? await client.query(text, [id, partnerId, status])
      : await this.query(text, [id, partnerId, status]);
    return res.rows[0] || null;
  }

  /**
   * Find expired PENDING uploads for background cleanup.
   *
   * @param {number} [limit=100]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async findExpiredPendingUploads(limit = 100, client = null) {
    const text = `
      SELECT *
      FROM ${this.tableName}
      WHERE status = 'PENDING' AND expires_at < CURRENT_TIMESTAMP
      ORDER BY expires_at ASC
      LIMIT $1;
    `;
    const res = client
      ? await client.query(text, [limit])
      : await this.query(text, [limit]);
    return res.rows;
  }
}

module.exports = new StorageUploadRepository();
