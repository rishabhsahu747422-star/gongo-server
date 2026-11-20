'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../config/logger');
const {
  CustomerRepository,
  CustomerDocumentRepository,
  CustomerIdentityVerificationRepository,
} = require('../repositories');
const { defaultProvider: defaultDigiLockerProvider } = require('../providers/digilocker.provider');
const { getSupabaseAdmin } = require('../providers/supabase');
const { redisClient } = require('../config/redis');
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ServiceUnavailableError,
} = require('../errors');
const {
  AADHAAR_VERIFICATION_STATUS,
  AADHAAR_DOCUMENT_TYPE,
  AADHAAR_PROVIDERS,
  AUDIT_EVENT_TYPES,
  AADHAAR_CONSTANTS,
} = require('../constants/aadhaar');

/**
 * AadhaarVerificationService coordinates:
 * - DigiLocker OAuth session creation with cryptographic state protection
 * - Authorization callback handling, state validation, and error classification
 * - XML validation and safe Supabase Storage persistence in 'customer-identity-documents'
 * - Idempotent database record updates with customer association
 * - Non-sensitive audit logging
 * - Customer status queries
 */
class AadhaarVerificationService {
  constructor({
    customerRepo = new CustomerRepository(),
    documentRepo = new CustomerDocumentRepository(),
    verificationRepo = new CustomerIdentityVerificationRepository(),
    digilocker = defaultDigiLockerProvider,
    redis = redisClient,
    supabase = getSupabaseAdmin,
  } = {}) {
    this.customerRepository = customerRepo;
    this.documentRepository = documentRepo;
    this.verificationRepository = verificationRepo;
    this.digiLockerProvider = digilocker;
    this.redisClient = redis;
    this.getSupabase = supabase;
  }

  /**
   * Helper to format Redis state session key.
   *
   * @param {string} state
   * @returns {string}
   */
  static getStateKey(state) {
    return `aadhaar:session:${state}`;
  }

  /**
   * Initiates DigiLocker Aadhaar verification for an authenticated customer.
   *
   * @param {string} customerId - Authenticated customer UUID from token
   * @param {object} options
   * @param {string} [options.redirectUri] - Custom callback URI
   * @param {string} [options.ipAddress] - Client IP for consent log
   * @param {string} [options.userAgent] - Client User-Agent
   * @returns {Promise<{ verificationId: string, authorizationUrl: string, state: string, provider: string }>}
   */
  async initiateVerification(customerId, options = {}) {
    // 1. Verify customer exists and is active
    const user = await this.customerRepository.findById(customerId);
    if (!user) {
      throw new NotFoundError('Customer not found', 'CUSTOMER_NOT_FOUND');
    }
    if (!user.isActive) {
      throw new ForbiddenError('Customer account is deactivated', 'AUTH_USER_INACTIVE');
    }

    // 2. Generate unique IDs and cryptographic state
    const verificationId = crypto.randomUUID();
    const stateToken = this.digiLockerProvider.generateState();
    const redirectUri = this.digiLockerProvider.resolveRedirectUri(options.redirectUri);

    // 3. Initiate session with DigiLocker provider
    const session = await this.digiLockerProvider.initiateSession({
      customerId,
      state: stateToken,
      redirectUri,
    });

    const consentRecord = {
      consentGiven: true,
      purpose: 'GONGO vehicle rental customer identity verification',
      consentTimestamp: new Date().toISOString(),
      state: stateToken,
      ipAddress: options.ipAddress || null,
      userAgent: options.userAgent || null,
    };

    // 4. Persist pending record in PostgreSQL
    await this.verificationRepository.createVerification({
      id: verificationId,
      customerId,
      documentType: AADHAAR_DOCUMENT_TYPE,
      verificationStatus: AADHAAR_VERIFICATION_STATUS.IN_PROGRESS,
      provider: session.provider || AADHAAR_PROVIDERS.DIGILOCKER_SANDBOX,
      providerReferenceId: session.providerReferenceId || null,
      consentRecord,
    });

    // 5. Store session in Redis with 15m TTL
    const sessionData = {
      verificationId,
      customerId,
      state: stateToken,
      redirectUri,
      createdAt: new Date().toISOString(),
    };

    if (this.redisClient && typeof this.redisClient.set === 'function') {
      try {
        await this.redisClient.set(
          AadhaarVerificationService.getStateKey(stateToken),
          JSON.stringify(sessionData),
          'EX',
          AADHAAR_CONSTANTS.STATE_TTL_SECONDS,
        );
      } catch (redisErr) {
        logger.warn('[AADHAAR_SERVICE] Failed to cache session in Redis, relying on database', {
          error: redisErr.message,
        });
      }
    }

    // 6. Record non-sensitive audit event
    await this.verificationRepository.createAuditEvent({
      verificationId,
      customerId,
      eventType: AUDIT_EVENT_TYPES.SESSION_INITIATED,
      provider: session.provider,
      details: {
        redirectUri,
        timestamp: new Date().toISOString(),
      },
    });

    logger.info('[AADHAAR_SERVICE] Initiated Aadhaar verification session', {
      customerId,
      verificationId,
      provider: session.provider,
    });

    return {
      verificationId,
      authorizationUrl: session.authorizationUrl,
      state: stateToken,
      provider: session.provider,
    };
  }

