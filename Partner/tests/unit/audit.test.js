'use strict';

const auditService = require('../../src/services/audit.service');

describe('Unit: Audit Service Foundation', () => {
  it('emits structured audit event with required fields', () => {
    const event = auditService.logEvent({
      actorId: 'partner-123',
      actorRole: 'PARTNER',
      action: 'VEHICLE_ADD',
      entityType: 'VEHICLE',
      entityId: 'veh-001',
      requestId: 'req-abc-123',
      metadata: { model: 'Activa 6G', registration: 'MP04AB1234' },
    });

    expect(event.isAuditEvent).toBe(true);
    expect(event.actorId).toBe('partner-123');
    expect(event.actorRole).toBe('PARTNER');
    expect(event.action).toBe('VEHICLE_ADD');
    expect(event.entityType).toBe('VEHICLE');
    expect(event.entityId).toBe('veh-001');
    expect(event.requestId).toBe('req-abc-123');
    expect(event.timestamp).toBeDefined();
    expect(event.metadata.model).toBe('Activa 6G');
  });

  it('redacts sensitive fields in audit metadata', () => {
    const event = auditService.logEvent({
      actorId: 'partner-123',
      action: 'KYC_UPLOAD',
      entityType: 'DOCUMENT',
      entityId: 'doc-001',
      metadata: {
        documentName: 'Aadhaar Card',
        password: 'secret_file_pass',
        token: 'auth_token_xyz',
        bankAccountNumber: '98765432101234',
        kycData: { fullAadhaar: '123456789012' },
      },
    });

    expect(event.metadata.documentName).toBe('Aadhaar Card');
    expect(event.metadata.password).toBe('[REDACTED]');
    expect(event.metadata.token).toBe('[REDACTED]');
    expect(event.metadata.bankAccountNumber).toBe('[REDACTED]');
    expect(event.metadata.kycData).toBe('[REDACTED]');
  });

  it('throws error when required audit parameters are missing', () => {
    expect(() => {
      auditService.logEvent({
        actorId: 'partner-123',
        // missing action, entityType, entityId
      });
    }).toThrow('Audit event requires actorId, action, entityType, and entityId');
  });
});
