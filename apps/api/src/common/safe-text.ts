/**
 * ชื่อที่ tenant กรอกเองลงในอีเมล — ตัด URL/โดเมนออก (client อีเมลทำลิงก์อัตโนมัติ → ฟิชชิงด้วยโดเมนเรา; review T07 #2)
 */
export function safeName(s: string, max = 120): string {
  return s
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, '')
    .replace(/\bwww\.\S*/gi, '')
    .replace(
      /\b[\w-]+(\.[\w-]+)*\.(com|net|org|co|io|me|th|xyz|info|app|link|ly|ru|cn|top|site|online|dev|biz|us|uk|asia|shop|click)\b\S*/gi,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
