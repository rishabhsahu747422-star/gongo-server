'use strict';

const BaseRepository = require('./base.repository');

/**
 * CustomerDocumentRepository provides data access for customer KYC and driving license records.
 * Authoritative Supabase table: `customer_documents`.
 */
class CustomerDocumentRepository extends BaseRepository {
  /**
   * Maps a database row (snake_case) to a domain entity (camelCase).
   *
   * @param {object} row - Database row
   * @returns {object|null}
   */
  static mapDocumentRow(row) {
    if (!row) return null;
    const storagePath = row.storage_path || row.storage_key || null;
    const fileName = row.file_name || null;
    const metadata = (typeof row.metadata === 'object' && row.metadata !== null) ? row.metadata : {};

    let side = metadata.side || null;
    if (!side) {
      const combined = `${fileName || ''} ${storagePath || ''}`.toLowerCase();
      if (combined.includes('front')) {
        side = 'front';
      } else if (combined.includes('back') || combined.includes('rear')) {
        side = 'back';
      }
    }

    return {
      id: row.id,
      userId: row.customer_id || row.user_id,
      customerId: row.customer_id || row.user_id,
      documentType: (row.document_type || '').toUpperCase(),
      status: (row.verification_status || row.status || 'PENDING').toUpperCase(),
      storageKey: storagePath,
      fileUrl: row.file_url || null,
      fileName,
      side,
      documentNumber: row.document_number || metadata.document_number || metadata.documentNumber || null,
      metadata,
      rejectionReason: row.rejection_reason || null,
      verifiedAt: row.verified_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Projects a document entity into a safe client-facing DTO.
   *
   * @param {object} doc
   * @returns {object}
   */
  static toSafeDto(doc) {
    if (!doc) return null;
    const dto = {
      id: doc.id,
      documentType: doc.documentType,
      status: doc.status || doc.verificationStatus || 'PENDING',
      rejectionReason: doc.rejectionReason || null,
      verifiedAt: doc.verifiedAt || null,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
    if (doc.side) {
      dto.side = doc.side;
    }
    if (doc.fileName) {
      dto.fileName = doc.fileName;
    }
    if (doc.documentNumber) {
      const rawNum = String(doc.documentNumber).replace(/\s+/g, '');
      const last4 = rawNum.slice(-4);
      dto.documentNumber = rawNum.length > 4 ? `XXXX XXXX ${last4}` : rawNum;
      dto.number = dto.documentNumber;
    }
    return dto;
  }

  /**
   * Inserts a new customer document record.
   *
   * @param {object} params
   * @param {string} params.userId - User / Customer UUID
   * @param {string} params.documentType - e.g. 'AADHAAR' or 'DRIVING_LICENSE'
   * @param {string} [params.status='PENDING'] - Document verification status
   * @param {string} [params.storageKey] - Reference to external document storage
   * @param {string} [params.documentNumber] - Document number (e.g. 12-digit Aadhaar)
   * @param {string} [params.fileName] - Name of uploaded document
   * @param {string} [params.side] - 'front' or 'back'
   * @param {Date|string} [params.verifiedAt] - Verification timestamp
   * @param {object} [params.metadata={}] - Structured metadata
   * @returns {Promise<object>} Created document entity
   */
  async create({
    userId,
    customerId,
    documentType,
    status = 'PENDING',
    storageKey = null,
    documentNumber = null,
    fileName = null,
    side = null,
    verifiedAt = null,
    metadata = {},
  }) {
    const ownerId = customerId || userId;
    const docTypeLower = (documentType || 'driving_license').toLowerCase();
    const statusLower = (status || 'pending').toLowerCase();
    const storagePath = storageKey || null;
    const resolvedFileName = fileName || (side ? `${docTypeLower}_${side}.jpg` : null);
    const enrichedMetadata = { ...metadata };
    if (side) enrichedMetadata.side = side;

    if (!storagePath) {
      throw new Error('storageKey is required for customer document creation');
    }

    try {
      // 1. Try authoritative Supabase table schema
      if (documentNumber !== null || verifiedAt !== null) {
        const text = `
          INSERT INTO customer_documents (
            customer_id,
            document_type,
            document_number,
            file_url,
            storage_path,
            verification_status,
            verified_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *
        `;
        const result = await this.query(text, [
          ownerId,
          docTypeLower,
          documentNumber,
          storagePath,
          storagePath,
          statusLower,
          verifiedAt,
        ]);
        return CustomerDocumentRepository.mapDocumentRow(result.rows[0]);
      } else {
        const text = `
          INSERT INTO customer_documents (
            customer_id,
            document_type,
            file_url,
            storage_path,
            verification_status
          ) VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `;
        const result = await this.query(text, [
          ownerId,
          docTypeLower,
          storagePath,
          storagePath,
          statusLower,
        ]);
        return CustomerDocumentRepository.mapDocumentRow(result.rows[0]);
      }
    } catch (err) {
      // 1. Fallback to legacy test table schema (pg-mem with user_id, storage_key, metadata)
      if (err.message && (err.message.includes('customer_id') || err.message.includes('storage_path') || err.message.includes('file_url') || err.message.includes('verification_status') || err.message.includes('user_id'))) {
        const text = `
          INSERT INTO customer_documents (
            user_id,
            document_type,
            status,
            storage_key,
            metadata
          ) VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `;
        if (documentNumber) enrichedMetadata.document_number = documentNumber;
        if (verifiedAt) enrichedMetadata.verified_at = verifiedAt;
        const result = await this.query(text, [
          ownerId,
          documentType,
          status,
          storageKey,
          JSON.stringify(enrichedMetadata),
        ]);
        return CustomerDocumentRepository.mapDocumentRow(result.rows[0]);
      }
      throw err;
    }
  }

  /**
   * Finds all documents belonging to a customer by user_id.
   *
   * @param {string} userId - User UUID
   * @returns {Promise<Array<object>>} List of document entities
   */
  async findByUserId(userId) {
    try {
      const text = `
        SELECT *
        FROM customer_documents
        WHERE customer_id = $1
        ORDER BY created_at DESC
      `;
      const result = await this.query(text, [userId]);
      return result.rows.map(CustomerDocumentRepository.mapDocumentRow);
    } catch {
      const text = `
        SELECT *
        FROM customer_documents
        WHERE user_id = $1
        ORDER BY created_at DESC
      `;
      const result = await this.query(text, [userId]);
      return result.rows.map(CustomerDocumentRepository.mapDocumentRow);
    }
  }

  /**
   * Finds a specific document by its ID and owning user_id (tenant-isolated).
   *
   * @param {string} id - Document UUID
   * @param {string} userId - Owning user UUID
   * @returns {Promise<object|null>}
   */
  async findByIdAndUserId(id, userId) {
    try {
      const text = `
        SELECT *
        FROM customer_documents
        WHERE id = $1 AND customer_id = $2
        LIMIT 1
      `;
      const result = await this.query(text, [id, userId]);
      return CustomerDocumentRepository.mapDocumentRow(result.rows[0]);
    } catch {
      const text = `
        SELECT *
        FROM customer_documents
        WHERE id = $1 AND user_id = $2
        LIMIT 1
      `;
      const result = await this.query(text, [id, userId]);
      return CustomerDocumentRepository.mapDocumentRow(result.rows[0]);
    }
  }

  /**
   * Finds the latest document of a specific type for a user.
   *
   * @param {string} userId - User UUID
   * @param {string} documentType - e.g. 'DRIVING_LICENSE'
   * @returns {Promise<object|null>}
   */
  async findLatestByUserAndType(userId, documentType) {
    const docTypeLower = (documentType || '').toLowerCase();
    try {
      const text = `
        SELECT *
        FROM customer_documents
        WHERE customer_id = $1 AND (document_type = $2 OR LOWER(document_type) = $3)
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const result = await this.query(text, [userId, documentType, docTypeLower]);
      return CustomerDocumentRepository.mapDocumentRow(result.rows[0]);
    } catch {
      const text = `
        SELECT *
        FROM customer_documents
        WHERE user_id = $1 AND (document_type = $2 OR LOWER(document_type) = $3)
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const result = await this.query(text, [userId, documentType, docTypeLower]);
      return CustomerDocumentRepository.mapDocumentRow(result.rows[0]);
    }
  }

  /**
   * Finds all documents of a specific type for a user (e.g. front and back).
   *
   * @param {string} userId - User UUID
   * @param {string} documentType - e.g. 'AADHAAR' or 'DRIVING_LICENSE'
   * @returns {Promise<Array<object>>}
   */
  async findByUserAndType(userId, documentType) {
    const docTypeLower = (documentType || '').toLowerCase();
    try {
      const text = `
        SELECT *
        FROM customer_documents
        WHERE customer_id = $1 AND (document_type = $2 OR LOWER(document_type) = $3)
        ORDER BY created_at DESC
      `;
      const result = await this.query(text, [userId, documentType, docTypeLower]);
      return result.rows.map(CustomerDocumentRepository.mapDocumentRow);
    } catch {
      const text = `
        SELECT *
        FROM customer_documents
        WHERE user_id = $1 AND (document_type = $2 OR LOWER(document_type) = $3)
        ORDER BY created_at DESC
      `;
      const result = await this.query(text, [userId, documentType, docTypeLower]);
      return result.rows.map(CustomerDocumentRepository.mapDocumentRow);
    }
  }

  /**
   * Updates all documents of a specific type for a user (e.g. marking all sides VERIFIED).
   *
   * @param {string} userId - User UUID
   * @param {string} documentType - e.g. 'AADHAAR'
   * @param {object} updates - Updates to apply: { status, documentNumber, verifiedAt }
   * @returns {Promise<Array<object>>}
   */
  async updateAllByUserAndType(userId, documentType, { status, documentNumber, verifiedAt }) {
    const docTypeLower = (documentType || '').toLowerCase();
    const statusLower = status ? status.toLowerCase() : undefined;
    const setClauses = [];
    const params = [];
    let idx = 1;

    if (status !== undefined) {
      setClauses.push(`verification_status = $${idx}`);
      params.push(statusLower);
      idx += 1;
    }
    if (documentNumber !== undefined) {
      setClauses.push(`document_number = $${idx}`);
      params.push(documentNumber);
      idx += 1;
    }
    if (verifiedAt !== undefined) {
      setClauses.push(`verified_at = $${idx}`);
      params.push(verifiedAt);
      idx += 1;
    }
    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    params.push(userId, documentType, docTypeLower);

    try {
      const text = `
        UPDATE customer_documents
        SET ${setClauses.join(', ')}
        WHERE customer_id = $${idx} AND (document_type = $${idx + 1} OR LOWER(document_type) = $${idx + 2})
        RETURNING *
      `;
      const result = await this.query(text, params);
      return result.rows.map(CustomerDocumentRepository.mapDocumentRow);
    } catch {
      const docs = await this.findByUserAndType(userId, documentType);
      const updated = [];
      for (const doc of docs) {
        const u = await this.updateDocument(doc.id, { status, documentNumber, verifiedAt });
        if (u) updated.push(u);
      }
      return updated;
    }
  }

  /**
   * Updates an existing document record.
   *
   * @param {string} id - Document UUID
   * @param {object} params
   * @param {string} [params.storageKey]
   * @param {string} [params.status]
   * @param {string} [params.documentNumber]
   * @param {Date|string} [params.verifiedAt]
   * @param {object} [params.metadata]
   * @param {object} [client] - Optional transactional client
   * @returns {Promise<object>} Updated document entity
   */
  async updateDocument(id, { storageKey, status, documentNumber, verifiedAt, metadata }, client = null) {
    const runner = client || this;
    const statusLower = status ? status.toLowerCase() : undefined;

    try {
      // 1. Try Supabase schema
      const setClauses = [];
      const params = [];
      let idx = 1;

      if (storageKey !== undefined) {
        setClauses.push(`storage_path = $${idx}`, `file_url = $${idx}`);
        params.push(storageKey);
        idx += 1;
      }
      if (status !== undefined) {
        setClauses.push(`verification_status = $${idx}`);
        params.push(statusLower);
        idx += 1;
      }
      if (documentNumber !== undefined) {
        setClauses.push(`document_number = $${idx}`);
        params.push(documentNumber);
        idx += 1;
      }
      if (verifiedAt !== undefined) {
        setClauses.push(`verified_at = $${idx}`);
        params.push(verifiedAt);
        idx += 1;
      }
      setClauses.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id);

      const text = `
        UPDATE customer_documents
        SET ${setClauses.join(', ')}
        WHERE id = $${idx}
        RETURNING *
      `;
      const result = await runner.query(text, params);
      return result.rows[0] ? CustomerDocumentRepository.mapDocumentRow(result.rows[0]) : null;
    } catch (err) {
      // 2. Fallback to legacy test schema
      const setClauses = [];
      const params = [];
      let idx = 1;

      if (storageKey !== undefined) {
        setClauses.push(`storage_key = $${idx}`);
        params.push(storageKey);
        idx += 1;
      }
      if (status !== undefined) {
        setClauses.push(`status = $${idx}`);
        params.push(status);
        idx += 1;
      }
      if (metadata !== undefined || documentNumber !== undefined || verifiedAt !== undefined) {
        const enriched = { ...(metadata || {}) };
        if (documentNumber !== undefined) enriched.document_number = documentNumber;
        if (verifiedAt !== undefined) enriched.verified_at = verifiedAt;
        setClauses.push(`metadata = $${idx}`);
        params.push(JSON.stringify(enriched));
        idx += 1;
      }
      setClauses.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id);

      const text = `
        UPDATE customer_documents
        SET ${setClauses.join(', ')}
        WHERE id = $${idx}
        RETURNING *
      `;
      const result = await runner.query(text, params);
      return result.rows[0] ? CustomerDocumentRepository.mapDocumentRow(result.rows[0]) : null;
    }
  }
}

module.exports = CustomerDocumentRepository;
