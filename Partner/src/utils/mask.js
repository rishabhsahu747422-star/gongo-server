'use strict';

/**
 * Masks sensitive document numbers to protect PII.
 *
 * @param {string} docType Document type (AADHAAR, PAN, GST, etc.)
 * @param {string} docNumber Raw document number
 * @returns {string|null} Masked document string or null
 */
function maskDocumentNumber(docType, docNumber) {
  if (!docNumber) return null;
  const str = String(docNumber).trim();

  if (docType === 'AADHAAR') {
    const digits = str.replace(/[^0-9]/g, '');
    const last4 = digits.slice(-4);
    return `•••• •••• ${last4}`;
  }

  if (docType === 'PAN') {
    if (str.length >= 4) {
      return `${str.slice(0, 2)}••••••${str.slice(-2)}`.toUpperCase();
    }
    return '••••';
  }

  if (docType === 'GST') {
    if (str.length >= 6) {
      return `${str.slice(0, 2)}•••••••••${str.slice(-4)}`.toUpperCase();
    }
    return '••••';
  }

  if (str.length > 4) {
    return `•••• ${str.slice(-4)}`;
  }

  return '••••';
}

/**
 * Masks bank account number to protect sensitive financial data.
 * E.g. "123456789012" -> "•••• •••• 9012"
 *
 * @param {string} accountNumber
 * @returns {string|null}
 */
function maskBankAccountNumber(accountNumber) {
  if (!accountNumber) return null;
  const digits = String(accountNumber).trim().replace(/[^0-9]/g, '');
  if (digits.length >= 4) {
    const last4 = digits.slice(-4);
    return `•••• •••• ${last4}`;
  }
  return '••••';
}

module.exports = {
  maskDocumentNumber,
  maskBankAccountNumber,
};
