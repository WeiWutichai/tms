import { icons, type LucideProps } from 'lucide-react';

/** ไอคอนตามชื่อ kebab-case ของต้นแบบ (`<lu-i n="truck" s="16">`) */
export function Icon({
  n,
  s = 16,
  ...rest
}: { n: string; s?: number } & Omit<LucideProps, 'size'>) {
  const name = n
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('') as keyof typeof icons;
  const C = icons[name] ?? icons.Circle;
  return <C size={s} strokeWidth={2} aria-hidden="true" {...rest} />;
}
