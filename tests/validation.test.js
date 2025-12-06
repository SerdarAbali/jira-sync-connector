import { validateRequired, validateString, validateUrl } from '../src/utils/validation.js';

describe('Validation Utils', () => {
  describe('validateRequired', () => {
    test('should pass when all fields are present', () => {
      const payload = { name: 'Test', id: 123 };
      expect(() => validateRequired(payload, ['name', 'id'])).not.toThrow();
    });

    test('should throw when a field is missing', () => {
      const payload = { name: 'Test' };
      expect(() => validateRequired(payload, ['name', 'id'])).toThrow('Missing required field: id');
    });
  });

  describe('validateUrl', () => {
    test('should pass for valid https url', () => {
      expect(validateUrl('https://example.com', 'url')).toBe('https://example.com');
    });

    test('should throw for invalid url', () => {
      expect(() => validateUrl('not-a-url', 'url')).toThrow('url is not a valid URL');
    });
  });
});