  /**
   * Handles DigiLocker / Sandbox callback, retrieves & validates XML,
   * securely persists file to Supabase Storage, and updates database idempotently.
   *
   * @param {object} params
   * @param {string} [params.state] - OAuth CSRF state parameter
   * @param {string} [params.code] - Authorization code (Direct OAuth)
   * @param {string} [params.sessionId] - Sandbox session identifier (Sandbox flow)
   * @param {string} [params.error] - Provider error code (e.g. access_denied)
   * @param {string} [params.errorDescription] - Provider error description
   * @param {string} [params.ipAddress] - Callback IP address
   * @returns {Promise<{ status: string, verificationId: string, message: string, maskedAadhaar?: string }>}
   */
  async handleCallback({ state, code, sessionId, error, errorDescription, ipAddress }) {
    if ((!state || typeof state !== 'string') && (!sessionId || typeof sessionId !== 'string')) {
      throw new BadRequestError('Missing OAuth state or session identifier', 'AADHAAR_MISSING_STATE');
    }

    // 1. Resolve session from Redis or Database
    let session = null;
    let verification = null;

    if (state && typeof state === 'string') {
      if (this.redisClient && typeof this.redisClient.get === 'function') {
        try {
          const raw = await this.redisClient.get(AadhaarVerificationService.getStateKey(state));
          if (raw) {
            session = JSON.parse(raw);
          }
        } catch (redisErr) {
          logger.warn('[AADHAAR_SERVICE] Redis state lookup failed, fallback to DB', { error: redisErr.message });
        }
      }

      if (session && session.verificationId) {
        verification = await this.verificationRepository.findById(session.verificationId);
      }

      if (!verification && typeof this.verificationRepository.query === 'function') {
        // Fallback: check database by state token in consent_record
        const text = `
          SELECT * FROM customer_identity_verifications
          WHERE consent_record->>'state' = $1
          ORDER BY created_at DESC
          LIMIT 1;
        `;
        const res = await this.verificationRepository.query(text, [state]);
        if (res && res.rows && res.rows.length > 0) {
          verification = CustomerIdentityVerificationRepository.mapRow(res.rows[0]);
        }
      }
    } else if (sessionId && typeof sessionId === 'string') {
      // Sandbox redirect flow: provider redirects back with session_id query param
      if (typeof this.verificationRepository.findByProviderReferenceId === 'function') {
        verification = await this.verificationRepository.findByProviderReferenceId(sessionId);
      }
    }

    if (!verification) {
      throw new BadRequestError('Invalid or expired verification session', 'AADHAAR_INVALID_SESSION');
    }

    // Check session timeout: session should not exceed STATE_TTL_SECONDS (15 minutes)
    if (verification.createdAt) {
      const sessionAgeSeconds = (Date.now() - new Date(verification.createdAt).getTime()) / 1000;
      if (sessionAgeSeconds > AADHAAR_CONSTANTS.STATE_TTL_SECONDS) {
        throw new BadRequestError('Verification session has expired', 'AADHAAR_SESSION_EXPIRED');
      }
    }

    // A supplied sessionId alone cannot mismatch the session associated with the validated record
    if (sessionId && verification.providerReferenceId && sessionId !== verification.providerReferenceId) {
      throw new BadRequestError('Session ID does not match the stored verification session', 'AADHAAR_SESSION_MISMATCH');
    }

    const { customerId, id: verificationId } = verification;

    // Record callback audit event
    await this.verificationRepository.createAuditEvent({
      verificationId,
      customerId,
      eventType: AUDIT_EVENT_TYPES.CALLBACK_RECEIVED,
      provider: verification.provider,
      details: {
        hasCode: Boolean(code),
        hasSessionId: Boolean(sessionId),
        hasError: Boolean(error),
        ipAddress: ipAddress || null,
        timestamp: new Date().toISOString(),
      },
    });

    // 2. Handle User Cancellation or Provider Error
    if (error) {
      const isCancellation = error === 'access_denied'
        || error === 'user_cancelled'
        || (errorDescription && errorDescription.toLowerCase().includes('cancel'));

      const targetStatus = isCancellation
        ? AADHAAR_VERIFICATION_STATUS.CANCELLED
        : AADHAAR_VERIFICATION_STATUS.FAILED;

      await this.verificationRepository.updateVerification(verificationId, {
        verificationStatus: targetStatus,
        errorDetails: {
          error,
          errorDescription: errorDescription || null,
          cancelledAt: new Date().toISOString(),
        },
      });

      await this.verificationRepository.createAuditEvent({
        verificationId,
        customerId,
        eventType: isCancellation
          ? AUDIT_EVENT_TYPES.VERIFICATION_CANCELLED
          : AUDIT_EVENT_TYPES.VERIFICATION_FAILED,
        provider: verification.provider,
        details: {
          error,
          errorDescription: errorDescription || null,
        },
      });

      logger.warn('[AADHAAR_SERVICE] DigiLocker verification aborted or failed', {
        customerId,
        verificationId,
        status: targetStatus,
        error,
      });

      return {
        status: targetStatus,
        verificationId,
        message: isCancellation
          ? 'DigiLocker authorization was cancelled by the user.'
          : (errorDescription || 'DigiLocker authorization failed.'),
      };
    }

    // 3. Idempotency Check: if verification is already VERIFIED, return immediately
    if (verification.verificationStatus === AADHAAR_VERIFICATION_STATUS.VERIFIED) {
      logger.info('[AADHAAR_SERVICE] Callback replayed for already verified session', {
        verificationId,
        customerId,
      });
      return {
        status: AADHAAR_VERIFICATION_STATUS.VERIFIED,
        verificationId,
        message: 'Aadhaar verification already completed.',
        maskedAadhaar: verification.consentRecord?.maskedAadhaar || null,
      };
    }

    // 4. Token exchange (Direct OAuth flow) OR direct session retrieval (Sandbox flow)
    let tokenData = null;
    const activeSessionId = sessionId || (verification.provider === AADHAAR_PROVIDERS.DIGILOCKER_SANDBOX ? verification.providerReferenceId : null);

    if (!code && activeSessionId) {
      // In Sandbox KYC flow, Sandbox manages OAuth tokens internally.
      // Confirm session status with Sandbox provider before document retrieval.
      if (typeof this.digiLockerProvider.getSessionStatus === 'function') {
        const sessionStatus = await this.digiLockerProvider.getSessionStatus(activeSessionId);

        if (sessionStatus && sessionStatus.isExpired) {
          logger.warn('[AADHAAR_SERVICE] Sandbox session has expired', {
            sessionId: activeSessionId,
            status: sessionStatus.status,
          });
          await this.verificationRepository.updateVerification(verificationId, {
            verificationStatus: AADHAAR_VERIFICATION_STATUS.EXPIRED,
            errorDetails: { reason: 'Provider session expired', providerStatus: sessionStatus.status },
          });
          await this.verificationRepository.createAuditEvent({
            verificationId,
            customerId,
            eventType: AUDIT_EVENT_TYPES.VERIFICATION_FAILED,
            provider: verification.provider,
            details: { step: 'PROVIDER_STATUS_CHECK', status: 'expired' },
          });
          throw new BadRequestError('DigiLocker verification session has expired', 'AADHAAR_SESSION_EXPIRED');
        }

        if (sessionStatus && sessionStatus.isFailed) {
          logger.warn('[AADHAAR_SERVICE] Sandbox session authorization failed on provider', {
            sessionId: activeSessionId,
            status: sessionStatus.status,
          });
          await this.verificationRepository.updateVerification(verificationId, {
            verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
            errorDetails: { reason: 'Provider session status failed', providerStatus: sessionStatus.status },
          });
          await this.verificationRepository.createAuditEvent({
            verificationId,
            customerId,
            eventType: AUDIT_EVENT_TYPES.VERIFICATION_FAILED,
            provider: verification.provider,
            details: { step: 'PROVIDER_STATUS_CHECK', status: sessionStatus.status },
          });
          throw new BadRequestError('DigiLocker authorization failed or was denied by the user', 'AADHAAR_SESSION_FAILED');
        }

        if (sessionStatus && (sessionStatus.isPending || (!sessionStatus.isAuthorized && !sessionStatus.isCompleted))) {
          logger.warn('[AADHAAR_SERVICE] Sandbox session authorization pending or incomplete', {
            sessionId: activeSessionId,
            status: sessionStatus.status,
          });
          throw new BadRequestError(`DigiLocker session authorization is not completed (status: ${sessionStatus.status || 'unknown'})`, 'AADHAAR_SESSION_NOT_COMPLETED');
        }

        // Validate Aadhaar consent if documents_consented is reported by provider
        if (sessionStatus && Array.isArray(sessionStatus.documentsConsented) && sessionStatus.documentsConsented.length > 0) {
          const hasAadhaarConsent = sessionStatus.documentsConsented.some(
            (doc) => String(doc).toLowerCase() === 'aadhaar'
          );
          if (!hasAadhaarConsent) {
            logger.warn('[AADHAAR_SERVICE] Customer did not grant consent for Aadhaar document', {
              sessionId: activeSessionId,
              consented: sessionStatus.documentsConsented,
            });
            await this.verificationRepository.updateVerification(verificationId, {
              verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
              errorDetails: { reason: 'Aadhaar consent missing from consented documents', consented: sessionStatus.documentsConsented },
            });
            throw new BadRequestError('Consent for Aadhaar was not granted during DigiLocker authorization', 'AADHAAR_CONSENT_MISSING');
          }
        }

        logger.info('[AADHAAR_SERVICE] Sandbox session authorization confirmed', {
          sessionId: activeSessionId,
          status: sessionStatus.status,
        });
      }
    } else if (code) {
      // Direct Government DigiLocker OAuth flow
      try {
        tokenData = await this.digiLockerProvider.exchangeCodeForToken({
          code,
          redirectUri: session?.redirectUri,
        });
        await this.verificationRepository.createAuditEvent({
          verificationId,
          customerId,
          eventType: AUDIT_EVENT_TYPES.TOKEN_EXCHANGED,
          provider: verification.provider,
          details: { expiresIn: tokenData.expiresIn },
        });
      } catch (tokenErr) {
        await this.verificationRepository.updateVerification(verificationId, {
          verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
          errorDetails: { reason: 'Token exchange failed', message: tokenErr.message },
        });
        await this.verificationRepository.createAuditEvent({
          verificationId,
          customerId,
          eventType: AUDIT_EVENT_TYPES.VERIFICATION_FAILED,
          provider: verification.provider,
          details: { step: 'TOKEN_EXCHANGE', error: tokenErr.message },
        });
        throw tokenErr;
      }
    } else {
      await this.verificationRepository.updateVerification(verificationId, {
        verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
        errorDetails: { reason: 'No authorization code or session ID returned' },
      });
      throw new BadRequestError('No authorization code provided in callback', 'AADHAAR_MISSING_AUTH_CODE');
    }

    // 5. Fetch Aadhaar XML document from DigiLocker or Sandbox
    let docData;
    try {
      const fetchParams = tokenData?.accessToken
        ? { accessToken: tokenData.accessToken }
        : { sessionId: activeSessionId };
      docData = await this.digiLockerProvider.fetchAadhaarXml(fetchParams);
      await this.verificationRepository.createAuditEvent({
        verificationId,
        customerId,
        eventType: AUDIT_EVENT_TYPES.DOCUMENT_FETCHED,
        provider: verification.provider,
        details: {
          documentType: docData.documentType,
          isAuthorized: docData.isAuthorized,
        },
      });
    } catch (docErr) {
      await this.verificationRepository.updateVerification(verificationId, {
        verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
        errorDetails: { reason: 'Document fetch failed', message: docErr.message },
      });
      await this.verificationRepository.createAuditEvent({
        verificationId,
        customerId,
        eventType: AUDIT_EVENT_TYPES.VERIFICATION_FAILED,
        provider: verification.provider,
        details: { step: 'DOCUMENT_FETCH', error: docErr.message },
      });
      throw docErr;
    }

    // 6. Handle XML Storage based on retention permission
    let storageBucket = null;
    let storagePath = null;
    const isRetentionPermitted = env.AADHAAR_XML_RETENTION_ENABLED;

    if (isRetentionPermitted && docData.xmlContent) {
      storageBucket = env.AADHAAR_STORAGE_BUCKET || AADHAAR_CONSTANTS.DEFAULT_STORAGE_BUCKET;
      storagePath = `${customerId}/aadhaar/${verificationId}.xml`;

      try {
        const client = typeof this.getSupabase === 'function' ? this.getSupabase() : this.getSupabase;
        if (client && client.storage) {
          const xmlBuffer = Buffer.from(docData.xmlContent, 'utf8');
          const { error: uploadErr } = await client.storage
            .from(storageBucket)
            .upload(storagePath, xmlBuffer, {
              contentType: 'application/xml',
              upsert: true,
            });

          if (uploadErr) {
            logger.error('[AADHAAR_SERVICE] Supabase Storage upload failed', {
              customerId,
              verificationId,
              storageBucket,
              storagePath,
              error: uploadErr.message,
            });
            throw new ServiceUnavailableError('Failed to persist identity document to secure storage', 'STORAGE_UPLOAD_ERROR');
          }

          await this.verificationRepository.createAuditEvent({
            verificationId,
            customerId,
            eventType: AUDIT_EVENT_TYPES.STORAGE_PERSISTED,
            provider: verification.provider,
            details: {
              storageBucket,
              storagePath,
              sizeBytes: xmlBuffer.length,
            },
          });
        }
      } catch (storageErr) {
        await this.verificationRepository.updateVerification(verificationId, {
          verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
          errorDetails: { reason: 'Storage upload failed', message: storageErr.message },
        });
        throw storageErr;
      }
    } else if (!isRetentionPermitted) {
      logger.info('[AADHAAR_SERVICE] Aadhaar XML retention is disabled; retaining permitted metadata only', {
        customerId,
        verificationId,
      });
    }

    // 7. Update verification status in PostgreSQL
    const verifiedAt = new Date();
    const updatedConsent = {
      ...(verification.consentRecord || {}),
      maskedAadhaar: docData.maskedAadhaar || null,
      retentionPermitted: isRetentionPermitted,
      verifiedAt: verifiedAt.toISOString(),
    };

    const updatedVerification = await this.verificationRepository.updateVerification(verificationId, {
      verificationStatus: AADHAAR_VERIFICATION_STATUS.VERIFIED,
      storageBucket,
      storagePath,
      verifiedAt,
      providerReferenceId: tokenData?.digilockerId || sessionId || verification.providerReferenceId,
      consentRecord: updatedConsent,
    });

    // 8. Update customer_documents table so existing KYC checks recognize customer as verified
    try {
      await this.documentRepository.create({
        userId: customerId,
        documentType: AADHAAR_DOCUMENT_TYPE,
        status: 'VERIFIED',
        storageKey: storagePath || 'digilocker/verified',
        metadata: {
          verificationId,
          provider: verification.provider,
          maskedAadhaar: docData.maskedAadhaar || null,
          source: 'DIGILOCKER_XML',
        },
        verifiedAt,
      });
    } catch (docRepoErr) {
      logger.warn('[AADHAAR_SERVICE] Note: customer_documents secondary entry warning', {
        error: docRepoErr.message,
      });
    }

    // 9. Update Redis session state with short retention to handle immediate callback replays
    if (this.redisClient && typeof this.redisClient.set === 'function') {
      try {
        await this.redisClient.set(
          AadhaarVerificationService.getStateKey(state),
          JSON.stringify({
            verificationId,
            customerId,
            verificationStatus: AADHAAR_VERIFICATION_STATUS.VERIFIED,
          }),
          'EX',
          300,
        );
      } catch (_) {}
    }

    // 10. Audit event: VERIFICATION_COMPLETED
    await this.verificationRepository.createAuditEvent({
      verificationId,
      customerId,
      eventType: AUDIT_EVENT_TYPES.VERIFICATION_COMPLETED,
      provider: verification.provider,
      details: {
        verifiedAt: verifiedAt.toISOString(),
        hasStoragePath: Boolean(storagePath),
        maskedAadhaar: docData.maskedAadhaar || null,
      },
    });

    logger.info('[AADHAAR_SERVICE] Aadhaar verification completed successfully', {
      customerId,
      verificationId,
      maskedAadhaar: docData.maskedAadhaar || null,
    });

    return {
      status: AADHAAR_VERIFICATION_STATUS.VERIFIED,
      verificationId,
      message: 'Aadhaar verification completed successfully.',
      maskedAadhaar: docData.maskedAadhaar || null,
    };
  }

