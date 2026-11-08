import { financialYear, istDay } from './sequences';

describe('document numbering dates', () => {
  it('uses the Indian calendar day', () => {
    expect(istDay(new Date('2026-11-08T18:29:00Z'))).toBe('20261108');
    expect(istDay(new Date('2026-11-08T18:31:00Z'))).toBe('20261109'); // past midnight IST
  });

  it('uses the April–March financial year', () => {
    expect(financialYear(new Date('2026-11-08T10:00:00Z'))).toBe('2627');
    expect(financialYear(new Date('2027-03-31T18:00:00Z'))).toBe('2627'); // 31 Mar 23:30 IST
    expect(financialYear(new Date('2027-03-31T18:31:00Z'))).toBe('2728'); // 1 Apr 00:01 IST
    expect(financialYear(new Date('2099-06-01T00:00:00Z'))).toBe('9900');
  });
});
