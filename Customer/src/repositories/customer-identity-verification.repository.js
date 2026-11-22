'use strict';

const BaseRepository = require('./base.repository');

/**
 * CustomerIdentityVerificationRepository manages persistence for customer
 * DigiLocker / Aadhaar verification metadata and non-sensitive audit trails.
 */
class CustomerIdentityVerificationRepository extends BaseRepository {
  /**
   * Maps database row to domain entity.
   *
   * @param {object} row
   * @returns {object|null}
   */
  static mapRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      customerId: row.customer_id,
      documentType: (row.document_type || 'AADHAAR').toUpperCase(),
      verificationStatus: (row.verification_status || 'PENDING').toUpperCase(),
      provider: row.provider || row.verification_provider || 'DIGILOCKER_SANDBOX',
      providerReferenceId: row.provider_reference_id || row.provider_reference || null,
      storageBucket: row.storage_bucket || null,
      storagePath: row.storage_path || row.document_reference || null,
      verifiedAt: row.verified_at || null,
      identityHash: row.identity_hash || null,
      consentRecord: row.consent_record || row.verification_metadata || {},
      errorDetails: row.error_details || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Projects domain entity to safe client DTO.
   * Never leaks raw storage paths, bucket names, or internal error stacks.
   *
   * @param {object} entity
   * @returns {object|null}
   */
  static toSafeDto(entity) {
    if (!entity) return null;
    return {
      id: entity.id,
      documentType: entity.documentType,
      verificationStatus: entity.verificationStatus,
      provider: entity.provider,
      verifiedAt: entity.verifiedAt,
      isVerified: entity.verificationStatus === 'VERIFIED',
      maskedAadhaar: entity.consentRecord?.maskedAadhaar || null,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }

  /**
   * Creates a new pending verification session record.
   *
   * @param {object} params
   * @param {string} params.id - UUID
   * @param {string} params.customerId - UUID
   * @param {string} [params.documentType='AADHAAR']
   * @param {string} [params.verificationStatus='PENDING']
   * @param {string} [params.provider='DIGILOCKER_SANDBOX']
   * @param {string} [params.providerReferenceId]
   * @param {object} [params.consentRecord]
   * @returns {Promise<object>}
   */
  async createVerification({
    id,
    customerId,
    documentType = 'AADHAAR',
    verificationStatus = 'PENDING',
    provider = 'DIGILOCKER_SANDBOX',
    providerReferenceId = null,
    consentRecord = {},
    identityHash = null,
  }) {
    const text = `
      INSERT INTO customer_identity_verifications (
        id,
        customer_id,
        document_type,
        verification_status,
        provider,
        verification_provider,
        verification_method,
        provider_reference_id,
        provider_reference,
        consent_record,
        verification_metadata,
        identity_hash
      )
      VALUES ($1, $2, $3, $4, $5, $5, 'online', $6, $6, $7, $7, $8)
      RETURNING *;
    `;
    const params = [
      id,
      customerId,
      documentType,
      verificationStatus,
      provider,
      providerReferenceId,
      JSON.stringify(consentRecord),
      identityHash,
    ];

    const result = await this.query(text, params);
    return CustomerIdentityVerificationRepository.mapRow(result.rows[0]);
  }

  /**
   * Finds verification by its primary key UUID.
   *
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    const text = 'SELECT * FROM customer_identity_verifications WHERE id = $1 LIMIT 1;';
    const result = await this.query(text, [id]);
    return CustomerIdentityVerificationRepository.mapRow(result.rows[0]);
  }

  /**
   * Finds the latest verification record for a customer.
   *
   * @param {string} customerId
   * @param {string} [documentType='AADHAAR']
   * @returns {Promise<object|null>}
   */
  async findLatestByCustomerId(customerId, documentType = 'AADHAAR') {
    const text = `
      SELECT * FROM customer_identity_verifications
      WHERE customer_id = $1 AND (UPPER(document_type) = UPPER($2) OR document_type = $2)
      ORDER BY (CASE WHEN UPPER(verification_status) = 'VERIFIED' THEN 1 ELSE 2 END) ASC, created_at DESC
      LIMIT 1;
    `;
    const result = await this.query(text, [customerId, documentType]);
    return CustomerIdentityVerificationRepository.mapRow(result.rows[0]);
  }

  /**
   * Finds verification by provider reference ID.
   *
   * @param {string} providerRefId
   * @returns {Promise<object|null>}
   */
  async findByProviderReferenceId(providerRefId) {
    const text = `
      SELECT * FROM customer_identity_verifications
      WHERE provider_reference_id = $1 OR provider_reference = $1
      ORDER BY created_at DESC
      LIMIT 1;
    `;
    const result = await this.query(text, [providerRefId]);
    return CustomerIdentityVerificationRepository.mapRow(result.rows[0]);
  }

  /**
   * Updates verification status and storage references idempotently.
   *
   * @param {string} id
   * @param {object} updates
   * @returns {Promise<object>}
   */
  async updateVerification(id, {
    verificationStatus,
    identityHash,
    storageBucket,
    storagePath,
    verifiedAt,
    providerReferenceId,
    consentRecord,
    errorDetails,
  }) {
    const fields = [];
    const values = [id];
    let idx = 2;

    if (verificationStatus !== undefined) {
      fields.push(`verification_status = $${idx++}`);
      values.push(verificationStatus);
    }
    if (identityHash !== undefined) {
      fields.push(`identity_hash = $${idx++}`);
      values.push(identityHash);
    }
    if (storageBucket !== undefined) {
      fields.push(`storage_bucket = $${idx++}`);
      values.push(storageBucket);
    }
    if (storagePath !== undefined) {
      fields.push(`storage_path = $${idx}`);
      fields.push(`document_reference = $${idx++}`);
      values.push(storagePath);
    }
    if (verifiedAt !== undefined) {
      fields.push(`verified_at = $${idx++}`);
      values.push(verifiedAt);
    }
    if (providerReferenceId !== undefined) {
      fields.push(`provider_reference_id = $${idx}`);
      fields.push(`provider_reference = $${idx++}`);
      values.push(providerReferenceId);
    }
    if (consentRecord !== undefined) {
      fields.push(`consent_record = $${idx}`);
      fields.push(`verification_metadata = $${idx++}`);
      values.push(JSON.stringify(consentRecord));
    }
    if (errorDetails !== undefined) {
      fields.push(`error_details = $${idx++}`);
      values.push(JSON.stringify(errorDetails));
    }

    fields.push('updated_at = NOW()');

    if (fields.length === 0) {
      return this.findById(id);
    }

    const text = `
      UPDATE customer_identity_verifications
      SET ${fields.join(', ')}
      WHERE id = $1
      RETURNING *;
    `;

    const result = await this.query(text, values);
    return CustomerIdentityVerificationRepository.mapRow(result.rows[0]);
  }

  /**
   * Records a non-sensitive audit event.
   *
   * @param {object} params
   * @param {string} [params.verificationId]
   * @param {string} params.customerId
   * @param {string} params.eventType
   * @param {string} [params.provider='DIGILOCKER_SANDBOX']
   * @param {object} [params.details={}]
   * @returns {Promise<object>}
   */
  async createAuditEvent({
    verificationId = null,
    customerId,
    eventType,
    provider = 'DIGILOCKER_SANDBOX',
    details = {},
  }) {
    const text = `
      INSERT INTO identity_verification_audits (
        verification_id, customer_id, event_type, provider, details
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const params = [
      verificationId,
      customerId,
      eventType,
      provider,
      JSON.stringify(details),
    ];

    const result = await this.query(text, params);
    return result.rows[0];
  }

  /**
   * Retrieves audit events for a verification.
   *
   * @param {string} verificationId
   * @returns {Promise<Array<object>>}
   */
  async findAuditsByVerificationId(verificationId) {
    const text = `
      SELECT * FROM identity_verification_audits
      WHERE verification_id = $1
      ORDER BY created_at ASC;
    `;
    const result = await this.query(text, [verificationId]);
    return result.rows;
  }

  /**
   * Finds an existing identity link by its cryptographic identity hash.
   *
   * @param {string} identityHash
   * @returns {Promise<object|null>}
   */
  async findIdentityLinkByHash(identityHash) {
    const text = 'SELECT * FROM customer_identity_links WHERE identity_hash = $1 LIMIT 1;';
    const result = await this.query(text, [identityHash]);
    return result.rows[0] || null;
  }

  /**
   * Finds an existing identity link for a customer by document type.
   *
   * @param {string} customerId
   * @param {string} [idType='AADHAAR']
   * @returns {Promise<object|null>}
   */
  async findIdentityLinkByCustomerId(customerId, idType = 'AADHAAR') {
    const text = 'SELECT * FROM customer_identity_links WHERE customer_id = $1 AND id_type = $2 LIMIT 1;';
    const result = await this.query(text, [customerId, idType]);
    return result.rows[0] || null;
  }

  /**
   * Upserts an identity link for a customer.
   * If the same identity is already linked to this customer, updates the verification reference.
   * If linked to another customer, database unique constraint uq_customer_identity_links_hash
   * prevents conflicting inserts.
   *
   * @param {object} params
   * @param {string} params.customerId
   * @param {string} params.identityHash
   * @param {string} [params.idType='AADHAAR']
   * @param {string} [params.verificationId]
   * @returns {Promise<object>}
   */
  async upsertIdentityLink({ customerId, identityHash, idType = 'AADHAAR', verificationId = null }) {
    const text = `
      INSERT INTO customer_identity_links (
        customer_id, identity_hash, id_type, verification_id
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (identity_hash) DO UPDATE
      SET verification_id = EXCLUDED.verification_id,
          updated_at = CURRENT_TIMESTAMP
      WHERE customer_identity_links.customer_id = $1
      RETURNING *;
    `;
    const result = await this.query(text, [customerId, identityHash, idType, verificationId]);
    return result.rows[0] || null;
  }

  /**
   * Deletes an identity link by verification ID (for rollback/cleanup on partial failures).
   *
   * @param {string} verificationId
   * @returns {Promise<boolean>}
   */
  async deleteIdentityLinkByVerificationId(verificationId) {
    const text = 'DELETE FROM customer_identity_links WHERE verification_id = $1 RETURNING id;';
    const result = await this.query(text, [verificationId]);
    return (result.rowCount || 0) > 0;
  }
}

module.exports = CustomerIdentityVerificationRepository;