  /**
   * Retrieves the current customer's authoritative Aadhaar verification status.
   *
   * @param {string} customerId
   * @returns {Promise<object>} Safe DTO
   */
  async getStatus(customerId) {
    const user = await this.customerRepository.findById(customerId);
    if (!user) {
      throw new NotFoundError('Customer not found', 'CUSTOMER_NOT_FOUND');
    }

    const latest = await this.verificationRepository.findLatestByCustomerId(customerId, AADHAAR_DOCUMENT_TYPE);
    if (!latest) {
      return {
        verificationStatus: AADHAAR_VERIFICATION_STATUS.NOT_VERIFIED,
        isVerified: false,
        verifiedAt: null,
        maskedAadhaar: null,
        lastAttempt: null,
      };
    }

    return {
      verificationStatus: latest.verificationStatus,
      isVerified: latest.verificationStatus === AADHAAR_VERIFICATION_STATUS.VERIFIED,
      verifiedAt: latest.verifiedAt,
      maskedAadhaar: latest.consentRecord?.maskedAadhaar || null,
      lastAttempt: latest.createdAt,
      provider: latest.provider,
    };
  }

  /**
   * Generates short-lived signed download URL for customer to view verified XML
   * ONLY if access is authorized, XML exists, and retention is permitted.
   *
   * @param {string} customerId
   * @param {string} verificationId
   * @returns {Promise<{ downloadUrl: string, expiresInSeconds: number }>}
   */
  async getSignedDocumentUrl(customerId, verificationId) {
    const verification = await this.verificationRepository.findById(verificationId);
    if (!verification) {
      throw new NotFoundError('Verification record not found', 'VERIFICATION_NOT_FOUND');
    }

    if (verification.customerId !== customerId) {
      throw new ForbiddenError('Unauthorized access to identity document', 'FORBIDDEN_DOCUMENT_ACCESS');
    }

    if (verification.verificationStatus !== AADHAAR_VERIFICATION_STATUS.VERIFIED || !verification.storagePath) {
      throw new BadRequestError('Document is not verified or storage is not available', 'DOCUMENT_NOT_AVAILABLE');
    }

    const client = typeof this.getSupabase === 'function' ? this.getSupabase() : this.getSupabase;
    const bucket = verification.storageBucket || env.AADHAAR_STORAGE_BUCKET || AADHAAR_CONSTANTS.DEFAULT_STORAGE_BUCKET;
    const expirySeconds = 60; // 60 seconds short-lived URL

    const { data, error } = await client.storage
      .from(bucket)
      .createSignedUrl(verification.storagePath, expirySeconds);

    if (error || !data?.signedUrl) {
      throw new ServiceUnavailableError('Unable to generate secure download URL', 'STORAGE_SIGN_ERROR');
    }

    return {
      downloadUrl: data.signedUrl,
      expiresInSeconds: expirySeconds,
    };
  }
}

module.exports = AadhaarVerificationService;
module.exports.defaultService = new AadhaarVerificationService();
