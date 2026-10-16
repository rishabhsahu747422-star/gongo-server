'use strict';

const express = require('express');

/**
 * Body parser middleware.
 *
 * Limits:
 * - JSON body: 10kb max
 * - URL-encoded body: 10kb max
 *
 * The 10kb limit prevents large payload DoS attacks. If a specific endpoint
 * legitimately needs a larger body (e.g. file metadata), override the limit
 * for that specific route — do NOT increase the global limit.
 *
 * `extended: false` uses the native `querystring` library for URL-encoded bodies,
 * which is simpler and safer than `qs` (no prototype pollution risk).
 */
const jsonParser = express.json({
  limit: '10kb',
  strict: true, // Reject non-object/array top-level values
  verify: (req, res, buf) => {
    req.rawBody = buf ? buf.toString('utf8') : '';
  },
});

const urlencodedParser = express.urlencoded({
  extended: false,
  limit: '10kb',
});

module.exports = { jsonParser, urlencodedParser };
