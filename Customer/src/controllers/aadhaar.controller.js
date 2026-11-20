'use strict';

const { defaultService: defaultAadhaarService } = require('../services/aadhaar-verification.service');
const { sendSuccess } = require('../utils/response');

/**
 * AadhaarController — Handles DigiLocker session lifecycle and callback routes.
 */
class AadhaarController {
  constructor({ aadhaarService = defaultAadhaarService } = {}) {
    this.aadhaarService = aadhaarService;
  }

  /**
   * POST /api/v1/customers/me/aadhaar/initiate
   * Authenticated customer requests session initiation.
   */
  async initiateVerification(req, res, next) {
    try {
      const customerId = req.user.id;
      const { redirectUri } = req.body || {};
      const ipAddress = req.ip || req.headers['x-forwarded-for'];
      const userAgent = req.headers['user-agent'];

      const result = await this.aadhaarService.initiateVerification(customerId, {
        redirectUri,
        ipAddress,
        userAgent,
      });

      return sendSuccess(
        res,
        result,
        'DigiLocker Aadhaar verification initiated',
        200,
      );
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET / POST /api/v1/customers/aadhaar/callback
   * Public callback endpoint reached by DigiLocker after user authorization or cancellation.
   */
  async handleCallback(req, res, next) {
    try {
      const state = req.query.state || req.body?.state;
      const code = req.query.code || req.body?.code;
      const sessionId = req.query.session_id || req.query.sessionId || req.body?.session_id || req.body?.sessionId;
      const error = req.query.error || req.body?.error;
      const errorDescription = req.query.error_description || req.body?.error_description || req.query.errorDescription;
      const ipAddress = req.ip || req.headers['x-forwarded-for'];

      const result = await this.aadhaarService.handleCallback({
        state,
        code,
        sessionId,
        error,
        errorDescription,
        ipAddress,
      });

      // If user came via web browser redirect, render clean mobile bridge page that auto-opens deep link
      const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
      if (acceptsHtml && req.method === 'GET') {
        const deepLink = `gongo://aadhaar-verification/result?status=${encodeURIComponent(result.status)}&verificationId=${encodeURIComponent(result.verificationId || '')}`;
        const isSuccess = result.status === 'VERIFIED';
        const title = isSuccess ? 'Verification Complete' : (result.status === 'CANCELLED' ? 'Verification Cancelled' : 'Verification Failed');
        const color = isSuccess ? '#00D09C' : (result.status === 'CANCELLED' ? '#F59E0B' : '#EF4444');

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - GONGO</title>
  <style>
    body {
      background-color: #121212;
      color: #FFFFFF;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
      text-align: center;
    }
    .card {
      background: #1E1E1E;
      border-radius: 16px;
      padding: 32px 24px;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    .badge {
      display: inline-block;
      width: 64px;
      height: 64px;
      border-radius: 32px;
      background: ${color}20;
      color: ${color};
      font-size: 32px;
      line-height: 64px;
      margin-bottom: 16px;
    }
    h1 { font-size: 20px; margin: 0 0 8px; color: #FFFFFF; }
    p { font-size: 14px; color: #9CA3AF; margin: 0 0 24px; }
    .btn {
      display: block;
      background: #00D09C;
      color: #000000;
      text-decoration: none;
      font-weight: 700;
      font-size: 15px;
      padding: 14px;
      border-radius: 12px;
      transition: opacity 0.2s;
    }
    .btn:active { opacity: 0.8; }
  </style>
  <script>
    window.location.href = "${deepLink}";
  </script>
</head>
<body>
  <div class="card">
    <div class="badge">${isSuccess ? '✓' : (result.status === 'CANCELLED' ? '!' : '✕')}</div>
    <h1>${title}</h1>
    <p>${result.message || 'You can now return to the GONGO app.'}</p>
    <a href="${deepLink}" class="btn">Return to GONGO App</a>
  </div>
</body>
</html>`;

        return res.status(200).send(html);
      }

      return sendSuccess(
        res,
        result,
        result.message || 'DigiLocker callback processed',
        200,
      );
    } catch (err) {
      const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
      if (acceptsHtml && req.method === 'GET') {
        const deepLink = `gongo://aadhaar-verification/result?status=FAILED&error=${encodeURIComponent(err.code || 'AADHAAR_ERROR')}`;
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verification Failed - GONGO</title>
  <style>
    body { background-color: #121212; color: #FFFFFF; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; text-align: center; }
    .card { background: #1E1E1E; border-radius: 16px; padding: 32px 24px; max-width: 400px; width: 100%; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    .badge { display: inline-block; width: 64px; height: 64px; border-radius: 32px; background: rgba(239, 68, 68, 0.2); color: #EF4444; font-size: 32px; line-height: 64px; margin-bottom: 16px; }
    h1 { font-size: 20px; margin: 0 0 8px; color: #FFFFFF; }
    p { font-size: 14px; color: #9CA3AF; margin: 0 0 24px; }
    .btn { display: block; background: #00D09C; color: #000000; text-decoration: none; font-weight: 700; font-size: 15px; padding: 14px; border-radius: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">✕</div>
    <h1>Verification Failed</h1>
    <p>${err.message || 'DigiLocker authorization could not be completed.'}</p>
    <a href="${deepLink}" class="btn">Return to GONGO App</a>
  </div>
</body>
</html>`;
        return res.status(err.statusCode || 400).send(html);
      }
      return next(err);
    }
  }

  /**
   * GET /api/v1/customers/me/aadhaar/status
   * Customer checks their authoritative Aadhaar verification status.
   */
  async getStatus(req, res, next) {
    try {
      const customerId = req.user.id;
      const status = await this.aadhaarService.getStatus(customerId);

      return sendSuccess(
        res,
        status,
        'Aadhaar verification status retrieved',
        200,
      );
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/customers/me/aadhaar/:verificationId/signed-url
   * Generates short-lived signed URL for authorized customer to view verified document.
   */
  async getSignedUrl(req, res, next) {
    try {
      const customerId = req.user.id;
      const verificationId = req.params.verificationId;

      const result = await this.aadhaarService.getSignedDocumentUrl(customerId, verificationId);

      return sendSuccess(
        res,
        result,
        'Signed document download URL generated',
        200,
      );
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = AadhaarController;
module.exports.defaultController = new AadhaarController();
