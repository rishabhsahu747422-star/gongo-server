'use strict';

const express = require('express');

const PAYLOAD_LIMIT = '10kb';

const jsonParser = express.json({
  limit: PAYLOAD_LIMIT,
  strict: true,
});

const urlencodedParser = express.urlencoded({
  extended: false,
  limit: PAYLOAD_LIMIT,
});

module.exports = {
  jsonParser,
  urlencodedParser,
  PAYLOAD_LIMIT,
};
