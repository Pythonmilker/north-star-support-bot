/**
 * A recommendation that names a category but gives the customer no way to reach it is a dead end —
 * a real user hit exactly this ("you never gave me a link"). When the host configures a shop URL, the
 * recommendation (and the out-of-catalogue reply) carries a clickable button, the same affordance the
 * returns flow uses. Without a shop URL, behaviour is unchanged.
 */

import { describe, it, expect } from 'vitest';
import { render, renderNoCategoryMatch } from '@/answer/render';
import { PRODUCT_CATEGORIES } from '@/data/store';

describe('recommendations link to the shop when a shop URL is configured', () => {
  it('a category recommendation carries a "Shop <category>" button', () => {
    const a = render('product_recommendation', { interest: 'footwear' }, { shopUrl: 'https://shop.example/c/footwear' });
    expect(a.link?.href).toBe('https://shop.example/c/footwear');
    expect(a.link?.label).toBe(`Shop ${PRODUCT_CATEGORIES.footwear}`);
  });

  it('the out-of-catalogue reply carries a "Browse all gear" button', () => {
    const a = renderNoCategoryMatch({ shopUrl: 'https://shop.example' });
    expect(a.link?.href).toBe('https://shop.example');
    expect(a.link?.label.toLowerCase()).toContain('browse');
  });

  it('no shop URL → no link (the deterministic default is unchanged)', () => {
    expect(render('product_recommendation', { interest: 'footwear' }).link).toBeUndefined();
    expect(renderNoCategoryMatch({}).link).toBeUndefined();
  });
});
