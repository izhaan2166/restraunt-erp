import { describe, expect, it } from 'vitest';
import { elapsed, qty, rupees, skuFrom, titleCase } from './format';

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
