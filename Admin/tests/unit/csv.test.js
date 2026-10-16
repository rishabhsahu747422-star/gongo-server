'use strict';

const { sanitizeCsvCell, generateCsv, FORMULA_INJECTION_PREFIXES } = require('../../src/utils/csv');

describe('Unit: CSV Utility & Formula Injection Defense', () => {
  describe('1. sanitizeCsvCell', () => {
    it('returns empty string for null and undefined', () => {
      expect(sanitizeCsvCell(null)).toBe('');
      expect(sanitizeCsvCell(undefined)).toBe('');
    });

    it('formats boolean values safely', () => {
      expect(sanitizeCsvCell(true)).toBe('true');
      expect(sanitizeCsvCell(false)).toBe('false');
    });

    it('formats Date values to ISO strings', () => {
      const d = new Date('2026-09-01T12:00:00.000Z');
      expect(sanitizeCsvCell(d)).toBe('2026-09-01T12:00:00.000Z');
    });

    it('formats finite numbers as standard strings without altering signs', () => {
      expect(sanitizeCsvCell(123)).toBe('123');
      expect(sanitizeCsvCell(-45.67)).toBe('-45.67');
      expect(sanitizeCsvCell(0)).toBe('0');
      expect(sanitizeCsvCell(Infinity)).toBe('');
      expect(sanitizeCsvCell(NaN)).toBe('');
    });

    it('escapes commas, quotes, and newlines per RFC 4180', () => {
      expect(sanitizeCsvCell('Hello, World')).toBe('"Hello, World"');
      expect(sanitizeCsvCell('He said "Hello"')).toBe('"He said ""Hello"""');
      expect(sanitizeCsvCell('Line1\nLine2')).toBe('"Line1\nLine2"');
      expect(sanitizeCsvCell('Line1\r\nLine2')).toBe('"Line1\r\nLine2"');
    });

    it('defends against spreadsheet formula injection (=, +, -, @, \\t, \\r)', () => {
      FORMULA_INJECTION_PREFIXES.forEach((char) => {
        const payload = `${char}cmd|' /C calc'!A0`;
        const result = sanitizeCsvCell(payload);
        expect(result.startsWith(`'${char}`) || result.startsWith(`"'${char}`)).toBe(true);
      });

      // Valid numeric literals should NOT be prefixed with a single quote
      expect(sanitizeCsvCell('-500')).toBe('-500');
      expect(sanitizeCsvCell('+12.34')).toBe('+12.34');
      // But formula strings with operators must be prefixed
      expect(sanitizeCsvCell('=1+1')).toBe("'=1+1");
      expect(sanitizeCsvCell('@SUM(A1:A10)')).toBe("'@SUM(A1:A10)");
    });

    it('serializes objects safely to JSON string and quotes if needed', () => {
      const obj = { city: 'Mumbai', code: 400001 };
      const result = sanitizeCsvCell(obj);
      expect(result).toBe('"{""city"":""Mumbai"",""code"":400001}"');
    });
  });

  describe('2. generateCsv', () => {
    it('returns empty string if columns array is missing or empty', () => {
      expect(generateCsv([], [])).toBe('');
      expect(generateCsv([{ a: 1 }], null)).toBe('');
    });

    it('generates headers and row content with CRLF line endings', () => {
      const cols = [
        { key: 'id', label: 'Booking ID' },
        { key: 'customer', label: 'Customer Name' },
        { key: 'amount', label: 'Total Amount' },
      ];
      const rows = [
        { id: 'b1', customer: 'Alice Smith', amount: 1500 },
        { id: 'b2', customer: 'Bob, Jr.', amount: 2500 },
      ];

      const csv = generateCsv(rows, cols);
      const lines = csv.split('\r\n');

      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('Booking ID,Customer Name,Total Amount');
      expect(lines[1]).toBe('b1,Alice Smith,1500');
      expect(lines[2]).toBe('b2,"Bob, Jr.",2500');
    });
  });
});
