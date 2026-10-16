'use strict';

const BaseRepository = require('../db/base.repository');

class PartnerDocumentRepository extends BaseRepository {
  constructor() {
    super('partner_documents', 'id');
  }

  /**
   * Find all documents for a partner.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async findByPartnerId(partnerId, client = null) {
    const text = `
      SELECT 
        id, partner_id, document_type, document_number, storage_key, 
        verification_status, version, rejection_reason, created_at, updated_at
      FROM ${this.tableName}
      WHERE partner_id = $1
      ORDER BY created_at DESC
    `;
    const res = client
      ? await client.query(text, [partnerId])
      : await this.query(text, [partnerId]);
    return res.rows;
  }

  /**
   * Find the latest version of each document type for a partner.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async findLatestByPartnerId(partnerId, client = null) {
    const text = `
      SELECT DISTINCT ON (document_type)
        id, partner_id, document_type, document_number, storage_key, 
        verification_status, version, rejection_reason, created_at, updated_at
      FROM ${this.tableName}
      WHERE partner_id = $1
      ORDER BY document_type ASC, version DESC
    `;
    const res = client
      ? await client.query(text, [partnerId])
      : await this.query(text, [partnerId]);
    return res.rows;
  }

  /**
   * Find current maximum version for a partner and document type.
   *
   * @param {string} partnerId
   * @param {string} documentType
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>}
   */
  async findMaxVersion(partnerId, documentType, client = null) {
    const text = `
      SELECT COALESCE(MAX(version), 0) AS max_version
      FROM ${this.tableName}
      WHERE partner_id = $1 AND document_type = $2
    `;
    const res = client
      ? await client.query(text, [partnerId, documentType])
      : await this.query(text, [partnerId, documentType]);
    return res.rows[0] ? Number(res.rows[0].max_version) : 0;
  }

  /**
   * Create document metadata entry.
   *
   * @param {object} docData
   * @param {string} docData.partnerId
   * @param {string} docData.documentType
   * @param {string} [docData.documentNumber]
   * @param {string} docData.storageKey
   * @param {string} [docData.verificationStatus='PENDING']
   * @param {number} [docData.version=1]
   * @param {string} [docData.rejectionReason=null]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createDocument(docData, client = null) {
    const text = `
      INSERT INTO ${this.tableName} (
        partner_id, document_type, document_number, storage_key, file_url,
        verification_status, version, rejection_reason
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, partner_id, document_type, document_number, storage_key, file_url,
                verification_status, version, rejection_reason, created_at, updated_at
    `;
    const values = [
      docData.partnerId,
      docData.documentType,
      docData.documentNumber ? docData.documentNumber.trim() : null,
      docData.storageKey,
      docData.storageKey,
      docData.verificationStatus || 'PENDING',
      docData.version || 1,
      docData.rejectionReason || null,
    ];

    const res = client ? await client.query(text, values) : await this.query(text, values);
    return res.rows[0];
  }

  /**
   * Find document by ID strictly scoped to partner ownership.
   *
   * @param {string} id
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByIdAndPartnerId(id, partnerId, client = null) {
    const text = `
      SELECT 
        id, partner_id, document_type, document_number, storage_key,
        verification_status, version, rejection_reason, created_at, updated_at
      FROM ${this.tableName}
      WHERE id = $1 AND partner_id = $2
      LIMIT 1
    `;
    const res = client
      ? await client.query(text, [id, partnerId])
      : await this.query(text, [id, partnerId]);
    return res.rows[0] || null;
  }
}

module.exports = PartnerDocumentRepository;
