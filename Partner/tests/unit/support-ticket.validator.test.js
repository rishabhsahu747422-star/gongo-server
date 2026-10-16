'use strict';

const validator = require('../../src/validators/support-ticket.validator');
const { ValidationError } = require('../../src/errors');

describe('Unit: SupportTicketValidator', () => {
  describe('validateCreateTicket', () => {
    it('accepts valid ticket creation payload', () => {
      const result = validator.validateCreateTicket({
        subject: 'Cannot upload vehicle document',
        category: 'VEHICLE',
        priority: 'HIGH',
        message: 'RC upload returns upload failed error.',
        attachments: ['s3://bucket/rc_copy.pdf'],
      });

      expect(result.subject).toBe('Cannot upload vehicle document');
      expect(result.category).toBe('VEHICLE');
      expect(result.priority).toBe('HIGH');
      expect(result.message).toBe('RC upload returns upload failed error.');
      expect(result.attachments).toEqual(['s3://bucket/rc_copy.pdf']);
    });

    it('applies defaults for category and priority', () => {
      const result = validator.validateCreateTicket({
        subject: 'General enquiry',
        message: 'How do settlements work?',
      });

      expect(result.category).toBe('OTHER');
      expect(result.priority).toBe('MEDIUM');
      expect(result.attachments).toEqual([]);
    });

    it('rejects missing subject or message', () => {
      expect(() => validator.validateCreateTicket({}))
        .toThrow(ValidationError);
      expect(() => validator.validateCreateTicket({ subject: 'AB', message: 'Hi' }))
        .toThrow(ValidationError);
    });

    it('rejects invalid category or priority', () => {
      expect(() => validator.validateCreateTicket({
        subject: 'Valid subject',
        category: 'INVALID_CATEGORY',
        message: 'Valid message',
      })).toThrow(ValidationError);

      expect(() => validator.validateCreateTicket({
        subject: 'Valid subject',
        priority: 'EXTREME',
        message: 'Valid message',
      })).toThrow(ValidationError);
    });
  });

  describe('validateAddMessage', () => {
    it('accepts valid message with optional attachments', () => {
      const result = validator.validateAddMessage({
        message: 'Here is the invoice screenshot.',
        attachments: ['https://example.com/invoice.png'],
      });

      expect(result.message).toBe('Here is the invoice screenshot.');
      expect(result.attachments).toEqual(['https://example.com/invoice.png']);
    });

    it('rejects empty message', () => {
      expect(() => validator.validateAddMessage({ message: '' }))
        .toThrow(ValidationError);
      expect(() => validator.validateAddMessage({}))
        .toThrow(ValidationError);
    });
  });

  describe('validateTicketListQuery', () => {
    it('parses valid query parameters', () => {
      const opts = validator.validateTicketListQuery({
        status: 'OPEN',
        category: 'PAYOUT',
        priority: 'URGENT',
        page: '2',
        limit: '15',
      });

      expect(opts.status).toBe('OPEN');
      expect(opts.category).toBe('PAYOUT');
      expect(opts.priority).toBe('URGENT');
      expect(opts.page).toBe(2);
      expect(opts.limit).toBe(15);
      expect(opts.offset).toBe(15);
    });

    it('ignores ALL filters', () => {
      const opts = validator.validateTicketListQuery({
        status: 'ALL',
        category: 'ALL',
        priority: 'ALL',
      });

      expect(opts.status).toBeUndefined();
      expect(opts.category).toBeUndefined();
      expect(opts.priority).toBeUndefined();
    });

    it('rejects invalid enum filters or invalid page numbers', () => {
      expect(() => validator.validateTicketListQuery({ status: 'BOGUS' }))
        .toThrow(ValidationError);
      expect(() => validator.validateTicketListQuery({ page: '0' }))
        .toThrow(ValidationError);
      expect(() => validator.validateTicketListQuery({ limit: '200' }))
        .toThrow(ValidationError);
    });
  });

  describe('validateStatusUpdate', () => {
    it('accepts valid status and priority updates', () => {
      const result = validator.validateStatusUpdate({
        status: 'RESOLVED',
        priority: 'LOW',
      });

      expect(result.status).toBe('RESOLVED');
      expect(result.priority).toBe('LOW');
    });

    it('rejects empty update or invalid status', () => {
      expect(() => validator.validateStatusUpdate({}))
        .toThrow(ValidationError);
      expect(() => validator.validateStatusUpdate({ status: 'INVALID' }))
        .toThrow(ValidationError);
    });
  });
});
