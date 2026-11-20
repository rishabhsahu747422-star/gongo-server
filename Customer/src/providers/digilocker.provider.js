'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../config/logger');
const {
  BadRequestError,
  ServiceUnavailableError,
} = require('../errors');
const {
  AADHAAR_PROVIDERS,
  AADHAAR_CONSTANTS,
} = require('../constants/aadhaar');

/**
 * DigiLockerProvider — Backend provider for DigiLocker Aadhaar XML verification.
 *
 * Supports both:
 * 1. Sandbox.co.in KYC DigiLocker Client API:
 *    - POST /authenticate (JWT access token exchange via x-api-key, x-api-secret)
 *    - POST /kyc/digilocker/sessions/init (@entity: in.co.sandbox.kyc.digilocker.session.request)
 *    - GET  /kyc/digilocker/sessions/:session_id/status
 *    - GET  /kyc/digilocker/sessions/:session_id/documents/aadhaar
 * 2. Direct Government DigiLocker OAuth 2.0 API:
 *    - GET  /public/oauth2/1/authorize
 *    - POST /public/oauth2/1/token
 *    - GET  /public/oauth2/1/xml/eaadhaar
 *
 * Security:
 * - Credentials & tokens reside strictly on the server.
 * - API keys, secrets, full tokens, Aadhaar numbers, and XML payloads are never logged.
 * - Pluggable mock delegate for deterministic tests.
 */
class DigiLockerProvider {
  constructor(options = {}) {
    this.clientId = (options.clientId || env.DIGILOCKER_CLIENT_ID || '').trim();
    this.clientSecret = (options.clientSecret || env.DIGILOCKER_CLIENT_SECRET || '').trim();
    this.apiKey = (options.apiKey || env.SANDBOX_API_KEY || options.clientId || env.DIGILOCKER_CLIENT_ID || '').trim();
    this.apiSecret = (options.apiSecret || env.SANDBOX_API_SECRET || options.clientSecret || env.DIGILOCKER_CLIENT_SECRET || '').trim();
    this.apiVersion = (options.apiVersion || env.SANDBOX_API_VERSION || '1.0.0').trim();
    this.envMode = (options.env || env.DIGILOCKER_ENV || 'SANDBOX').toUpperCase();
    this.apiBaseUrl = (options.apiBaseUrl || env.DIGILOCKER_API_BASE_URL || 'https://api.digitallocker.gov.in').replace(/\/+$/, '');
    this.redirectUri = (options.redirectUri || env.DIGILOCKER_REDIRECT_URI || '').trim();

    this.sandboxSession = null;
    this.mockDelegate = null;
  }

  /**
   * Sets mock delegate for unit and integration testing.
   *
   * @param {object|null} delegate
   */
  setMockDelegate(delegate) {
    this.mockDelegate = delegate;
  }

  /**
   * Returns true if configured to use Sandbox.co.in KYC API.
   *
   * @returns {boolean}
   */
  isSandboxCoInMode() {
    return this.apiBaseUrl.includes('sandbox.co.in')
      || (this.apiKey && this.apiKey.startsWith('key_'))
      || (this.apiSecret && this.apiSecret.startsWith('secret_'));
  }

  /**
   * Resolves the authoritative host for Sandbox.co.in calls.
   * Follows Sandbox SDK Endpoint resolution rules:
   * key_test_* -> https://test-api.sandbox.co.in
   * key_live_* -> https://api.sandbox.co.in
   *
   * @returns {string}
   */
  getSandboxHost() {
    if (this.apiBaseUrl.includes('sandbox.co.in')) {
      return this.apiBaseUrl;
    }
    const envPart = this.apiKey.split('_')[1];
    switch (envPart) {
      case 'live':
        return 'https://api.sandbox.co.in';
      case 'test':
        return 'https://test-api.sandbox.co.in';
      default:
        return this.envMode === 'PRODUCTION'
          ? 'https://api.sandbox.co.in'
          : 'https://test-api.sandbox.co.in';
    }
  }

