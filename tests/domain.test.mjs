import test from 'node:test';
import assert from 'node:assert/strict';
import { ratingDistribution } from '../public/domain.js';

const record = (rating, deletedAt = null) => ({ rating, deletedAt });

test('rating distribution groups rated active records into stable score ranges', () => {
  const result = ratingDistribution([
    record(0), record(2), record(2.5), record(4), record(6), record(7.5),
    record(8), record(8.5), record(9), record(10), record(null), record(9, '2026-01-01')
  ]);
  assert.deepEqual(result.map(bucket => bucket.label), ['0–2', '2–4', '4–6', '6–8', '8–9', '9–10']);
  assert.deepEqual(result.map(bucket => bucket.count), [1, 2, 1, 2, 2, 2]);
});
