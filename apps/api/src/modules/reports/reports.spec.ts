import { csvCell, formatIndian, toCsv } from './export';
import { money, pct, qty } from './report';
import { bucketKeys } from './reports.service';
import { presetPeriod } from './scope';
import { Prisma } from '@prisma/client';

describe('report helpers', () => {
  it('formats rupees with Indian digit grouping', () => {
    expect(formatIndian('0.00')).toBe('0.00');
    expect(formatIndian('999.50')).toBe('999.50');
    expect(formatIndian('1234.00')).toBe('1,234.00');
    expect(formatIndian('123456.78')).toBe('1,23,456.78');
    expect(formatIndian('-12345678.00')).toBe('-1,23,45,678.00');
  });

  it('never prints minus zero and rounds half up', () => {
    expect(money(new Prisma.Decimal('-0'))).toBe('0.00');
    expect(money('2.345')).toBe('2.35');
    expect(qty('1.5000')).toBe('1.5');
    expect(pct(new Prisma.Decimal(1), new Prisma.Decimal(0))).toBeNull();
    expect(pct(new Prisma.Decimal(1), new Prisma.Decimal(3))).toBe('33.33');
  });

  it('quotes CSV cells and defuses formulas but keeps negative numbers', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-12.50')).toBe('-12.50');
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell(null)).toBe('');
    const csv = toCsv({ key: 'k', title: 'T', from: '2026-11-01', to: '2026-11-02', branches: [{ id: '1', name: 'Main' }], summary: [{ key: 'a', label: 'A', value: '1.00' }], tables: [{ key: 't', title: 'Rows', columns: [{ key: 'x', label: 'X' }], rows: [{ x: 'y' }] }] });
    expect(csv.startsWith('﻿T\r\nPeriod,2026-11-01,2026-11-02\r\nBranches,Main')).toBe(true);
    expect(csv).toContain('Rows\r\nX\r\ny\r\n');
  });

  it('lists period starts for daily, weekly, monthly and annual rows', () => {
    expect(bucketKeys('2026-11-06', '2026-11-08', 'day')).toEqual(['2026-11-06', '2026-11-07', '2026-11-08']);
    // 2026-11-08 is a Sunday; its week starts Monday 2026-11-02.
    expect(bucketKeys('2026-11-08', '2026-11-10', 'week')).toEqual(['2026-11-02', '2026-11-09']);
    expect(bucketKeys('2026-01-15', '2026-03-01', 'month')).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(bucketKeys('2024-06-01', '2026-02-01', 'year')).toEqual(['2024-01-01', '2025-01-01', '2026-01-01']);
  });

  it('works out the dashboard ranges in India dates', () => {
    const sunday = new Date('2026-11-08T00:00:00Z');
    expect(presetPeriod('today', undefined, undefined, sunday)).toEqual(expect.objectContaining({ from: '2026-11-08', to: '2026-11-08' }));
    expect(presetPeriod('yesterday', undefined, undefined, sunday)).toEqual(expect.objectContaining({ from: '2026-11-07', to: '2026-11-07' }));
    expect(presetPeriod('this_week', undefined, undefined, sunday)).toEqual(expect.objectContaining({ from: '2026-11-02', to: '2026-11-08' }));
    expect(presetPeriod('this_month', undefined, undefined, sunday)).toEqual(expect.objectContaining({ from: '2026-11-01', to: '2026-11-08' }));
    const p = presetPeriod('today', undefined, undefined, sunday);
    // India midnight is 18:30 UTC the day before.
    expect(p.gte.toISOString()).toBe('2026-11-07T18:30:00.000Z');
    expect(p.lt.toISOString()).toBe('2026-11-08T18:30:00.000Z');
    expect(() => presetPeriod('custom', undefined, undefined, sunday)).toThrow();
  });
});