  /**
   * Authenticates with Sandbox.co.in and retrieves a JWT access token.
   * Implements token caching to reuse unexpired tokens.
   *
   * @returns {Promise<string>}
   */
  async authenticateSandbox() {
    const now = Math.floor(Date.now() / 1000);
    if (this.sandboxSession && this.sandboxSession.accessToken && this.sandboxSession.expiresAt > now + 60) {
      return this.sandboxSession.accessToken;
    }

    const host = this.getSandboxHost();
    const authEndpoint = `${host}/authenticate`;

    let response;
    try {
      response = await fetch(authEndpoint, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'x-api-secret': this.apiSecret,
          'x-api-version': this.apiVersion,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({}),
      });
    } catch (netErr) {
      logger.error('[DIGILOCKER_PROVIDER] Sandbox authentication network failure', { error: netErr.message });
      throw new ServiceUnavailableError('Sandbox service temporarily unreachable', 'SANDBOX_NETWORK_ERROR');
    }

    if (!response.ok) {
      const status = response.status;
      let errBody = {};
      try { errBody = await response.json(); } catch (_) {}

      logger.warn('[DIGILOCKER_PROVIDER] Sandbox authenticate rejected', {
        status,
        code: errBody?.code,
        message: errBody?.message,
      });

      if (status === 401) {
        throw new BadRequestError('Invalid Sandbox API key or secret', 'SANDBOX_INVALID_CREDENTIALS');
      }
      throw new BadRequestError(errBody?.message || 'Failed to authenticate with Sandbox', 'SANDBOX_AUTH_FAILED');
    }

    const data = await response.json();
    const token = data?.data?.access_token || data?.access_token;
    if (!token) {
      throw new BadRequestError('Sandbox authenticate response missing access token', 'SANDBOX_INVALID_AUTH_RESPONSE');
    }

    this.sandboxSession = {
      accessToken: token,
      expiresAt: now + 3500, // Token valid for 1 hour
    };

