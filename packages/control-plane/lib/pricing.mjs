// Internal cost model. None of these inputs are part of the customer response.
// Money uses USD nanodollars to avoid losing fractions on minute/heartbeat rates.
const SCALE = 1_000_000_000n;
export const MONTHLY_COSTS = [
  'persistentStorage', 'backups', 'controlService', 'database', 'authenticationEmail',
  'gateway', 'monitoringLogs', 'supportOperations', 'idleStorageReserve',
];
export const HOURLY_COSTS = ['compute', 'ipv4', 'bandwidth', 'provisioningRecovery', 'migrationRestore'];
function money(value) {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,9})?$/.test(text)) throw Error('Cost must be a non-negative decimal with at most nine decimal places');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(9, '0'));
}
function divideUp(n, d) { return (n + d - 1n) / d; }
function decimal(value) { return `${value / SCALE}.${String(value % SCALE).padStart(9, '0')}`; }
export function blendedRate(model) {
  if (!Number.isSafeInteger(model.expectedBillableMinutes) || model.expectedBillableMinutes < 1) throw Error('Expected billable minutes are required');
  const read = (keys, values) => keys.reduce((total, key) => {
    if (values?.[key] === undefined) throw Error(`Missing cost category: ${key}`);
    return total + money(values[key]);
  }, 0n);
  const monthly = read(MONTHLY_COSTS, model.monthly);
  const hourly = read(HOURLY_COSTS, model.hourly);
  const minutes = BigInt(model.expectedBillableMinutes);
  const feeBps = model.paymentFeeBps ?? 0;
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps >= 7500) throw Error('Invalid processing fee');
  const fixedFees = money(model.monthlyPaymentFixedFees ?? '0');
  // Exact common denominator, rounding only the published rate upward.
  const costNumerator = hourly * minutes + (monthly + fixedFees) * 60n;
  const price = divideUp(costNumerator * 10000n, minutes * 60n * BigInt(7500 - feeBps));
  return { currency: 'USD', pricePerMinute: decimal(price), marginBps: 2500,
    costPerMinute: decimal(divideUp(costNumerator, minutes * 60n)),
    expectedBillableMinutes: model.expectedBillableMinutes };
}
export function cumulativeCharge(pricePerMinute, elapsedMilliseconds) {
  if (!Number.isSafeInteger(elapsedMilliseconds) || elapsedMilliseconds < 0) throw Error('Invalid duration');
  return decimal(money(pricePerMinute) * BigInt(elapsedMilliseconds) / 60000n);
}
