import { describe, expect, it } from 'vitest';
import { elapsed, indiaDate, monthOf, presetRange, qty, rupees, shortDate, skuFrom, stockQty, titleCase } from './format';

describe('rupees', () => {
  it('groups digits the Indian way and always shows paise', () => {
    expect(rupees('0')).toBe('₹0.00');
    expect(rupees('588')).toBe('₹588.00');
    expect(rupees('1234.5')).toBe('₹1,234.50');
    expect(rupees('123456.78')).toBe('₹1,23,456.78');
    expect(rupees('12345678.9')).toBe('₹1,23,45,678.90');
  });
  it('keeps the sign and never rounds (the server is the only place money is calculated)', () => {
    expect(rupees('-0.50')).toBe('-₹0.50');
    expect(rupees('-0.00')).toBe('₹0.00');
    expect(rupees('10.999')).toBe('₹10.99');
  });
  it('shows a dash for a missing amount and leaves odd input untouched', () => {
    expect(rupees(null)).toBe('—');
    expect(rupees('')).toBe('—');
    expect(rupees('abc')).toBe('abc');
  });
});

describe('other display helpers', () => {
  it('trims quantity zeros', () => {
    expect(qty('2.000')).toBe('2');
    expect(qty('1.500')).toBe('1.5');
    expect(qty(3)).toBe('3');
  });
  it('formats waiting time', () => {
    expect(elapsed(0)).toBe('0:00');
    expect(elapsed(75)).toBe('1:15');
    expect(elapsed(3725)).toBe('1:02:05');
    expect(elapsed(-5)).toBe('0:00');
  });
  it('turns API enums into words', () => {
    expect(titleCase('DINE_IN')).toBe('Dine In');
    expect(titleCase('TAKEAWAY')).toBe('Takeaway');
  });
});

describe('skuFrom', () => {
  it('makes a dish code from the name', () => {
    expect(skuFrom('Mango Shake (Large)')).toBe('MANGO-SHAKE-LARGE');
    expect(skuFrom('  Crème brûlée ')).toBe('CREME-BRULEE');
  });
  it('gives nothing for a name without latin letters or digits', () => {
    expect(skuFrom('चाय')).toBe('');
  });
});

describe('stockQty', () => {
  it('shows big gram and millilitre amounts in kg and litres', () => {
    expect(stockQty('4800', 'g')).toBe('4.8 kg');
    expect(stockQty('250', 'ml')).toBe('250 ml');
    expect(stockQty('-1500', 'ml')).toBe('-1.5 l');
    expect(stockQty('12', 'pc')).toBe('12 pc');
  });
});

describe('business dates', () => {
  it('uses the India date, even late at night UTC', () => {
    expect(indiaDate(new Date('2026-11-09T20:00:00Z'))).toBe('2026-11-10');
  });
  it('gives the whole month, including February in a leap year', () => {
    expect(monthOf('2028-02-14')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthOf('2026-11-09')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
  });
  it('shows a stored date without shifting the day', () => {
    expect(shortDate('2026-11-09T00:00:00.000Z')).toBe('9 Nov 2026');
  });
});

describe('presetRange', () => {
  it('gives report periods in India dates', () => {
    // 9 Nov 2026 is a Monday.
    expect(presetRange('today', '2026-11-09')).toEqual({ from: '2026-11-09', to: '2026-11-09' });
    expect(presetRange('yesterday', '2026-11-09')).toEqual({ from: '2026-11-08', to: '2026-11-08' });
    expect(presetRange('this_week', '2026-11-09')).toEqual({ from: '2026-11-09', to: '2026-11-09' });
    expect(presetRange('this_week', '2026-11-15')).toEqual({ from: '2026-11-09', to: '2026-11-15' });
    expect(presetRange('this_month', '2026-11-09')).toEqual({ from: '2026-11-01', to: '2026-11-09' });
    expect(presetRange('last_month', '2026-03-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(presetRange('last_month', '2026-01-05')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });
});
