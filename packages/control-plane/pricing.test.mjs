import test from 'node:test';
import assert from 'node:assert/strict';
import {blendedRate, cumulativeCharge, MONTHLY_COSTS, HOURLY_COSTS} from './lib/pricing.mjs';
const model = () => ({expectedBillableMinutes: 600, monthly: Object.fromEntries(MONTHLY_COSTS.map(k => [k, '0'])), hourly: Object.fromEntries(HOURLY_COSTS.map(k => [k, '0']))});
test('25 percent gross margin includes every cost category and payment percentage', () => {
  const input = model(); input.hourly.compute = '0.45'; input.monthly.persistentStorage = '4.5';
  assert.equal(blendedRate(input).pricePerMinute, '0.020000000');
  input.paymentFeeBps = 2500;
  assert.equal(blendedRate(input).pricePerMinute, '0.030000000');
  for (const category of MONTHLY_COSTS) {const incomplete = model(); delete incomplete.monthly[category]; assert.throws(() => blendedRate(incomplete), /Missing cost/);}
  for (const category of HOURLY_COSTS) {const incomplete = model(); delete incomplete.hourly[category]; assert.throws(() => blendedRate(incomplete), /Missing cost/);}
});
test('idle storage is amortized over paid usage, not silently dropped', () => {
  const input = model(); input.monthly.idleStorageReserve = '9';
  assert.equal(blendedRate(input).pricePerMinute, '0.020000000');
  input.expectedBillableMinutes = 300;
  assert.equal(blendedRate(input).pricePerMinute, '0.040000000');
  input.expectedBillableMinutes = 0; assert.throws(() => blendedRate(input));
});
test('tiny rates survive cumulative metering without per-heartbeat rounding drift', () => {
  assert.equal(cumulativeCharge('0.001314', 60 * 60 * 1000), '0.078840000');
  assert.equal(cumulativeCharge('0.001314', 0), '0.000000000');
  assert.throws(() => cumulativeCharge('0.001314', -1));
  const input = model(); input.hourly.compute = 'NaN'; assert.throws(() => blendedRate(input));
});
