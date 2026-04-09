import { describe, it, expect } from 'vitest';
import { buildContextHash, buildReconciliationKey } from '../../src/services/reconciliation.service.js';

describe('ReconciliationService helpers', () => {
  describe('buildContextHash', () => {
    it('should return a SHA-256 hex string', () => {
      const hash = buildContextHash('test context');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should return the same hash for the same input', () => {
      const h1 = buildContextHash('identical input');
      const h2 = buildContextHash('identical input');
      expect(h1).toBe(h2);
    });

    it('should return different hashes for different inputs', () => {
      const h1 = buildContextHash('input A');
      const h2 = buildContextHash('input B');
      expect(h1).not.toBe(h2);
    });

    it('should handle empty string', () => {
      const hash = buildContextHash('');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should handle unicode content', () => {
      const hash = buildContextHash('日本語テスト 🚀');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('buildReconciliationKey', () => {
    it('should build a key with meetingId, title, and contextHash', () => {
      const key = buildReconciliationKey('meeting-1', 'Fix auth bug', 'some context');

      expect(key.meetingId).toBe('meeting-1');
      expect(key.title).toBe('Fix auth bug');
      expect(key.contextHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should produce matching hashes for same context', () => {
      const k1 = buildReconciliationKey('m1', 'title', 'context');
      const k2 = buildReconciliationKey('m2', 'other', 'context');

      expect(k1.contextHash).toBe(k2.contextHash);
    });

    it('should produce different hashes for different context', () => {
      const k1 = buildReconciliationKey('m1', 'title', 'context A');
      const k2 = buildReconciliationKey('m1', 'title', 'context B');

      expect(k1.contextHash).not.toBe(k2.contextHash);
    });
  });
});
