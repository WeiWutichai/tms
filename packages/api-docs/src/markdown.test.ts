import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown ภาพ (P1-ST6-T01)', () => {
  it('![alt](path) → <img> เฉพาะ path สัมพัทธ์ · escape alt/src', () => {
    expect(renderMarkdown('![หน้า "บิล"](images/a.png)')).toBe(
      '<p><img src="images/a.png" alt="หน้า &quot;บิล&quot;" loading="lazy"></p>',
    );
    expect(renderMarkdown('![x](javascript:alert(1))')).not.toContain('<img');
    expect(renderMarkdown('![x](https://e.example/a.png)')).not.toContain('<img');
  });
});
