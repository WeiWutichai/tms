import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { PrivateLinkLayout } from './privacyMeta';

/** ST9-T13 R2 (L-01) — หน้าลิงก์ทุกหน้า: meta robots noindex + referrer no-referrer · ออกจากหน้าแล้วถอด meta */
describe('PrivateLinkLayout', () => {
  it('ใส่ meta noindex/no-referrer ระหว่างอยู่ในหน้าลิงก์ และถอดออกเมื่อออก', () => {
    const view = render(
      <MemoryRouter initialEntries={['/link/offer/ml1.x']}>
        <Routes>
          <Route element={<PrivateLinkLayout />}>
            <Route path="/link/offer/:token" element={<p>offer</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(view.getByText('offer')).toBeTruthy();
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'noindex, nofollow',
    );
    expect(document.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe(
      'no-referrer',
    );
    view.unmount();
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
  });
});
