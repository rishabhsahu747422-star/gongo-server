'use strict';

const express = require('express');

/**
 * Body parsing middleware with strict size limits to prevent Denial of Service.
 * Default 10kb limit per requirement.
 */
const JSON_LIMIT = '10kb';
const URLENCODED_LIMIT = '10kb';

const jsonParser = express.json({
  limit: JSON_LIMIT,
  strict: true,
  verify: (req, res, buf) => {
    req.rawBody = buf ? buf.toString('utf8') : '';
  },
});

const urlencodedParser = express.urlencoded({
  extended: true,
  limit: URLENCODED_LIMIT,
});

module.exports = {
  jsonParser,
  urlencodedParser,
  JSON_LIMIT,
  URLENCODED_LIMIT,
};
