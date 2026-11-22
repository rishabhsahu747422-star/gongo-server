'use strict';

const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const env = require('../config/env');
const logger = require('../config/logger');
const {
  CustomerRepository,
  CustomerDocumentRepository,
  CustomerIdentityVerificationRepository,
} = require('../repositories');
const { defaultProvider: defaultDigiLockerProvider } = require('../providers/digilocker.provider');
const { getSupabaseAdmin, resolveBucketForKey } = require('../providers/supabase');
const { redisClient } = require('../config/redis');
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
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
    storageBucket = env.AADHAAR_STORAGE_BUCKET || AADHAAR_CONSTANTS.DEFAULT_STORAGE_BUCKET,
  } = {}) {
    this.customerRepository = customerRepo;
    this.documentRepository = documentRepo;
    this.verificationRepository = verificationRepo;
    this.digiLockerProvider = digilocker;
    this.redisClient = redis;
    this.getSupabase = supabase;
    this.storageBucket = storageBucket;
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
   * Safely parses Aadhaar XML and extracts verified identity fields (<Poi>, UID/masked UID).
   * Strictly enforces XXE protection by disabling entity processing.
   *
   * @param {string} xmlString
   * @returns {{ verifiedName: string, dob: string|null, gender: string|null, uid: string, maskedAadhaar: string }}
   */
  static extractIdentityInfoFromXml(xmlString) {
    if (!xmlString || typeof xmlString !== 'string') {
      throw new BadRequestError('Empty or invalid XML payload received from provider', 'AADHAAR_INVALID_XML');
    }

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      parseAttributeValue: false,
      trimValues: true,
      processEntities: false, // Strict protection against XML External Entity (XXE) injection
      allowBooleanAttributes: false,
    });

    let parsed;
    try {
      parsed = parser.parse(xmlString);
    } catch (parseErr) {
      throw new BadRequestError(`XML parsing failed: ${parseErr.message}`, 'AADHAAR_MALFORMED_XML');
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new BadRequestError('Malformed Aadhaar XML payload structure', 'AADHAAR_MALFORMED_XML');
    }

    // Recursively locate <Poi> and <UidData> nodes regardless of outer wrapper tags
    let poiNode = null;
    let uidVal = null;

    function findNodes(obj) {
      if (!obj || typeof obj !== 'object') return;

      for (const [key, val] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'poi') {
          poiNode = val;
        }
        if (lowerKey === 'uiddata' && val && val.uid) {
          uidVal = val.uid;
        }
        if (lowerKey === 'printletterbarcodedata' && val) {
          if (val.uid) uidVal = val.uid;
          if (!poiNode && (val.name || val.dob || val.gender)) {
            poiNode = val;
          }
        }
        if (typeof val === 'object') {
          findNodes(val);
        }
      }
    }

    findNodes(parsed);

    if (!poiNode) {
      throw new BadRequestError('Missing <Poi> element in Aadhaar XML response', 'AADHAAR_MISSING_POI');
    }

    const rawName = poiNode.name;
    if (!rawName || typeof rawName !== 'string' || !rawName.trim()) {
      throw new BadRequestError('Missing or empty name attribute in <Poi> element', 'AADHAAR_MISSING_NAME');
    }

    const verifiedName = rawName.trim().replace(/\s+/g, ' ');
    const dob = poiNode.dob ? String(poiNode.dob).trim() : null;
    const gender = poiNode.gender ? String(poiNode.gender).trim().toUpperCase() : null;

    // Extract or sanitize UID
    let cleanUid = uidVal ? String(uidVal).trim() : '';
    let maskedAadhaar = null;

    if (cleanUid) {
      const digitsOnly = cleanUid.replace(/[^0-9]/g, '');
      if (digitsOnly.length >= 4) {
        maskedAadhaar = `XXXX-XXXX-${digitsOnly.slice(-4)}`;
      }
    }
    if (!maskedAadhaar) {
      const m = xmlString.match(/[xX]{8}(\d{4})/);
      if (m && m[1]) {
        maskedAadhaar = `XXXX-XXXX-${m[1]}`;
      }
    }

    return {
      verifiedName,
      dob,
      gender,
      uid: cleanUid || maskedAadhaar || 'UNKNOWN',
      maskedAadhaar: maskedAadhaar || 'XXXX-XXXX-0000',
    };
  }

  /**
   * Derives a stable, cryptographic keyed HMAC-SHA256 identity fingerprint.
   * Normalizes identity attributes to ensure deterministic hashing across verifications.
   * The secret is maintained securely on the server and never exposed to clients or DB.
   *
   * @param {object} info
   * @param {string} [secret]
   * @returns {string} 64-character hex string
   */
  static computeIdentityHash(info, secret = env.AADHAAR_HMAC_SECRET || env.JWT_SECRET || 'gongo-identity-default-key-v1') {
    const normUid = (info.uid || '').toUpperCase().replace(/[^0-9X]/g, '');
    const normDob = (info.dob || '').toLowerCase().trim();
    const normGender = (info.gender || '').toUpperCase().trim();
    const normName = (info.verifiedName || '').toLowerCase().trim().replace(/\s+/g, ' ');

    const canonical = `${normUid}|${normDob}|${normGender}|${normName}`;
    return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  }

  /**
   * Normalizes a 12-digit Aadhaar number string.
   * Strips spaces and hyphens, validates exact 12 numeric digits, and rejects repeating sequences.
   *
   * @param {string} aadhaar
   * @returns {string} 12-digit numeric string
   */
  static normalizeAadhaarNumber(aadhaar) {
    if (!aadhaar || typeof aadhaar !== 'string') {
      throw new BadRequestError('Aadhaar number is required and must be a string', 'INVALID_AADHAAR_FORMAT');
    }
    const clean = aadhaar.replace(/[\s-]/g, '');
    if (!/^\d{12}$/.test(clean)) {
      throw new BadRequestError('Aadhaar number must contain exactly 12 digits', 'INVALID_AADHAAR_FORMAT');
    }
    if (/^(\d)\1{11}$/.test(clean)) {
      throw new BadRequestError('Invalid Aadhaar number pattern', 'INVALID_AADHAAR_FORMAT');
    }
    return clean;
  }

  /**
   * Computes keyed HMAC-SHA256 identity fingerprint from normalized 12-digit Aadhaar.
   * Fails safely if AADHAAR_HMAC_SECRET is missing.
   *
   * @param {string} normalizedAadhaar
   * @param {string} [secret]
   * @returns {string} 64-character hex string
   */
  static computeAadhaarFingerprint(normalizedAadhaar, secret = env.AADHAAR_HMAC_SECRET) {
    if (!secret) {
      logger.error('[AADHAAR_SERVICE] AADHAAR_HMAC_SECRET is missing or not configured');
      throw new ServiceUnavailableError(
        'Aadhaar verification service is currently unavailable',
        'AADHAAR_SECRET_MISSING'
      );
    }
    return crypto.createHmac('sha256', secret).update(normalizedAadhaar).digest('hex');
  }

  /**
   * Checks whether an entered 12-digit Aadhaar number is available for verification.
   * Returns available: true if not linked to another verified account, or false with generic message.
   * Never leaks raw Aadhaar numbers, fingerprints, or owner customer IDs.
   *
   * @param {string} customerId
   * @param {string} aadhaarNumber
   * @returns {Promise<{ isAvailable: boolean, reason?: string, message: string }>}
   */
  async checkAadhaarAvailability(customerId, aadhaarNumber) {
    const normalized = AadhaarVerificationService.normalizeAadhaarNumber(aadhaarNumber);
    const fingerprint = AadhaarVerificationService.computeAadhaarFingerprint(normalized);

    // 1. Check verified identity links table
    if (typeof this.verificationRepository.findIdentityLinkByHash === 'function') {
      const existingLink = await this.verificationRepository.findIdentityLinkByHash(fingerprint);
      if (existingLink) {
        const linkCustomerId = existingLink.customer_id || existingLink.customerId;
        if (linkCustomerId !== customerId) {
          logger.info('[AADHAAR_SERVICE] Availability check: identity already linked to another customer');
          return {
            isAvailable: false,
            reason: 'IDENTITY_ALREADY_LINKED',
            message: 'This Aadhaar is already associated with a verified account.',
          };
        }
        // Same customer re-verifying
        return {
          isAvailable: true,
          message: 'Aadhaar is available for verification.',
        };
      }
    }

    // 2. Check verified records in customer_identity_verifications table
    if (typeof this.verificationRepository.query === 'function') {
      const verifCheck = await this.verificationRepository.query(
        `SELECT customer_id FROM customer_identity_verifications
         WHERE identity_hash = $1 AND UPPER(verification_status) = 'VERIFIED' AND customer_id != $2
         LIMIT 1;`,
        [fingerprint, customerId]
      );
      if (verifCheck && verifCheck.rows && verifCheck.rows.length > 0) {
        logger.info('[AADHAAR_SERVICE] Availability check: verified record found for another customer');
        return {
          isAvailable: false,
          reason: 'IDENTITY_ALREADY_LINKED',
          message: 'This Aadhaar is already associated with a verified account.',
        };
      }
    }

    return {
      isAvailable: true,
      message: 'Aadhaar is available for verification.',
    };
  }

  /**
   * Initiates DigiLocker Aadhaar verification for an authenticated customer.
   *
   * @param {string} customerId - Authenticated customer UUID from token
   * @param {object} options
   * @param {string} [options.redirectUri] - Custom callback URI
   * @param {string} [options.aadhaarNumber] - Optional 12-digit Aadhaar input
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

    // Pre-validate Aadhaar number if supplied
    let aadhaarFingerprint = null;
    let aadhaarLast4 = null;
    if (options.aadhaarNumber) {
      const normalized = AadhaarVerificationService.normalizeAadhaarNumber(options.aadhaarNumber);
      aadhaarFingerprint = AadhaarVerificationService.computeAadhaarFingerprint(normalized);
      aadhaarLast4 = normalized.slice(-4);

      // Enforce duplicate check at initiation
      if (typeof this.verificationRepository.findIdentityLinkByHash === 'function') {
        const existingLink = await this.verificationRepository.findIdentityLinkByHash(aadhaarFingerprint);
        if (existingLink && (existingLink.customer_id || existingLink.customerId) !== customerId) {
          throw new ConflictError(
            'This Aadhaar is already associated with a verified account.',
            'IDENTITY_ALREADY_LINKED'
          );
        }
      }
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
      ...(aadhaarLast4 ? { last4: aadhaarLast4 } : {}),
      ...(aadhaarFingerprint ? { aadhaarFingerprint } : {}),
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
      identityHash: null, // Written strictly upon authoritative verification completion in handleCallback
    });

    // 5. Store session in Redis with 15m TTL
    const sessionData = {
      verificationId,
      customerId,
      state: stateToken,
      redirectUri,
      ...(aadhaarFingerprint ? { aadhaarFingerprint } : {}),
      ...(aadhaarLast4 ? { last4: aadhaarLast4 } : {}),
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

    // 6. Securely parse XML and extract identity info (<Poi>, UID/masked UID)
    let identityInfo;
    try {
      identityInfo = AadhaarVerificationService.extractIdentityInfoFromXml(docData.xmlContent);
    } catch (xmlErr) {
      await this.verificationRepository.updateVerification(verificationId, {
        verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
        errorDetails: { reason: 'XML identity extraction failed', message: xmlErr.message },
      });
      await this.verificationRepository.createAuditEvent({
        verificationId,
        customerId,
        eventType: AUDIT_EVENT_TYPES.VERIFICATION_FAILED,
        provider: verification.provider,
        details: { step: 'XML_EXTRACTION', error: xmlErr.message },
      });
      throw xmlErr;
    }

    // 7. Authoritative identity hash derived strictly from validated provider response (<UidData>, <Poi>)
    const identityHash = AadhaarVerificationService.computeIdentityHash(identityInfo);

    // Cross-check entered Aadhaar suffix if entered by customer during session initiation
    const sessionLast4 = verification.consentRecord?.last4;
    const uidDigits = (identityInfo.uid || identityInfo.maskedAadhaar || '').replace(/\D/g, '');
    if (sessionLast4 && uidDigits.length >= 4) {
      const xmlLast4 = uidDigits.slice(-4);
      if (xmlLast4 !== sessionLast4) {
        logger.warn('[AADHAAR_SERVICE] Aadhaar last 4 digits mismatch between entered input and XML', {
          verificationId,
          customerId,
        });
        await this.verificationRepository.updateVerification(verificationId, {
          verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
          errorDetails: { reason: 'AADHAAR_IDENTITY_MISMATCH' },
        });
        throw new BadRequestError('The verified Aadhaar does not match the entered Aadhaar number', 'AADHAAR_IDENTITY_MISMATCH');
      }
    }

    // 8. Enforce single-account identity uniqueness (Anti-Duplicate Verification Check)
    if (typeof this.verificationRepository.findIdentityLinkByHash === 'function') {
      const existingLink = await this.verificationRepository.findIdentityLinkByHash(identityHash);
      if (existingLink && (existingLink.customer_id || existingLink.customerId) !== customerId) {
        logger.warn('[AADHAAR_SERVICE] Duplicate Aadhaar identity verification rejected: identity already verified on another account', {
          verificationId,
          customerId,
        });

        await this.verificationRepository.updateVerification(verificationId, {
          verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
          errorDetails: {
            reason: 'IDENTITY_ALREADY_LINKED',
            message: 'This Aadhaar identity is already verified on another account.',
          },
        });

        await this.verificationRepository.createAuditEvent({
          verificationId,
          customerId,
          eventType: AUDIT_EVENT_TYPES.VERIFICATION_FAILED,
          provider: verification.provider,
          details: {
            step: 'DUPLICATE_CHECK',
            reason: 'IDENTITY_ALREADY_LINKED',
          },
        });

        throw new ConflictError(
          'This Aadhaar identity is already verified on another account.',
          'IDENTITY_ALREADY_LINKED'
        );
      }
    }

    // 9. Atomic reservation of customer identity link in customer_identity_links
    if (typeof this.verificationRepository.upsertIdentityLink === 'function') {
      try {
        await this.verificationRepository.upsertIdentityLink({
          customerId,
          identityHash,
          idType: 'AADHAAR',
          verificationId,
        });
      } catch (dbConflictErr) {
        if (dbConflictErr.code === '23505' || dbConflictErr.message?.includes('uq_customer_identity_links_hash')) {
          logger.warn('[AADHAAR_SERVICE] Concurrent identity link conflict detected via database unique constraint', {
            verificationId,
            customerId,
            error: dbConflictErr.message,
          });
          await this.verificationRepository.updateVerification(verificationId, {
            verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
            errorDetails: { reason: 'IDENTITY_ALREADY_LINKED' },
          });
          throw new ConflictError(
            'This Aadhaar identity is already verified on another account.',
            'IDENTITY_ALREADY_LINKED'
          );
        }
        throw dbConflictErr;
      }
    }

    // 10. Operation A — Synchronize customer profile name from verified <Poi> name
    try {
      await this.customerRepository.updateProfile(customerId, {
        name: identityInfo.verifiedName,
      });
      logger.info('[AADHAAR_SERVICE] Customer profile name synchronized from verified Aadhaar XML', {
        customerId,
        verificationId,
      });
    } catch (nameSyncErr) {
      logger.warn('[AADHAAR_SERVICE] Customer profile name synchronization encountered warning', {
        customerId,
        error: nameSyncErr.message,
      });
    }

    // 11. Operation B — Handle XML Storage based on retention permission
    let storageBucket = null;
    let storagePath = null;
    const isRetentionPermitted = env.AADHAAR_XML_RETENTION_ENABLED;

    if (isRetentionPermitted && docData.xmlContent) {
      storagePath = `customers/${customerId}/aadhaar/${verificationId}.xml`;
      storageBucket = this.storageBucket && this.storageBucket !== 'gongo-uploads'
        ? this.storageBucket
        : (typeof resolveBucketForKey === 'function' ? resolveBucketForKey(storagePath, this.storageBucket) : (env.AADHAAR_STORAGE_BUCKET || 'gongo-customers'));
      if (storageBucket === 'gongo-uploads') {
        storageBucket = 'gongo-customers';
      }

      try {
        const client = typeof this.getSupabase === 'function' ? this.getSupabase() : this.getSupabase;
        if (!client || !client.storage) {
          logger.error('[AADHAAR_SERVICE] Secure storage client unavailable', {
            operation: 'uploadIdentityDocument',
            provider: 'supabase',
            correlationId: verificationId,
            customerId,
          });
          throw new ServiceUnavailableError(
            'Failed to persist identity document to secure storage',
            'STORAGE_CLIENT_UNAVAILABLE'
          );
        }

        const xmlBuffer = Buffer.from(docData.xmlContent, 'utf8');
        const { error: uploadErr } = await client.storage
          .from(storageBucket)
          .upload(storagePath, xmlBuffer, {
            contentType: 'application/xml',
            upsert: true,
          });

        if (uploadErr) {
          const rawStatus = uploadErr.statusCode || uploadErr.status || (uploadErr.error && uploadErr.error.statusCode);
          const httpStatus = rawStatus ? Number(rawStatus) || 500 : 500;
          const storageErrorCode = uploadErr.error || uploadErr.code || uploadErr.name || 'STORAGE_ERROR';

          logger.error('[AADHAAR_SERVICE] Secure storage upload failed', {
            operation: 'uploadIdentityDocument',
            provider: 'supabase',
            bucket: storageBucket,
            path: storagePath,
            httpStatus,
            errorCode: storageErrorCode,
            errorMessage: uploadErr.message,
            correlationId: verificationId,
            customerId,
          });

          const storageError = new ServiceUnavailableError(
            'Failed to persist identity document to secure storage',
            'STORAGE_UPLOAD_ERROR'
          );
          storageError.cause = uploadErr;
          storageError.httpStatus = httpStatus;
          storageError.storageErrorCode = storageErrorCode;
          throw storageError;
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
      } catch (storageErr) {
        logger.warn('[AADHAAR_SERVICE] Identity document storage persistence failed, updating session status', {
          operation: 'uploadIdentityDocument',
          correlationId: verificationId,
          customerId,
          error: storageErr.message,
          code: storageErr.code,
        });

        // Roll back identity link reservation if storage fails so session is not locked
        if (typeof this.verificationRepository.deleteIdentityLinkByVerificationId === 'function') {
          await this.verificationRepository.deleteIdentityLinkByVerificationId(verificationId).catch(() => {});
        }

        await this.verificationRepository.updateVerification(verificationId, {
          verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
          errorDetails: {
            reason: 'Storage upload failed',
            message: storageErr.message,
            code: storageErr.code,
            storageErrorCode: storageErr.storageErrorCode || null,
          },
        });

        await this.verificationRepository.createAuditEvent({
          verificationId,
          customerId,
          eventType: AUDIT_EVENT_TYPES.VERIFICATION_FAILED,
          provider: verification.provider,
          details: {
            step: 'STORAGE_UPLOAD',
            error: storageErr.message,
            code: storageErr.code,
          },
        });

        throw storageErr;
      }
    } else if (!isRetentionPermitted) {
      logger.info('[AADHAAR_SERVICE] Aadhaar XML retention is disabled; retaining permitted metadata only', {
        customerId,
        verificationId,
      });
    }

    // 12. Update verification status in PostgreSQL
    const verifiedAt = new Date();
    const updatedConsent = {
      ...(verification.consentRecord || {}),
      maskedAadhaar: identityInfo.maskedAadhaar,
      verifiedName: identityInfo.verifiedName,
      retentionPermitted: isRetentionPermitted,
      verifiedAt: verifiedAt.toISOString(),
    };

    const updatedVerification = await this.verificationRepository.updateVerification(verificationId, {
      verificationStatus: AADHAAR_VERIFICATION_STATUS.VERIFIED,
      identityHash,
      storageBucket,
      storagePath,
      verifiedAt,
      providerReferenceId: tokenData?.digilockerId || sessionId || verification.providerReferenceId,
      consentRecord: updatedConsent,
    });

    // 13. Update customer_documents table so existing KYC checks recognize customer as verified
    try {
      await this.documentRepository.create({
        userId: customerId,
        documentType: AADHAAR_DOCUMENT_TYPE,
        status: 'VERIFIED',
        storageKey: storagePath || 'digilocker/verified',
        metadata: {
          verificationId,
          provider: verification.provider,
          maskedAadhaar: identityInfo.maskedAadhaar,
          verifiedName: identityInfo.verifiedName,
          source: 'DIGILOCKER_XML',
        },
        verifiedAt,
      });
    } catch (docRepoErr) {
      logger.warn('[AADHAAR_SERVICE] Note: customer_documents secondary entry warning', {
        error: docRepoErr.message,
      });
    }

    // 14. Update Redis session state with short retention to handle immediate callback replays
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

    // 15. Audit event: VERIFICATION_COMPLETED
    await this.verificationRepository.createAuditEvent({
      verificationId,
      customerId,
      eventType: AUDIT_EVENT_TYPES.VERIFICATION_COMPLETED,
      provider: verification.provider,
      details: {
        verifiedAt: verifiedAt.toISOString(),
        hasStoragePath: Boolean(storagePath),
        maskedAadhaar: identityInfo.maskedAadhaar,
      },
    });

    logger.info('[AADHAAR_SERVICE] Aadhaar verification completed successfully', {
      customerId,
      verificationId,
      maskedAadhaar: identityInfo.maskedAadhaar,
    });

    return {
      status: AADHAAR_VERIFICATION_STATUS.VERIFIED,
      verificationId,
      verifiedName: identityInfo.verifiedName,
      maskedAadhaar: identityInfo.maskedAadhaar,
      message: 'Aadhaar verification completed successfully.',
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
        verifiedName: null,
        maskedAadhaar: null,
        lastAttempt: null,
      };
    }

    return {
      verificationStatus: latest.verificationStatus,
      isVerified: latest.verificationStatus === AADHAAR_VERIFICATION_STATUS.VERIFIED,
      verifiedAt: latest.verifiedAt,
      verifiedName: latest.consentRecord?.verifiedName || null,
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
    const bucket = verification.storageBucket || this.storageBucket || env.AADHAAR_STORAGE_BUCKET || AADHAAR_CONSTANTS.DEFAULT_STORAGE_BUCKET;
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
