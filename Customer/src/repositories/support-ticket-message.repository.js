'use strict';

const BaseRepository = require('./base.repository');

/**
 * SupportTicketMessageRepository — database operations for ticket conversation messages mapped to Supabase.
 * Table: public.support_messages (id, ticket_id, sender_id, message, is_internal, created_at)
 */
class SupportTicketMessageRepository extends BaseRepository {
  /**
   * Projects database row to customer-safe DTO.
   *
   * @param {object|null} row
   * @returns {object|null}
   */
  static mapDto(row) {
    if (!row) return null;

    let attachments = row.attachments || [];
    if (typeof attachments === 'string') {
      try {
        attachments = JSON.parse(attachments);
      } catch {
        attachments = [];
      }
    }

    return {
      id: row.id,
      ticketId: row.ticket_id,
      senderType: row.is_internal ? 'SUPPORT' : (row.sender_type || 'CUSTOMER'),
      senderId: row.sender_id,
      message: row.message,
      attachments: Array.isArray(attachments) ? attachments : [],
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }

  /**
   * Appends a message to a ticket conversation.
   *
   * @param {object} params
   * @param {string} params.ticketId
   * @param {string} [params.senderType]
   * @param {string} params.senderId
   * @param {string} params.message
   * @param {Array<object>} [params.attachments]
   * @param {object} [client]
   * @returns {Promise<object>}
   */
  async create(
    {
      ticketId,
      senderType = 'CUSTOMER',
      senderId,
      message,
      attachments = [],
    },
    client = null,
  ) {
    const isInternal = senderType === 'SUPPORT' || senderType === 'ADMIN';
    const normalizedSenderType = (senderType || 'CUSTOMER').toUpperCase();
    const runner = client || this;
    const jsonAttachments = JSON.stringify(Array.isArray(attachments) ? attachments : []);

    let createdMsg = null;

    // 1. Insert into support_ticket_messages (shared with Admin panel)
    try {
      const sql = `
        INSERT INTO support_ticket_messages (
          ticket_id, sender_type, sender_id, message, attachments, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, CURRENT_TIMESTAMP
        )
        RETURNING *
      `;

      const res = await runner.query(sql, [
        ticketId,
        normalizedSenderType,
        senderId,
        message,
        jsonAttachments,
      ]);

      createdMsg = res.rows[0];
    } catch (err) {
      // Non-fatal if support_ticket_messages table has issues, will fallback
    }

    // 2. Also insert into support_messages (if table exists)
    try {
      const sql = `
        INSERT INTO support_messages (
          ticket_id, sender_id, message, is_internal, sender_type, attachments
        ) VALUES (
          $1, $2, $3, $4, $5, $6
        )
        RETURNING *
      `;

      const res = await runner.query(sql, [
        ticketId,
        senderId,
        message,
        isInternal,
        normalizedSenderType,
        jsonAttachments,
      ]);

      if (!createdMsg) {
        createdMsg = res.rows[0];
      }
    } catch {
      // Non-fatal
    }

    if (!createdMsg) {
      throw new Error('Failed to create support ticket message in database');
    }

    return SupportTicketMessageRepository.mapDto({
      ...createdMsg,
      sender_type: normalizedSenderType,
      attachments,
    });
  }

  /**
   * Retrieves all messages for a ticket ordered chronologically.
   *
   * @param {string} ticketId
   * @param {object} [client]
   * @returns {Promise<object[]>}
   */
  async findByTicketId(ticketId, client = null) {
    const runner = client || this;
    try {
      const sql = `
        SELECT *
        FROM support_ticket_messages
        WHERE ticket_id = $1
        ORDER BY created_at ASC
      `;
      const res = await runner.query(sql, [ticketId]);
      if (res && res.rows && res.rows.length > 0) {
        return res.rows
          .filter((row) => row.is_internal !== true)
          .map(SupportTicketMessageRepository.mapDto);
      }
    } catch (err) {
      // Fall through to fallback
    }

    try {
      const sql = `
        SELECT
          sm.*,
          COALESCE(
            json_agg(
              json_build_object(
                'id', sa.id,
                'storagePath', sa.storage_path,
                'fileUrl', sa.file_url
              )
            ) FILTER (WHERE sa.id IS NOT NULL),
            '[]'::json
          ) AS attachments
        FROM support_messages sm
        LEFT JOIN support_attachments sa ON sa.message_id = sm.id
        WHERE sm.ticket_id = $1 AND (sm.is_internal = false OR sm.is_internal IS NULL)
        GROUP BY sm.id
        ORDER BY sm.created_at ASC
      `;
      const res = await runner.query(sql, [ticketId]);
      return res.rows.map(SupportTicketMessageRepository.mapDto);
    } catch (err) {
      return [];
    }
  }
}

module.exports = SupportTicketMessageRepository;
