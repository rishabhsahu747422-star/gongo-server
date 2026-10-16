'use strict';

const auditService = require('../../src/services/audit.service');

describe('Unit: Audit Hook & Metadata Redaction', () => {
  it('throws error if required fields are missing in logAdminAction', () => {
    expect(() => {
      auditService.logAdminAction({
        actorId: 'admin-1',
        action: 'APPROVE_KYC',
      });
    }).toThrow(/Audit record requires actorId, action, and targetResource/);
  });

  it('records structured admin audit action successfully', () => {
    const record = auditService.logAdminAction({
      actorId: 'admin-123',
      actorRole: 'ADMIN',
      permission: 'VERIFICATION_ADMIN',
      action: 'APPROVE_PARTNER_KYC',
      targetResource: 'PARTNER',
      targetResourceId: 'partner-789',
      requestId: 'req-abc-123',
      ipAddress: '127.0.0.1',
      userAgent: 'JestTestRunner/1.0',
      beforeState: { kycStatus: 'PENDING' },
      afterState: { kycStatus: 'VERIFIED' },
      metadata: { reason: 'All documents verified' },
    });

    expect(record.isAuditEvent).toBe(true);
    expect(record.actorId).toBe('admin-123');
    expect(record.actorRole).toBe('ADMIN');
    expect(record.permission).toBe('VERIFICATION_ADMIN');
    expect(record.action).toBe('APPROVE_PARTNER_KYC');
    expect(record.targetResource).toBe('PARTNER');
    expect(record.targetResourceId).toBe('partner-789');
    expect(record.requestId).toBe('req-abc-123');
    expect(record.ipAddress).toBe('127.0.0.1');
    expect(record.userAgent).toBe('JestTestRunner/1.0');
    expect(record.beforeState.kycStatus).toBe('PENDING');
    expect(record.afterState.kycStatus).toBe('VERIFIED');
    expect(record.timestamp).toBeDefined();
  });

  it('recursively redacts sensitive keys from metadata and states', () => {
    const record = auditService.logAdminAction({
      actorId: 'admin-123',
      action: 'UPDATE_ADMIN_CREDENTIALS',
      targetResource: 'ADMIN_USER',
      targetResourceId: 'admin-456',
      metadata: {
        password: 'PlainTextPassword123!',
        token: 'secret-bearer-token',
        otp: '123456',
        nested: {
          accountNumber: '9876543210',
          cvv: '999',
          safeField: 'visible-info',
        },
      },
    });

    expect(record.metadata.password).toBe('[REDACTED]');
    expect(record.metadata.token).toBe('[REDACTED]');
    expect(record.metadata.otp).toBe('[REDACTED]');
    expect(record.metadata.nested.accountNumber).toBe('[REDACTED]');
    expect(record.metadata.nested.cvv).toBe('[REDACTED]');
    expect(record.metadata.nested.safeField).toBe('visible-info');
  });
});
