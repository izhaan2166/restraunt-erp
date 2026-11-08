import { AppError } from '../../common/errors/app-error';
import { normaliseVariants } from './products.service';

describe('normaliseVariants', () => {
  it('makes the first variant the default when none is chosen', () => {
    const out = normaliseVariants([
      { name: ' Half ', price: '180.00' },
      { name: 'Full', price: '320.00' },
    ]);
    expect(out.map((v) => [v.name, v.isDefault, v.sortOrder])).toEqual([
      ['Half', true, 0],
      ['Full', false, 1],
    ]);
  });

  it('keeps an explicit default', () => {
    const out = normaliseVariants([
      { name: 'Half', price: '180.00' },
      { name: 'Full', price: '320.00', isDefault: true },
    ]);
    expect(out.map((v) => v.isDefault)).toEqual([false, true]);
  });

  it('rejects two defaults and duplicate names (case-insensitive)', () => {
    expect(() => normaliseVariants([{ name: 'A', price: '1', isDefault: true }, { name: 'B', price: '1', isDefault: true }])).toThrow(AppError);
    expect(() => normaliseVariants([{ name: 'Full', price: '1' }, { name: 'full ', price: '2' }])).toThrow(/Duplicate variant/);
  });
});