    return token;
  }

  /**
   * Resolves the authoritative redirect URI.
   *
   * @param {string} [overrideUri]
   * @returns {string}
   */
  resolveRedirectUri(overrideUri) {
    if (overrideUri && typeof overrideUri === 'string') {
      return overrideUri.trim();
    }
    if (this.redirectUri) {
      return this.redirectUri;
    }
    const backendBase = (env.BACKEND_PUBLIC_URL || 'https://gongo-server-myqf.onrender.com').replace(/\/+$/, '');
    return `${backendBase}/api/v1/customers/aadhaar/callback`;
  }

  /**
   * Generates a unique, unpredictable cryptographic state token for CSRF protection.
   *
   * @returns {string} 64-character hex string
   */
  generateState() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Initiates a DigiLocker authorization session.
   *
   * Supports:
   * - Sandbox.co.in: POST /kyc/digilocker/sessions/init
   * - Direct DigiLocker: GET /public/oauth2/1/authorize
   *
   * @param {object} params
   * @param {string} params.customerId - Authenticated customer UUID
   * @param {string} [params.state] - Unique CSRF state
   * @param {string} [params.redirectUri] - Callback URI override
   * @returns {Promise<{ authorizationUrl: string, state: string, provider: string, providerReferenceId: string }>}
   */
  async initiateSession({ customerId, state, redirectUri }) {
    if (this.mockDelegate && typeof this.mockDelegate.initiateSession === 'function') {
      return this.mockDelegate.initiateSession({ customerId, state, redirectUri });
    }

    const stateToken = state || this.generateState();
    const finalRedirectUri = this.resolveRedirectUri(redirectUri);

    // ── Sandbox.co.in Flow ────────────────────────────────────────────────
    if (this.isSandboxCoInMode()) {
      const host = this.getSandboxHost();
      const accessToken = await this.authenticateSandbox();

      // Ensure redirect_url is an HTTPS URL as enforced by Sandbox schema
      const safeRedirectUrl = finalRedirectUri.startsWith('https://')
        ? finalRedirectUri
        : (env.BACKEND_PUBLIC_URL && env.BACKEND_PUBLIC_URL.startsWith('https://')
            ? `${env.BACKEND_PUBLIC_URL.replace(/\/+$/, '')}/api/v1/customers/aadhaar/callback`
            : 'https://developer.sandbox.co.in/');

      const requestPayload = {
        '@entity': 'in.co.sandbox.kyc.digilocker.session.request',
        flow: 'signin',
        redirect_url: safeRedirectUrl,
        doc_types: ['aadhaar'],
      };

      let response;
      try {
        response = await fetch(`${host}/kyc/digilocker/sessions/init`, {
          method: 'POST',
          headers: {
            'x-api-key': this.apiKey,
            Authorization: accessToken,
            'x-api-version': this.apiVersion,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(requestPayload),
        });
      } catch (netErr) {
        logger.error('[DIGILOCKER_PROVIDER] Sandbox session init network failure', { error: netErr.message });
        throw new ServiceUnavailableError('Sandbox service temporarily unreachable', 'SANDBOX_NETWORK_ERROR');
      }

      if (!response.ok) {
        let errBody = {};
        try { errBody = await response.json(); } catch (_) {}
        logger.warn('[DIGILOCKER_PROVIDER] Sandbox session init rejected', {
          status: response.status,
          message: errBody?.message,
        });
        throw new BadRequestError(errBody?.message || 'Failed to initiate DigiLocker session with Sandbox', 'SANDBOX_SESSION_INIT_FAILED');
      }

      const result = await response.json();
      const sessionData = result?.data || {};
      if (!sessionData.authorization_url || !sessionData.session_id) {
        throw new BadRequestError('Sandbox response missing authorization_url or session_id', 'SANDBOX_INVALID_SESSION_RESPONSE');
      }

      logger.info('[DIGILOCKER_PROVIDER] Initiated Sandbox DigiLocker session', {
        customerId,
        sessionId: sessionData.session_id,
        stateTokenPrefix: stateToken.slice(0, 8),
      });

      return {
        authorizationUrl: sessionData.authorization_url,
        state: stateToken,
        provider: AADHAAR_PROVIDERS.DIGILOCKER_SANDBOX,
        providerReferenceId: sessionData.session_id,
      };
    }

    // ── Direct Government DigiLocker OAuth 2.0 Flow ────────────────────────
    const authEndpoint = `${this.apiBaseUrl}/public/oauth2/1/authorize`;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      state: stateToken,
      redirect_uri: finalRedirectUri,
      scope: 'read',
    });

    const authorizationUrl = `${authEndpoint}?${params.toString()}`;
    const providerReferenceId = `digilocker_sess_${crypto.randomBytes(12).toString('hex')}`;

    logger.info('[DIGILOCKER_PROVIDER] Initiated DigiLocker session', {
      customerId,
      envMode: this.envMode,
      providerReferenceId,
      stateTokenPrefix: stateToken.slice(0, 8),
    });

    return {
      authorizationUrl,
      state: stateToken,
      provider: this.envMode === 'PRODUCTION'
        ? AADHAAR_PROVIDERS.DIGILOCKER_PRODUCTION
        : AADHAAR_PROVIDERS.DIGILOCKER_SANDBOX,
      providerReferenceId,
    };
  }

  /**
   * Exchanges authorization code for DigiLocker access token (Direct OAuth flow).
   *
   * @param {object} params
   * @param {string} params.code - Authorization code returned by DigiLocker
   * @param {string} [params.redirectUri] - Must match the redirect_uri used during authorize
   * @returns {Promise<{ accessToken: string, tokenType: string, expiresIn: number, digilockerId?: string }>}
   */
  async exchangeCodeForToken({ code, redirectUri }) {
    if (this.mockDelegate && typeof this.mockDelegate.exchangeCodeForToken === 'function') {
      return this.mockDelegate.exchangeCodeForToken({ code, redirectUri });
    }

    if (!code || typeof code !== 'string') {
      throw new BadRequestError('Authorization code is required', 'DIGILOCKER_MISSING_CODE');
    }

    const tokenEndpoint = `${this.apiBaseUrl}/public/oauth2/1/token`;
    const finalRedirectUri = this.resolveRedirectUri(redirectUri);

    const bodyParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code.trim(),
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: finalRedirectUri,
    });

    let response;
    try {
      response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: bodyParams.toString(),
      });
    } catch (netErr) {
      logger.error('[DIGILOCKER_PROVIDER] Token exchange network failure', { error: netErr.message });
      throw new ServiceUnavailableError('DigiLocker service temporarily unreachable', 'DIGILOCKER_NETWORK_ERROR');
    }

    if (!response.ok) {
      logger.warn('[DIGILOCKER_PROVIDER] Token exchange rejected by provider', {
        status: response.status,
        statusText: response.statusText,
      });

      throw new BadRequestError(
        'Failed to exchange authorization code with DigiLocker',
        'DIGILOCKER_TOKEN_EXCHANGE_FAILED',
      );
    }

    const data = await response.json();
    if (!data || !data.access_token) {
      throw new BadRequestError(
        'DigiLocker response missing access token',
        'DIGILOCKER_INVALID_TOKEN_RESPONSE',
      );
    }

    return {
      accessToken: data.access_token,
      tokenType: data.token_type || 'Bearer',
      expiresIn: data.expires_in || 3600,
      digilockerId: data.digilockerid || data.digilocker_id || null,
    };
  }

  /**
   * Normalized session authorization states for KYC providers.
   */
  static SESSION_AUTH_STATE = Object.freeze({
    COMPLETED: 'COMPLETED',
    PENDING: 'PENDING',
    FAILED: 'FAILED',
    EXPIRED: 'EXPIRED',
    UNKNOWN: 'UNKNOWN',
  });

  /**
   * Normalizes documented Sandbox KYC session status strings.
   * Documented values from Sandbox KYC OpenAPI specification:
   * - 'created', 'initialized' -> PENDING (user authorization pending)
   * - 'authorized', 'succeeded' -> COMPLETED (user completed authorization & consent)
   * - 'failed' -> FAILED (user cancelled or provider authorization failed)
   * - 'expired' -> EXPIRED (session timeout on provider side)
   *
   * @param {string} statusRaw
   * @returns {{ state: string, isAuthorized: boolean, isPending: boolean, isFailed: boolean, isExpired: boolean }}
   */
  static normalizeSandboxSessionStatus(statusRaw) {
    if (!statusRaw || typeof statusRaw !== 'string') {
      return {
        state: DigiLockerProvider.SESSION_AUTH_STATE.UNKNOWN,
        isAuthorized: false,
        isPending: false,
        isFailed: false,
        isExpired: false,
      };
    }

    const s = statusRaw.trim().toLowerCase();

    // Authorization completed: 'succeeded' is the primary documented success state in Sandbox KYC
    if (s === 'succeeded' || s === 'authorized' || s === 'completed' || s === 'success' || s === 'approved') {
      return {
        state: DigiLockerProvider.SESSION_AUTH_STATE.COMPLETED,
        isAuthorized: true,
        isPending: false,
        isFailed: false,
        isExpired: false,
      };
    }

    // Pending: session active, awaiting customer action in DigiLocker
    if (s === 'created' || s === 'initialized' || s === 'pending' || s === 'in_progress') {
      return {
        state: DigiLockerProvider.SESSION_AUTH_STATE.PENDING,
        isAuthorized: false,
        isPending: true,
        isFailed: false,
        isExpired: false,
      };
    }

    // Failed / Cancelled
    if (s === 'failed' || s === 'cancelled' || s === 'rejected' || s === 'access_denied') {
      return {
        state: DigiLockerProvider.SESSION_AUTH_STATE.FAILED,
        isAuthorized: false,
        isPending: false,
        isFailed: true,
        isExpired: false,
      };
    }

    // Expired
    if (s === 'expired' || s === 'timeout') {
      return {
        state: DigiLockerProvider.SESSION_AUTH_STATE.EXPIRED,
        isAuthorized: false,
        isPending: false,
        isFailed: false,
        isExpired: true,
      };
    }

    return {
      state: DigiLockerProvider.SESSION_AUTH_STATE.UNKNOWN,
      isAuthorized: false,
      isPending: false,
      isFailed: false,
      isExpired: false,
    };
  }

  /**
   * Retrieves session status from Sandbox.co.in KYC service.
   *
   * @param {string} sessionId
   * @returns {Promise<{ status: string, state: string, isAuthorized: boolean, isCompleted: boolean, isPending: boolean, isFailed: boolean, isExpired: boolean, documentsConsented: string[]|null, raw: object }>}
   */
  async getSessionStatus(sessionId) {
    if (this.mockDelegate && typeof this.mockDelegate.getSessionStatus === 'function') {
      const mockResult = await this.mockDelegate.getSessionStatus(sessionId);
      if (mockResult && typeof mockResult === 'object') {
        const rawStatus = mockResult.status || (mockResult.isCompleted ? 'succeeded' : 'pending');
        const normalized = DigiLockerProvider.normalizeSandboxSessionStatus(rawStatus);
        return {
          status: String(rawStatus).toLowerCase(),
          state: mockResult.state || normalized.state,
          isAuthorized: mockResult.isAuthorized !== undefined ? Boolean(mockResult.isAuthorized) : normalized.isAuthorized,
          isCompleted: mockResult.isCompleted !== undefined ? Boolean(mockResult.isCompleted) : normalized.isAuthorized,
          isPending: mockResult.isPending !== undefined ? Boolean(mockResult.isPending) : normalized.isPending,
          isFailed: mockResult.isFailed !== undefined ? Boolean(mockResult.isFailed) : normalized.isFailed,
          isExpired: mockResult.isExpired !== undefined ? Boolean(mockResult.isExpired) : normalized.isExpired,
          documentsConsented: mockResult.documentsConsented || null,
          raw: mockResult.raw || mockResult,
        };
      }
      return mockResult;
    }

    if (!sessionId) {
      throw new BadRequestError('Session ID is required to query status', 'SANDBOX_MISSING_SESSION_ID');
    }

    const host = this.getSandboxHost();
    const token = await this.authenticateSandbox();

    const statusEndpoint = `${host}/kyc/digilocker/sessions/${encodeURIComponent(sessionId)}/status`;
    let response;
    try {
      response = await fetch(statusEndpoint, {
        method: 'GET',
        headers: {
          'x-api-key': this.apiKey,
          Authorization: token,
          'x-api-version': this.apiVersion,
          Accept: 'application/json',
        },
      });
    } catch (netErr) {
      logger.error('[DIGILOCKER_PROVIDER] Sandbox session status network failure', { error: netErr.message });
      throw new ServiceUnavailableError('Sandbox service temporarily unreachable', 'SANDBOX_NETWORK_ERROR');
    }

    if (!response.ok) {
      let errBody = {};
      try { errBody = await response.json(); } catch (_) {}
      throw new BadRequestError(errBody?.message || 'Failed to retrieve Sandbox session status', 'SANDBOX_STATUS_FAILED');
    }

    const data = await response.json();
    const sessionData = data?.data || {};
    const statusRaw = sessionData.status;
    const normalized = DigiLockerProvider.normalizeSandboxSessionStatus(statusRaw);

    const documentsConsented = Array.isArray(sessionData.documents_consented)
      ? sessionData.documents_consented
      : null;

    return {
      status: (statusRaw || '').toLowerCase(),
      state: normalized.state,
      isAuthorized: normalized.isAuthorized,
      isCompleted: normalized.isAuthorized, // backwards-compatible alias
      isPending: normalized.isPending,
      isFailed: normalized.isFailed,
      isExpired: normalized.isExpired,
      documentsConsented,
      raw: sessionData,
    };
  }

  /**
   * Fetches the issued Aadhaar XML document from DigiLocker or Sandbox.
   *
   * @param {object} params
   * @param {string} [params.accessToken] - DigiLocker access token (Direct OAuth flow)
   * @param {string} [params.sessionId] - Sandbox session ID (Sandbox flow)
   * @param {string} [params.uri] - Optional document URI
   * @returns {Promise<{ xmlContent: string, documentType: string, maskedAadhaar: string|null, isAuthorized: boolean }>}
   */
  async fetchAadhaarXml({ accessToken, sessionId, uri }) {
    if (this.mockDelegate && typeof this.mockDelegate.fetchAadhaarXml === 'function') {
      return this.mockDelegate.fetchAadhaarXml({ accessToken, sessionId, uri });
    }

    // ── Sandbox.co.in Flow ────────────────────────────────────────────────
    if (sessionId && (this.isSandboxCoInMode() || !accessToken)) {
      const host = this.getSandboxHost();
      const token = await this.authenticateSandbox();

      const docEndpoint = `${host}/kyc/digilocker/sessions/${encodeURIComponent(sessionId)}/documents/aadhaar`;
      let response;
      try {
        response = await fetch(docEndpoint, {
          method: 'GET',
          headers: {
            'x-api-key': this.apiKey,
            Authorization: token,
            'x-api-version': this.apiVersion,
            Accept: 'application/json',
          },
        });
      } catch (netErr) {
        logger.error('[DIGILOCKER_PROVIDER] Sandbox document fetch network failure', { error: netErr.message });
        throw new ServiceUnavailableError('Sandbox service temporarily unreachable', 'SANDBOX_NETWORK_ERROR');
      }

      if (!response.ok) {
        let errBody = {};
        try { errBody = await response.json(); } catch (_) {}
        logger.warn('[DIGILOCKER_PROVIDER] Sandbox document fetch rejected', {
          status: response.status,
          message: errBody?.message,
        });
        throw new BadRequestError(errBody?.message || 'Aadhaar document not found in Sandbox session', 'SANDBOX_DOCUMENT_NOT_FOUND');
      }

      const docJson = await response.json();
      const fileObj = docJson?.data?.files?.[0];
      if (!fileObj || !fileObj.url) {
        throw new BadRequestError('Sandbox response does not contain document download URL', 'SANDBOX_MISSING_DOC_URL');
      }

      // Download the actual XML file from fileObj.url (pre-signed S3 URL)
      let xmlResp;
      try {
        xmlResp = await fetch(fileObj.url);
      } catch (dlErr) {
        throw new ServiceUnavailableError('Failed to download Aadhaar XML file from storage', 'SANDBOX_DOWNLOAD_ERROR');
      }

      const xmlText = await xmlResp.text();
      const validation = this.validateXmlStructure(xmlText);
      if (!validation.isValid) {
        throw new BadRequestError('Downloaded document is not valid Aadhaar XML', 'DIGILOCKER_INVALID_XML_STRUCTURE');
      }

      const maskedAadhaar = this.extractMaskedAadhaar(xmlText);
      return {
        xmlContent: xmlText,
        documentType: 'AADHAAR',
        maskedAadhaar,
        isAuthorized: true,
      };
    }

    // ── Direct DigiLocker Flow ────────────────────────────────────────────
    if (!accessToken) {
      throw new BadRequestError('Access token is required to fetch document', 'DIGILOCKER_UNAUTHORIZED');
    }

    const docEndpoint = uri
      ? `${this.apiBaseUrl}/public/oauth2/3/xml/${encodeURIComponent(uri)}`
      : `${this.apiBaseUrl}/public/oauth2/1/xml/eaadhaar`;

    let response;
    try {
      response = await fetch(docEndpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/xml, text/xml',
        },
      });
    } catch (netErr) {
      logger.error('[DIGILOCKER_PROVIDER] Document fetch network failure', { error: netErr.message });
      throw new ServiceUnavailableError('Failed to fetch Aadhaar document from DigiLocker', 'DIGILOCKER_DOC_FETCH_NETWORK_ERROR');
    }

    if (!response.ok) {
      logger.warn('[DIGILOCKER_PROVIDER] Document fetch rejected by provider', {
        status: response.status,
      });
      throw new BadRequestError(
        'Aadhaar document not found or unavailable in DigiLocker account',
        'DIGILOCKER_DOCUMENT_NOT_FOUND',
      );
    }

    const xmlText = await response.text();
    const validation = this.validateXmlStructure(xmlText);
    if (!validation.isValid) {
      logger.warn('[DIGILOCKER_PROVIDER] Returned payload is not valid Aadhaar XML', {
        reason: validation.reason,
      });
      throw new BadRequestError(
        'Returned document is not a valid Aadhaar XML file',
        'DIGILOCKER_INVALID_XML_STRUCTURE',
      );
    }

    const maskedAadhaar = this.extractMaskedAadhaar(xmlText);

    return {
      xmlContent: xmlText,
      documentType: 'AADHAAR',
      maskedAadhaar,
      isAuthorized: true,
    };
  }

  /**
   * Validates document size and XML structure.
   *
   * @param {string} xmlString
   * @returns {{ isValid: boolean, reason?: string }}
   */
  validateXmlStructure(xmlString) {
    if (!xmlString || typeof xmlString !== 'string') {
      return { isValid: false, reason: 'Empty or non-string payload' };
    }

    const trimmed = xmlString.trim();

    // Check for JSON or HTML error pages first
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('<!DOCTYPE html>') || trimmed.startsWith('<html')) {
      return { isValid: false, reason: 'Payload is HTML/JSON, not XML' };
    }

    const byteLength = Buffer.byteLength(trimmed, 'utf8');

    if (byteLength < AADHAAR_CONSTANTS.MIN_XML_SIZE_BYTES) {
      return { isValid: false, reason: 'Payload size below minimum threshold' };
    }

    if (byteLength > AADHAAR_CONSTANTS.MAX_XML_SIZE_BYTES) {
      return { isValid: false, reason: 'Payload exceeds maximum 5MB size limit' };
    }

    // Must have standard XML root or Aadhaar UID tags
    const hasXmlDeclaration = trimmed.startsWith('<?xml');
    const hasAadhaarTags = trimmed.includes('<UidData')
      || trimmed.includes('<PrintLetterBarcodeData')
      || trimmed.includes('<OfflinePaperlessKyc')
      || trimmed.includes('<Certificate')
      || trimmed.includes('<KycRes')
      || trimmed.includes('<KycDoc');

    if (!hasXmlDeclaration && !hasAadhaarTags) {
      return { isValid: false, reason: 'Missing expected XML declaration or UIDAI element tags' };
    }

    return { isValid: true };
  }

  /**
   * Extracts safely masked Aadhaar number (last 4 digits only e.g. XXXX-XXXX-1234)
   * without logging or exposing sensitive personal data.
   *
   * @param {string} xmlString
   * @returns {string|null}
   */
  extractMaskedAadhaar(xmlString) {
    if (!xmlString || typeof xmlString !== 'string') return null;

    try {
      // Check uid="xxxxxxxx1234" attribute in UidData
      const uidMatch = xmlString.match(/uid=["']([0-9xX]{12})["']/i);
      if (uidMatch && uidMatch[1]) {
        const last4 = uidMatch[1].slice(-4);
        return `XXXX-XXXX-${last4}`;
      }

      // Check masked Aadhaar in text or attribute
      const last4Match = xmlString.match(/[xX]{8}(\d{4})/);
      if (last4Match && last4Match[1]) {
        return `XXXX-XXXX-${last4Match[1]}`;
      }

      // Check 12-digit number (if present, NEVER return full number, mask all but last 4)
      const numMatch = xmlString.match(/\b\d{12}\b/);
      if (numMatch && numMatch[0]) {
        const last4 = numMatch[0].slice(-4);
        return `XXXX-XXXX-${last4}`;
      }
    } catch (_) {}

    return null;
  }
}

module.exports = DigiLockerProvider;
module.exports.defaultProvider = new DigiLockerProvider();
